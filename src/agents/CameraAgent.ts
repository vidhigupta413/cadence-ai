/**
 * Cadence AI — Camera Agent
 *
 * Owns the webcam stream, MediaPipe Pose, MediaRecorder, and gesture detection.
 * Runs entirely client-side. Never sends raw video off-device.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  CameraAgent                                                     │
 * │                                                                  │
 * │  requestStream()    →  getUserMedia → attaches to <video>        │
 * │  stopStream()       →  stops all tracks, releases camera         │
 * │                                                                  │
 * │  initPose(video)    →  creates Pose instance, wires onResults,   │
 * │                        starts the rAF send loop                  │
 * │  stopPose()         →  cancels rAF, closes Pose instance         │
 * │                                                                  │
 * │  startRecording(id) →  MediaRecorder.start()                     │
 * │  stopRecording()    →  MediaRecorder.stop()                      │
 * │                     →  emits RECORDING_READY { blob }            │
 * │                                                                  │
 * │  setCanvasDrawCallback(fn) → called each frame with landmarks    │
 * │                              so CameraFeed can draw on canvas    │
 * │                                                                  │
 * │  rAF loop (per frame):                                           │
 * │    pose.send({ image: videoEl })                                 │
 * │    → onResults → onPoseLandmarks() → GESTURE_CUT / POSE_UPDATE  │
 * │                → canvasDrawCallback(landmarks)                   │
 * │                                                                  │
 * │  Listens for STATE_UPDATED → auto-stops recording on mode exit   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * WASM assets:
 *   locateFile points to /mediapipe/pose/ (served from public/).
 *   Assets were copied there at build time by the setup script.
 */

// Type-only imports are erased at compile time — safe to import statically.
import type { Results, NormalizedLandmarkList, Pose as PoseType } from "@mediapipe/pose";
import { eventBus } from "@/lib/eventBus";
import type { AppMode, PoseLandmark } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Dwell duration (ms) required to confirm the Xbox Gesture cut. */
const GESTURE_DWELL_MS = 2_000;

/** Minimum MediaPipe visibility score for the wrist landmark to be trusted. */
const MIN_VISIBILITY = 0.75;

/**
 * Xbox Gesture bounding box — pixel-space, relative to the video frame.
 *
 * "x > videoWidth - 100, y < 100" as specified:
 *   The wrist must be in the rightmost 100 px column AND the top 100 px row.
 * Stored as offsets; actual threshold is computed per-frame from _videoEl.
 */
const XBOX_ZONE_RIGHT_MARGIN_PX = 100; // wrist.pixelX must exceed videoWidth - this
const XBOX_ZONE_TOP_MARGIN_PX   = 100; // wrist.pixelY must be below this

/**
 * MediaPipe Pose RIGHT_WRIST landmark index.
 * Index 16 per the MediaPipe 33-keypoint topology.
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
const RIGHT_WRIST_IDX = 16;

/**
 * Normalised Target Zone — used ONLY for the canvas HUD overlay and the
 * legacy GESTURE_CUT path. The gesture itself uses pixel-space thresholds.
 */
const TARGET_ZONE = {
  xMin: 0.80,
  xMax: 1.00,
  yMin: 0.00,
  yMax: 0.22,
} as const;

/** Preferred webcam constraints — 720p, 30 fps, front-facing. */
const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width:     { ideal: 1280 },
  height:    { ideal: 720  },
  frameRate: { ideal: 30   },
  facingMode: "user",
};

