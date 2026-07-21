/**
 * Cadence AI — Audio Agent
 *
 * Owns the master audio track lifecycle via the Web Audio API.
 * Exposes frame-accurate timing to the rest of the system through
 * the event bus — it never reaches into other agents directly.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  AudioAgent                                                 │
 * │                                                             │
 * │  load(ArrayBuffer)  →  decodes MP3 into AudioBuffer        │
 * │  play()             →  creates + starts a new SourceNode   │
 * │  pause()            →  suspends AudioContext               │
 * │  seek(seconds)      →  recreates SourceNode at offset      │
 * │  getCurrentTime()   →  hardware-sync'd Web Audio clock     │
 * │  getDuration()      →  total decoded track length          │
 * │                                                             │
 * │  rAF loop  →  emits AUDIO_TICK { currentTime } at 60 fps   │
 * │            →  emits AUDIO_ENDED {}  when track finishes    │
 * │                                                             │
 * │  Listens for PUNCH_IN_START → calls seek() automatically   │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Timing contract:
 *   currentTime = audioContext.currentTime - _startContextTime + _seekOffset
 *
 * Using the Web Audio hardware clock (audioContext.currentTime) instead of
 * Date.now() gives sub-millisecond precision and immunity to JS-thread jank.
 * This value is what DirectorAgent stamps onto segment.startTime / endTime,
 * and what the Editor Agent passes to Lambda for FFmpeg trimming.
 */

import { eventBus } from "@/lib/eventBus";

// ─────────────────────────────────────────────────────────────────────────────
// Internal state type
// ─────────────────────────────────────────────────────────────────────────────

type PlaybackState = "idle" | "playing" | "paused";

export class AudioAgent {
  // ── Web Audio primitives ───────────────────────────────────────────────────
  private _ctx: AudioContext | null = null;
  private _buffer: AudioBuffer | null = null;
  /**
   * AudioBufferSourceNode is single-use: once stopped it cannot be restarted.
   * We recreate it on every play() and seek().
   */
  private _source: AudioBufferSourceNode | null = null;

  // ── Timing bookkeeping ─────────────────────────────────────────────────────
  /**
   * The AudioContext.currentTime at the moment play() was last called.
   * Used to derive the track position:
   *   trackTime = ctx.currentTime - _startContextTime + _seekOffset
   */
  private _startContextTime = 0;
  /**
   * Track offset (seconds) when the current source node started.
   * Updated by seek(); preserved across pause/resume via _pausedAt.
   */
  private _seekOffset = 0;
  /** Track position (seconds) captured at the moment pause() was called. */
  private _pausedAt = 0;

  // ── Playback state ─────────────────────────────────────────────────────────
  private _state: PlaybackState = "idle";

  // ── rAF loop ───────────────────────────────────────────────────────────────
  private _rafHandle: number | null = null;

