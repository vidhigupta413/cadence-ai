/**
 * Cadence AI — Camera Agent
 *
 * Owns the webcam stream and all recording / gesture-detection logic.
 * Runs entirely client-side. Never sends raw video off-device.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  CameraAgent                                                     │
 * │                                                                  │
 * │  requestStream()  →  getUserMedia → attaches to <video> element  │
 * │  stopStream()     →  stops all tracks, releases camera           │
 * │                                                                  │
 * │  startRecording(segmentId) →  MediaRecorder.start()              │
 * │  stopRecording()           →  MediaRecorder.stop()               │
 * │                             →  emits RECORDING_READY { blob }    │
 * │                                                                  │
 * │  onPoseLandmarks(landmarks) → called each MediaPipe frame        │
 * │     • computes wrist position relative to Target Zone            │
 * │     • tracks dwell time; after 2 000 ms emits GESTURE_CUT        │
 * │     • emits STATE_UPDATED { targetZoneDwellMs } for the UI ring  │
 * │                                                                  │
 * │  Listens for STATE_UPDATED → starts/stops MediaRecorder when     │
 * │  Director Agent transitions mode to RECORDING / REVIEWING        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * MediaPipe integration note:
 *   This agent exposes onPoseLandmarks() as a public callback.
 *   The CameraFeed component wires the MediaPipe Pose results into it once
 *   MediaPipe is set up. This keeps the agent framework-agnostic and
 *   testable without a real camera.
 *
 * Target Zone:
 *   Defined in normalised [0,1] coordinates (matching MediaPipe output).
 *   Default: top-right 15 % × 20 % of the frame.
 *   x ∈ [0.85, 1.0],  y ∈ [0.0, 0.20]
 */

import { eventBus } from "@/lib/eventBus";
import type { AppMode, PoseLandmark } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Dwell duration (ms) required to confirm a cut gesture. */
const GESTURE_DWELL_MS = 2_000;

/** Minimum MediaPipe visibility score for a wrist landmark to be considered. */
const MIN_VISIBILITY = 0.75;

/**
 * Target Zone in normalised coords [0,1].
 * Top-right corner of the frame.
 */
const TARGET_ZONE = {
  xMin: 0.80,
  xMax: 1.00,
  yMin: 0.00,
  yMax: 0.22,
} as const;

/** MediaPipe Pose landmark indices for the two wrists. */
const WRIST_INDICES = [15, 16] as const; // 15 = LEFT_WRIST, 16 = RIGHT_WRIST

/** Preferred webcam constraints — 720p, 30 fps, rear-facing disabled. */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
  facingMode: "user",
};

// ─────────────────────────────────────────────────────────────────────────────
// CameraAgent
// ─────────────────────────────────────────────────────────────────────────────

export class CameraAgent {
  // ── Stream ────────────────────────────────────────────────────────────────
  private _stream: MediaStream | null = null;

  /**
   * Callback set by CameraFeed to attach the live stream to the <video> element.
   * The agent owns the stream; the component owns the DOM node.
   */
  private _onStreamReady: ((stream: MediaStream) => void) | null = null;

  // ── MediaRecorder ─────────────────────────────────────────────────────────
  private _recorder: MediaRecorder | null = null;
  private _chunks: BlobPart[] = [];
  private _activeSegmentId: string | null = null;

  // ── Gesture dwell tracking ─────────────────────────────────────────────────
  /** Timestamp (ms, Date.now()) when a wrist first entered the Target Zone. */
  private _dwellStart: number | null = null;
  /** Last emitted dwell progress value — avoids emitting identical values. */
  private _lastDwellMs = 0;

  // ── Mode mirror ───────────────────────────────────────────────────────────
  /** Mirrors the Director Agent's current mode so we know when to record. */
  private _currentMode: AppMode = "IDLE";

  // ── Event bus handler refs (stored for clean removal on unmount) ──────────
  private _handleStateUpdated = ({ mode }: { mode?: AppMode }) => {
    if (!mode || mode === this._currentMode) return;
    const prev = this._currentMode;
    this._currentMode = mode;
    this._onModeChange(prev, mode);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Registers event bus listeners.
   * Called once by useCameraAgent on mount.
   */
  mount(): void {
    eventBus.on("STATE_UPDATED", this._handleStateUpdated);
  }

  /**
   * Stops all tracks, cancels any active recording, removes listeners.
   * Called once by useCameraAgent on unmount.
   */
  unmount(): void {
    eventBus.off("STATE_UPDATED", this._handleStateUpdated);
    this._stopRecorderSilently();
    this.stopStream();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — stream management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Registers the callback that CameraFeed uses to attach the stream to
   * its <video> ref.  Must be called before requestStream().
   */
  setStreamReadyCallback(cb: (stream: MediaStream) => void): void {
    this._onStreamReady = cb;
    // If the stream was already acquired before the component mounted
    // (race condition), deliver it immediately.
    if (this._stream) cb(this._stream);
  }

  /**
   * Requests webcam access via getUserMedia.
   * On success: stores the stream, invokes _onStreamReady, emits
   *   STATE_UPDATED { cameraReady: true }.
   * On failure: emits STATE_UPDATED { cameraReady: false } — caller can
   *   inspect the thrown error for permission-denial messaging.
   *
   * @throws {DOMException} NotAllowedError if the user denies permission.
   * @throws {DOMException} NotFoundError if no camera device is found.
   */
  async requestStream(): Promise<void> {
    // Stop any previous stream before requesting a new one.
    this.stopStream();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: VIDEO_CONSTRAINTS,
      audio: false, // audio captured separately via AudioAgent
    });

    this._stream = stream;
    this._onStreamReady?.(stream);

    eventBus.emit("STATE_UPDATED", { cameraReady: true });
  }

