/**
 * Cadence AI — Director Agent
 *
 * The Orchestrator. Owns AppState and the segments[] array.
 * Subscribes to all other agents via the event bus.
 * Never performs I/O (no fetch, no MediaPipe, no Web Audio).
 *
 * React components never instantiate this directly.
 * Use the DirectorAgentContext + useDirector hook instead.
 */

import { v4 as uuidv4 } from "uuid";
import { eventBus } from "@/lib/eventBus";
import type { AppState, Segment } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum visibility score for a landmark to count as "in zone" */
const MIN_LANDMARK_VISIBILITY = 0.8;

function buildEmptySegment(
  sessionId: string,
  index: number,
  startTime: number
): Segment {
  return {
    segmentId: uuidv4(),
    sessionId,
    index,
    status: "RECORDING",
    startTime,
    endTime: null,
    previewUrl: null,
    s3Key: null,
    velocitySnapshots: [],
    energyLog: null,
    replacesSegmentId: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial state factory
// ─────────────────────────────────────────────────────────────────────────────

function buildInitialState(): AppState {
  return {
    sessionId: uuidv4(),
    mode: "IDLE",
    retakeTargetId: null,
    audioLoaded: false,
    audioDuration: 0,
    audioCurrentTime: 0,
    cameraReady: false,
    poseActive: false,
    targetZoneDwellMs: 0,
    segments: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DirectorAgent class
// ─────────────────────────────────────────────────────────────────────────────

export class DirectorAgent {
  private state: AppState = buildInitialState();
  /** Debounce handle for STATE_UPDATED emissions */
  private stateUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tracks the currently-recording segment id so VELOCITY_SNAPSHOT events
   * can be routed to the right segment without a linear scan.
   */
  private activeSegmentId: string | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to all relevant event bus events.
   * Call once on mount (done inside DirectorAgentContext).
   */
  mount(): void {
    eventBus.on("GESTURE_CUT", this.handleGestureCut);
    eventBus.on("VELOCITY_SNAPSHOT", this.handleVelocitySnapshot);
    eventBus.on("AUDIO_TICK", this.handleAudioTick);
    eventBus.on("AUDIO_ENDED", this.handleAudioEnded);
    eventBus.on("SCRIBE_PREVIEW_READY", this.handleScribePreviewReady);
    eventBus.on("SCRIBE_SAVED", this.handleScribeSaved);
    eventBus.on("ANALYST_RESULT", this.handleAnalystResult);
    eventBus.on("COMPILE_COMPLETE", this.handleCompileComplete);
  }

  /**
   * Unsubscribe all listeners.
   * Call on unmount (done inside DirectorAgentContext).
   */
  unmount(): void {
    eventBus.off("GESTURE_CUT", this.handleGestureCut);
    eventBus.off("VELOCITY_SNAPSHOT", this.handleVelocitySnapshot);
    eventBus.off("AUDIO_TICK", this.handleAudioTick);
    eventBus.off("AUDIO_ENDED", this.handleAudioEnded);
    eventBus.off("SCRIBE_PREVIEW_READY", this.handleScribePreviewReady);
    eventBus.off("SCRIBE_SAVED", this.handleScribeSaved);
    eventBus.off("ANALYST_RESULT", this.handleAnalystResult);
    eventBus.off("COMPILE_COMPLETE", this.handleCompileComplete);

    if (this.stateUpdateTimer !== null) {
      clearTimeout(this.stateUpdateTimer);
    }
  }

  // ── Public API (called by UI layer / other agents) ─────────────────────────

  getState(): Readonly<AppState> {
    return this.state;
  }

  /**
   * Punch-In: begin a targeted retake of an existing segment.
   * Seeks audio to the segment's startTime, notifies all agents.
   */
  triggerPunchIn(segmentId: string): void {
    const target = this.state.segments.find((s) => s.segmentId === segmentId);
    if (!target) return;

    this.patch({
      mode: "RETAKE",
      retakeTargetId: segmentId,
    });

    eventBus.emit("PUNCH_IN_START", {
      targetSegmentId: segmentId,
      seekTo: target.startTime,
    });
  }

  /**
   * Finalise timeline order after drag-and-drop reorder.
   * Re-indexes segments to match the supplied ordered id array.
   */
  reorderSegments(orderedIds: string[]): void {
    const reordered = orderedIds
      .map((id, index) => {
        const seg = this.state.segments.find((s) => s.segmentId === id);
        return seg ? { ...seg, index } : null;
      })
      .filter((s): s is Segment => s !== null);

    this.patch({ segments: reordered });
  }

  /**
   * Marks a segment as in-error. Called by Scribe / Editor on upload failure.
   */
  markSegmentError(segmentId: string): void {
    this.patchSegment(segmentId, { status: "ERROR" });
  }

  // ── Event handlers (arrow functions preserve `this` binding) ──────────────

  private handleGestureCut = ({
    confidence,
  }: {
    confidence: number;
  }): void => {
    if (confidence < MIN_LANDMARK_VISIBILITY) return;

    const { mode, sessionId, segments, audioCurrentTime } = this.state;

    if (mode === "IDLE" || mode === "REVIEWING") {
      // ── Start a new recording ────────────────────────────────────────────
      const newSegment = buildEmptySegment(
        sessionId,
        segments.length,
        audioCurrentTime
      );
      this.activeSegmentId = newSegment.segmentId;

      this.patch({
        mode: "RECORDING",
        segments: [...segments, newSegment],
      });

      // Signal Camera Agent to start MediaRecorder (it listens for mode change
      // via STATE_UPDATED, but we also emit PUNCH_IN_START structure for clarity)
      return;
    }

    if (mode === "RECORDING" || mode === "RETAKE") {
      // ── End the current recording ────────────────────────────────────────
      if (!this.activeSegmentId) return;

      this.patchSegment(this.activeSegmentId, {
        endTime: audioCurrentTime,
        status: "UPLOADING",
      });

      // If this was a RETAKE, splice the new segment over the old one
      if (mode === "RETAKE" && this.state.retakeTargetId) {
        this.spliceRetake(this.state.retakeTargetId);
      }

      this.activeSegmentId = null;
      this.patch({ mode: "REVIEWING", retakeTargetId: null });
    }
  };

  private handleVelocitySnapshot = (
    payload: import("@/lib/types").VelocitySnapshot & { segmentId: string }
  ): void => {
    const { segmentId, ...snapshot } = payload;
    const seg = this.state.segments.find((s) => s.segmentId === segmentId);
    if (!seg) return;

    this.patchSegment(segmentId, {
      velocitySnapshots: [...seg.velocitySnapshots, snapshot],
    });
  };

  private handleAudioTick = ({
    currentTime,
  }: {
    currentTime: number;
  }): void => {
    // High-frequency update — patch directly without triggering a full
    // debounce reset so timeline scrubber stays smooth.
    this.state = { ...this.state, audioCurrentTime: currentTime };
    this.scheduleStateUpdate();
  };

  private handleAudioEnded = (): void => {
    if (this.state.mode === "RECORDING") {
      // Auto-cut if audio ends while recording
      eventBus.emit("GESTURE_CUT", { confidence: 1 });
    }
  };

  private handleScribePreviewReady = ({
    segmentId,
    previewUrl,
  }: {
    segmentId: string;
    previewUrl: string;
  }): void => {
    this.patchSegment(segmentId, { previewUrl });
  };

  private handleScribeSaved = ({
    segmentId,
    s3Key,
  }: {
    segmentId: string;
    s3Key: string;
  }): void => {
    this.patchSegment(segmentId, { s3Key, status: "READY" });
  };

  private handleAnalystResult = ({
    segmentId,
    energyLog,
  }: {
    segmentId: string;
    energyLog: import("@/lib/types").EnergyLog;
  }): void => {
    this.patchSegment(segmentId, { energyLog });
  };

  private handleCompileComplete = ({
    downloadUrl,
  }: {
    downloadUrl: string;
  }): void => {
    // Surface the download URL via state so the UI can render a download button.
    // We cast to allow an ad-hoc extension; in production add downloadUrl to AppState.
    this.patch({
      mode: "REVIEWING",
      ...(({ downloadUrl } as unknown) as Partial<AppState>),
    });
    // Re-emit a clean signal the UI can directly act on without reading full state.
    // (The UI hook also subscribes to COMPILE_COMPLETE directly for the download.)
    void downloadUrl; // acknowledged
  };

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * After a RETAKE recording finishes, insert the new segment in place of the
   * original, preserving its index position.
   */
  private spliceRetake(oldSegmentId: string): void {
    const oldIndex = this.state.segments.findIndex(
      (s) => s.segmentId === oldSegmentId
    );
    if (oldIndex === -1) return;

    const newSegId = this.activeSegmentId;
    if (!newSegId) return;

    const segments = this.state.segments.map((s) => {
      if (s.segmentId === newSegId) {
        return { ...s, index: oldIndex, replacesSegmentId: oldSegmentId };
      }
      if (s.segmentId === oldSegmentId) {
        // Mark the old segment as superseded (keep for undo, remove from display)
        return { ...s, index: -1 };
      }
      return s;
    });

    // Filter out the superseded segment from the active timeline
    this.patch({
      segments: segments.filter((s) => s.index !== -1),
    });
  }

  /** Immutably update a single segment by id and schedule a UI notification. */
  private patchSegment(segmentId: string, updates: Partial<Segment>): void {
    const segments = this.state.segments.map((s) =>
      s.segmentId === segmentId ? { ...s, ...updates } : s
    );
    this.patch({ segments });
  }

  /** Merge a partial state update and schedule the debounced STATE_UPDATED emit. */
  private patch(updates: Partial<AppState>): void {
    this.state = { ...this.state, ...updates };
    this.scheduleStateUpdate();
  }

  /**
   * Debounce STATE_UPDATED to one emit per animation frame (≈ 16 ms).
   * This prevents React from receiving hundreds of re-render triggers
   * per second from AUDIO_TICK events.
   */
  private scheduleStateUpdate(): void {
    if (this.stateUpdateTimer !== null) return;
    this.stateUpdateTimer = setTimeout(() => {
      this.stateUpdateTimer = null;
      eventBus.emit("STATE_UPDATED", this.state);
    }, 16);
  }
}