  // ── PUNCH_IN_START listener (stored for clean removal on unmount) ──────────
  private _handlePunchIn = ({ seekTo }: { targetSegmentId: string; seekTo: number }) => {
    this.seek(seekTo);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Subscribes to relevant event bus events.
   * Called once by useAudioAgent on mount.
   */
  mount(): void {
    eventBus.on("PUNCH_IN_START", this._handlePunchIn);
  }

  /**
   * Cleans up the AudioContext, cancels the rAF loop, and removes all listeners.
   * Called once by useAudioAgent on unmount.
   */
  unmount(): void {
    eventBus.off("PUNCH_IN_START", this._handlePunchIn);
    this._stopRaf();
    if (this._ctx && this._ctx.state !== "closed") {
      this._ctx.close();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Decodes a raw ArrayBuffer (from a File read) into an AudioBuffer and
   * emits `STATE_UPDATED` patches for audioLoaded + audioDuration so the
   * Director Agent's Zustand store reflects the new track immediately.
   *
   * @throws if the browser cannot decode the supplied buffer
   */
  async load(arrayBuffer: ArrayBuffer): Promise<void> {
    // Lazily create (or recreate after close) the AudioContext.
    // We defer creation until a user gesture to comply with browser
    // autoplay policies — load() is always triggered by a file-input change.
    if (!this._ctx || this._ctx.state === "closed") {
      this._ctx = new AudioContext();
    }

    // Reset prior playback state before decoding.
    this._stopSource();
    this._stopRaf();
    this._state = "idle";
    this._seekOffset = 0;
    this._pausedAt = 0;

    // decodeAudioData takes ownership of the ArrayBuffer (transfers it).
    // Clone it first so the caller still has access if needed.
    this._buffer = await this._ctx.decodeAudioData(arrayBuffer);

    // Notify the Director Agent / Zustand store.
    eventBus.emit("STATE_UPDATED", {
      audioLoaded: true,
      audioDuration: this._buffer.duration,
      audioCurrentTime: 0,
    });
  }

  /**
   * Starts or resumes playback from the current position.
   * No-op if already playing or no buffer is loaded.
   */
  play(): void {
    if (!this._ctx || !this._buffer) return;
    if (this._state === "playing") return;

    // Resume a suspended AudioContext (can happen after pause()).
    if (this._ctx.state === "suspended") {
      this._ctx.resume();
    }

    const offset = this._state === "paused" ? this._pausedAt : this._seekOffset;
    this._startSourceAt(offset);
    this._state = "playing";
    this._startRaf();
  }

  /**
   * Pauses playback at the current track position.
   * Suspending the AudioContext is the recommended pause strategy — it
   * halts the audio hardware clock while preserving the decoded buffer.
   */
  pause(): void {
    if (!this._ctx || this._state !== "playing") return;

    this._pausedAt = this.getCurrentTime();
    this._stopSource();
    this._ctx.suspend();
    this._state = "paused";
    this._stopRaf();

    // Emit one final tick at the exact paused position so the UI scrubber
    // snaps to the precise location rather than lagging one frame behind.
    eventBus.emit("AUDIO_TICK", { currentTime: this._pausedAt });
  }

  /**
   * Seeks to an absolute position in the track (seconds).
   * Works in all states — playing, paused, or idle.
   *
   * @param timeSeconds - Target position. Clamped to [0, duration].
   */
  seek(timeSeconds: number): void {
    if (!this._buffer) return;
    const clamped = Math.max(0, Math.min(timeSeconds, this._buffer.duration));

    const wasPlaying = this._state === "playing";

    // Tear down any active source node — source nodes cannot be repositioned.
    this._stopSource();
    this._seekOffset = clamped;
    this._pausedAt = clamped;

    if (wasPlaying) {
      // Resume AudioContext if it was suspended during a prior pause().
      if (this._ctx && this._ctx.state === "suspended") {
        this._ctx.resume();
      }
      this._startSourceAt(clamped);
      this._state = "playing";
      // rAF loop should already be running; if not, restart it.
      if (this._rafHandle === null) this._startRaf();
    } else {
      this._state = this._buffer ? "paused" : "idle";
    }

    // Immediately push the seeked time so the UI scrubber is responsive.
    eventBus.emit("AUDIO_TICK", { currentTime: clamped });
  }

  /**
   * Returns the current playback position in seconds using the Web Audio
   * hardware clock.  Always safe to call — returns 0 before load().
   */
  getCurrentTime(): number {
    if (!this._ctx || !this._buffer) return 0;

    if (this._state === "playing") {
      const elapsed = this._ctx.currentTime - this._startContextTime;
      return Math.min(this._seekOffset + elapsed, this._buffer.duration);
    }

    // paused or idle — return the captured position
    return this._pausedAt;
  }

  /** Total decoded track length in seconds. 0 before load(). */
  getDuration(): number {
    return this._buffer?.duration ?? 0;
  }

  /** Current playback state string — useful for UI button labels. */
  getPlaybackState(): PlaybackState {
    return this._state;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new AudioBufferSourceNode, connects it to the destination,
   * and starts it at `offset` seconds into the buffer.
   * Records `_startContextTime` for future getCurrentTime() calls.
   */
  private _startSourceAt(offset: number): void {
    if (!this._ctx || !this._buffer) return;

    const source = this._ctx.createBufferSource();
    source.buffer = this._buffer;
    source.connect(this._ctx.destination);

    // onended fires when the track reaches its natural end.
    source.onended = this._handleSourceEnded;

    source.start(0, offset);

    this._source = source;
    this._startContextTime = this._ctx.currentTime;
    this._seekOffset = offset;
  }

  /**
   * Disconnects and nulls the active SourceNode without triggering onended.
   * We must set onended to null before stop() to prevent the ended handler
   * from firing when we're deliberately stopping (seek / pause / unmount).
   */
  private _stopSource(): void {
    if (!this._source) return;
    this._source.onended = null;
    try {
      this._source.stop();
    } catch {
      // Throws if the source was never started — safe to ignore.
    }
    this._source.disconnect();
    this._source = null;
  }

  /**
   * Natural end-of-track handler.
   * Only fires when audio actually runs out (not on stop/seek/pause).
   */
  private _handleSourceEnded = (): void => {
    if (this._state !== "playing") return; // guard against stale callbacks

    this._state = "paused";
    this._pausedAt = this._buffer?.duration ?? 0;
    this._stopRaf();

    eventBus.emit("AUDIO_TICK", { currentTime: this._pausedAt });
    eventBus.emit("AUDIO_ENDED", {});
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // requestAnimationFrame tick loop
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Schedules the rAF loop. Each frame emits AUDIO_TICK with the current
   * hardware-sync'd track position. The Director Agent's handleAudioTick
   * writes this into AppState.audioCurrentTime, driving the UI scrubber.
   */
  private _startRaf(): void {
    if (this._rafHandle !== null) return; // already running
    const tick = () => {
      // Bail if no longer playing (seek/pause/unmount cleared _rafHandle).
      if (this._state !== "playing") {
        this._rafHandle = null;
        return;
      }

      const currentTime = this.getCurrentTime();
      eventBus.emit("AUDIO_TICK", { currentTime });

      // Schedule next frame.
      this._rafHandle = requestAnimationFrame(tick);
    };

    this._rafHandle = requestAnimationFrame(tick);
  }

  private _stopRaf(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }
}