  /**
   * Stops all tracks on the active stream and releases the camera hardware.
   * Safe to call even if no stream is active.
   */
  stopStream(): void {
    if (!this._stream) return;
    this._stream.getTracks().forEach((t) => t.stop());
    this._stream = null;
    eventBus.emit("STATE_UPDATED", { cameraReady: false, poseActive: false });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — recording
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Starts a new MediaRecorder session for the given segment.
   * The best supported MIME type is auto-selected (webm/vp9 preferred).
   * No-op if already recording or no stream is available.
   */
  startRecording(segmentId: string): void {
    if (!this._stream || this._recorder?.state === "recording") return;

    this._chunks = [];
    this._activeSegmentId = segmentId;

    const mimeType = this._bestMimeType();
    const recorder = new MediaRecorder(this._stream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(this._chunks, { type: mimeType });
      this._chunks = [];

      if (this._activeSegmentId) {
        eventBus.emit("RECORDING_READY", {
          blob,
          segmentId: this._activeSegmentId,
        });
      }
      this._activeSegmentId = null;
    };

    // Request a data chunk every second so we can show incremental progress
    // in the future. Does not affect the final blob.
    recorder.start(1_000);
    this._recorder = recorder;
  }

  /**
   * Stops the active MediaRecorder. The onstop handler fires asynchronously
   * and emits RECORDING_READY once the blob is assembled.
   * No-op if not currently recording.
   */
  stopRecording(): void {
    if (this._recorder?.state === "recording") {
      this._recorder.stop();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — gesture detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Entry point for MediaPipe Pose results.
   * Called by CameraFeed each frame after pose estimation completes.
   *
   * Checks whether either wrist is inside the Target Zone and tracks dwell
   * time. Fires GESTURE_CUT once 2 000 ms of continuous dwell is reached,
   * then resets so the same gesture can be used for the next cut.
   *
   * Also emits STATE_UPDATED { targetZoneDwellMs } so the UI countdown ring
   * can animate in real-time. A value of 0 means no wrist is in the zone.
   *
   * @param landmarks - The 33-landmark array from MediaPipe, normalised [0,1].
   */
  onPoseLandmarks(landmarks: PoseLandmark[]): void {
    const now = Date.now();

    // Check either wrist.
    const wristInZone = WRIST_INDICES.some((idx) => {
      const lm = landmarks[idx];
      if (!lm || lm.visibility < MIN_VISIBILITY) return false;
      return (
        lm.x >= TARGET_ZONE.xMin &&
        lm.x <= TARGET_ZONE.xMax &&
        lm.y >= TARGET_ZONE.yMin &&
        lm.y <= TARGET_ZONE.yMax
      );
    });

    if (wristInZone) {
      if (this._dwellStart === null) {
        // First frame in the zone — start the timer.
        this._dwellStart = now;
      }

      const elapsed = now - this._dwellStart;
      const clamped = Math.min(elapsed, GESTURE_DWELL_MS);

      // Only emit if the value meaningfully changed (> 16 ms — one frame).
      if (clamped - this._lastDwellMs >= 16) {
        this._lastDwellMs = clamped;
        eventBus.emit("STATE_UPDATED", { targetZoneDwellMs: clamped });
      }

      if (elapsed >= GESTURE_DWELL_MS) {
        // Dwell threshold reached — fire the cut intent.
        const triggeringLandmark = WRIST_INDICES.map((i) => landmarks[i]).find(
          (lm) =>
            lm &&
            lm.visibility >= MIN_VISIBILITY &&
            lm.x >= TARGET_ZONE.xMin &&
            lm.y <= TARGET_ZONE.yMax
        );

        eventBus.emit("GESTURE_CUT", {
          confidence: triggeringLandmark?.visibility ?? 1,
        });

        // Reset dwell so the gesture can be used again for the next cut.
        this._dwellStart = null;
        this._lastDwellMs = 0;
        eventBus.emit("STATE_UPDATED", { targetZoneDwellMs: 0 });
      }
    } else {
      // Wrist left the zone — reset.
      if (this._dwellStart !== null) {
        this._dwellStart = null;
        this._lastDwellMs = 0;
        eventBus.emit("STATE_UPDATED", { targetZoneDwellMs: 0 });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reacts to Director Agent mode transitions.
   * RECORDING / RETAKE → start recording on the active segment id from state.
   * REVIEWING / IDLE   → stop recording.
   */
  private _onModeChange(prev: AppMode, next: AppMode): void {
    void prev; // acknowledged — reserved for future transitions

    if (next === "RECORDING" || next === "RETAKE") {
      // The Director Agent already created the segment and placed its id in state.
      // We cannot read the store here (no React dependency), so we listen for the
      // Director to call startRecording() via the public API instead.
      // See CameraFeed → useCameraAgent integration notes.
      return;
    }

    if (next === "REVIEWING" || next === "IDLE") {
      this.stopRecording();
    }
  }

  /**
   * Stops the recorder without waiting for the onstop blob assembly.
   * Used during unmount when we don't need the resulting Blob.
   */
  private _stopRecorderSilently(): void {
    if (!this._recorder) return;
    this._recorder.onstop = null;
    if (this._recorder.state !== "inactive") {
      this._recorder.stop();
    }
    this._recorder = null;
    this._chunks = [];
    this._activeSegmentId = null;
  }

  /**
   * Returns the most capable MIME type supported by the current browser
   * for MediaRecorder output, in preference order.
   */
  private _bestMimeType(): string {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    return (
      candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────────

  get isStreaming(): boolean {
    return this._stream !== null;
  }

  get isRecording(): boolean {
    return this._recorder?.state === "recording";
  }

  /** Expose the Target Zone config so CameraFeed can draw the overlay. */
  static get targetZone() {
    return TARGET_ZONE;
  }
}