// ─────────────────────────────────────────────────────────────────────────────
// Type helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Converts a MediaPipe NormalizedLandmark to our internal PoseLandmark type. */
function toLandmark(lm: { x: number; y: number; z: number; visibility?: number }): PoseLandmark {
  return { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility ?? 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// CameraAgent
// ─────────────────────────────────────────────────────────────────────────────

export class CameraAgent {
  // ── Stream ────────────────────────────────────────────────────────────────
  private _stream: MediaStream | null = null;
  private _onStreamReady: ((stream: MediaStream) => void) | null = null;

  // ── MediaPipe Pose ────────────────────────────────────────────────────────
  private _pose:       PoseType | null = null;
  private _videoEl:    HTMLVideoElement | null = null;
  private _rafHandle:  number | null = null;
  /** True while a pose.send() call is in-flight — prevents queue pile-up. */
  private _sending = false;
  /** Called every frame with the raw NormalizedLandmarkList for canvas drawing. */
  private _canvasDrawCallback: ((landmarks: NormalizedLandmarkList) => void) | null = null;

  // ── MediaRecorder ─────────────────────────────────────────────────────────
  private _recorder:        MediaRecorder | null = null;
  private _chunks:          BlobPart[] = [];
  private _activeSegmentId: string | null = null;

  // ── Gesture dwell tracking ─────────────────────────────────────────────────
  private _dwellStart:  number | null = null;
  private _lastDwellMs: number = 0;

  // ── Mode mirror ───────────────────────────────────────────────────────────
  private _currentMode: AppMode = "IDLE";

  // ── Event bus handlers ────────────────────────────────────────────────────
  private _handleStateUpdated = ({ mode }: { mode?: AppMode }) => {
    if (!mode || mode === this._currentMode) return;
    const prev = this._currentMode;
    this._currentMode = mode;
    this._onModeChange(prev, mode);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  mount(): void {
    eventBus.on("STATE_UPDATED", this._handleStateUpdated);
  }

  unmount(): void {
    eventBus.off("STATE_UPDATED", this._handleStateUpdated);
    this.stopPose();
    this._stopRecorderSilently();
    this.stopStream();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — stream
  // ─────────────────────────────────────────────────────────────────────────

  setStreamReadyCallback(cb: (stream: MediaStream) => void): void {
    this._onStreamReady = cb;
    if (this._stream) cb(this._stream);
  }

  /**
   * Registers the per-frame canvas drawing callback.
   * CameraFeed passes a function that takes the raw landmark list and
   * calls poseRenderer.drawPose() on the canvas context.
   */
  setCanvasDrawCallback(
    cb: ((landmarks: NormalizedLandmarkList) => void) | null,
  ): void {
    this._canvasDrawCallback = cb;
  }

  async requestStream(): Promise<void> {
    this.stopStream();

    const stream = await navigator.mediaDevices.getUserMedia({
      video: VIDEO_CONSTRAINTS,
      audio: false,
    });

    this._stream = stream;
    this._onStreamReady?.(stream);
    eventBus.emit("STATE_UPDATED", { cameraReady: true });
  }

  stopStream(): void {
    if (!this._stream) return;
    this._stream.getTracks().forEach((t) => t.stop());
    this._stream = null;
    eventBus.emit("STATE_UPDATED", { cameraReady: false, poseActive: false });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — MediaPipe Pose
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates the MediaPipe Pose instance, initialises it (loads WASM + TFLite),
   * and starts the per-frame send loop against the supplied video element.
   *
   * Must be called after the <video> element has its srcObject set and
   * readyState >= HAVE_METADATA (i.e. inside the video's onLoadedMetadata or
   * onCanPlay handler in CameraFeed).
   *
   * @param videoEl - The live <video> element to run inference against.
   */
  async initPose(videoEl: HTMLVideoElement): Promise<void> {
    // Tear down any previous instance before creating a new one.
    this.stopPose();
    this._videoEl = videoEl;

    // Dynamic import keeps the Closure-compiled IIFE out of the static module
    // graph so Turbopack/Webpack don't try to tree-shake its globals.
    const { Pose } = await import("@mediapipe/pose");

    const pose = new Pose({
      locateFile: (file: string) => `/mediapipe/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity:       1,      // 0=Lite, 1=Full, 2=Heavy
      smoothLandmarks:       true,
      enableSegmentation:    false,  // not needed; saves GPU bandwidth
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
    });

    pose.onResults(this._handlePoseResults);

    await pose.initialize();

    this._pose = pose;
    eventBus.emit("STATE_UPDATED", { poseActive: true });

    // Start the frame-send loop.
    this._startRaf();
  }

  /** Cancels the rAF loop and shuts down the Pose instance. */
  stopPose(): void {
    this._stopRaf();
    if (this._pose) {
      this._pose.close();
      this._pose = null;
    }
    this._videoEl = null;
    this._sending = false;
    eventBus.emit("STATE_UPDATED", { poseActive: false });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — recording
  // ─────────────────────────────────────────────────────────────────────────

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

    recorder.start(1_000);
    this._recorder = recorder;
  }

  stopRecording(): void {
    if (this._recorder?.state === "recording") {
      this._recorder.stop();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — gesture detection (still exposed for testing)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Xbox Gesture detection — called internally by _handlePoseResults each frame,
   * but also public so it can be driven by unit tests without a real camera.
   *
   * Detection logic (exact specification):
   *   • Landmark: RIGHT_WRIST only (index 16).
   *   • Bounding box (pixel-space): x > videoWidth - 100  AND  y < 100.
   *   • MediaPipe outputs normalised [0,1] coords; we convert to pixels using
   *     the video element's natural resolution (videoWidth × videoHeight).
   *   • Minimum visibility score: 0.75 — landmarks below this are discarded.
   *   • Dwell threshold: 2 000 ms of *continuous* presence in the box.
   *     The timer resets immediately if the wrist leaves the box.
   *
   * On threshold reached:
   *   1. Emits TRIGGER_CUT { confidence } — the canonical event (new).
   *   2. Emits GESTURE_CUT { confidence } — retained for backward compat.
   *   3. Resets the dwell timer so the same gesture can trigger the next cut.
   *
   * Per-frame side-effect:
   *   Emits STATE_UPDATED { targetZoneDwellMs } every ≥ 16 ms so the UI
   *   countdown ring animates smoothly. Emits 0 on zone exit or trigger.
   */
  onPoseLandmarks(landmarks: PoseLandmark[]): void {
    const now = Date.now();

    // ── 1. Resolve the RIGHT_WRIST landmark ──────────────────────────────────
    const rw = landmarks[RIGHT_WRIST_IDX];

    // Reject missing or low-confidence landmarks immediately.
    if (!rw || rw.visibility < MIN_VISIBILITY) {
      this._resetDwell();
      return;
    }

    // ── 2. Convert normalised coords → pixel space ───────────────────────────
    //
    // _videoEl holds the live <video> element passed to initPose().
    // videoWidth / videoHeight reflect the decoded stream resolution (e.g. 1280×720),
    // not the CSS layout dimensions — exactly right for a pixel-space threshold.
    //
    // Fallback: if _videoEl is null (unit-test path), use normalised coords scaled
    // to a canonical 1280×720 frame so the threshold is equivalent to the spec.
    const frameW = this._videoEl?.videoWidth  || 1280;
    const frameH = this._videoEl?.videoHeight || 720;

    const pixelX = rw.x * frameW;
    const pixelY = rw.y * frameH;

    // ── 3. Xbox Gesture bounding box test ────────────────────────────────────
    //   x > videoWidth  - 100   →  pixelX > frameW - XBOX_ZONE_RIGHT_MARGIN_PX
    //   y < 100                 →  pixelY < XBOX_ZONE_TOP_MARGIN_PX
    const inBox =
      pixelX > frameW - XBOX_ZONE_RIGHT_MARGIN_PX &&
      pixelY < XBOX_ZONE_TOP_MARGIN_PX;

    // ── 4. Dwell state machine ────────────────────────────────────────────────
    if (inBox) {
      if (this._dwellStart === null) this._dwellStart = now;

      const elapsed = now - this._dwellStart;
      const clamped = Math.min(elapsed, GESTURE_DWELL_MS);

      // Throttle STATE_UPDATED to one emit per animation frame (≥ 16 ms).
      if (clamped - this._lastDwellMs >= 16) {
        this._lastDwellMs = clamped;
        eventBus.emit("STATE_UPDATED", { targetZoneDwellMs: clamped });
      }

      // ── 5. Fire on threshold ─────────────────────────────────────────────
      if (elapsed >= GESTURE_DWELL_MS) {
        // TRIGGER_CUT — canonical Xbox Gesture event dispatched to Director Agent.
        eventBus.emit("TRIGGER_CUT", { confidence: rw.visibility });
        // GESTURE_CUT — legacy compat (Director Agent subscribes to both).
        eventBus.emit("GESTURE_CUT", { confidence: rw.visibility });

        this._resetDwell();
      }
    } else {
      this._resetDwell();
    }
  }

  /**
   * Clears the dwell timer and notifies the UI.
   * Called when the wrist leaves the zone, visibility drops, or a cut fires.
   */
  private _resetDwell(): void {
    if (this._dwellStart !== null || this._lastDwellMs !== 0) {
      this._dwellStart  = null;
      this._lastDwellMs = 0;
      eventBus.emit("STATE_UPDATED", { targetZoneDwellMs: 0 });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — MediaPipe results handler
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fired by MediaPipe after each pose.send() completes.
   * 1. Converts landmarks to our internal type and calls onPoseLandmarks().
   * 2. Emits POSE_UPDATE for the Analyst Agent.
   * 3. Calls the canvas draw callback for the visual overlay.
   */
  private _handlePoseResults = (results: Results): void => {
    this._sending = false; // allow the next rAF frame to send

    const rawLandmarks = results.poseLandmarks;
    if (!rawLandmarks || rawLandmarks.length === 0) return;

    // Convert to our internal type and forward to gesture detection.
    const landmarks: PoseLandmark[] = rawLandmarks.map(toLandmark);
    this.onPoseLandmarks(landmarks);

    // Notify the Analyst Agent (and anyone else subscribed).
    eventBus.emit("POSE_UPDATE", { landmarks });

    // Draw skeleton on the canvas overlay.
    this._canvasDrawCallback?.(rawLandmarks);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Private — rAF send loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Each animation frame: if the video is ready and a previous send has
   * completed, dispatch the current frame to MediaPipe.
   *
   * We guard with `_sending` so frames never queue up behind a slow inference
   * call — we simply skip the frame and wait for the next rAF tick.
   */
  private _startRaf(): void {
    if (this._rafHandle !== null) return;

    const tick = () => {
      this._rafHandle = requestAnimationFrame(tick);

      if (!this._pose || !this._videoEl) return;
      if (this._videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (this._sending) return; // previous inference still running

      this._sending = true;
      this._pose.send({ image: this._videoEl }).catch(() => {
        this._sending = false; // reset on error so loop can recover
      });
    };

    this._rafHandle = requestAnimationFrame(tick);
  }

  private _stopRaf(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _onModeChange(prev: AppMode, next: AppMode): void {
    void prev;
    if (next === "REVIEWING" || next === "IDLE") {
      this.stopRecording();
    }
  }

  private _stopRecorderSilently(): void {
    if (!this._recorder) return;
    this._recorder.onstop = null;
    if (this._recorder.state !== "inactive") this._recorder.stop();
    this._recorder         = null;
    this._chunks           = [];
    this._activeSegmentId  = null;
  }

  private _bestMimeType(): string {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  get isStreaming(): boolean  { return this._stream !== null; }
  get isRecording(): boolean  { return this._recorder?.state === "recording"; }
  get isPoseActive(): boolean { return this._pose !== null; }

  /**
   * Normalised Target Zone for the canvas HUD overlay (not the gesture box).
   * The gesture uses pixel-space thresholds; this is purely for the visual ring.
   */
  static get targetZone() { return TARGET_ZONE; }
}
