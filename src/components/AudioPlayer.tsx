/**
 * Cadence AI — AudioPlayer component
 *
 * Responsibilities:
 *  1. MP3 upload  — drag-and-drop or click-to-browse file input.
 *                   Reads the file as ArrayBuffer and calls audioAgent.load().
 *  2. Playback UI — Play/Pause button wired to audioAgent.play() / .pause().
 *  3. Scrubber    — A range input that displays audioCurrentTime from the
 *                   Zustand store (written by the rAF loop) and calls
 *                   audioAgent.seek() on user interaction.
 *  4. Time stamps — Elapsed / total time displayed in MM:SS format.
 *  5. Track name  — Shows the filename of the loaded track.
 *
 * State strategy:
 *  - audioCurrentTime, audioLoaded, audioDuration  → read from Zustand store
 *    (updated by DirectorAgent.handleAudioTick ← AUDIO_TICK ← rAF loop)
 *  - isSeeking (local) → true while the user is dragging the scrubber thumb,
 *    which prevents the rAF loop from fighting the thumb position mid-drag.
 *  - isPlaying (local) → derived from audioAgent.getPlaybackState() and kept
 *    in sync on each play/pause action.
 */

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAudioAgent } from "@/hooks/useAudioAgent";
import {
  useCadenceStore,
  selectAudioCurrentTime,
  selectAudioLoaded,
  selectAudioDuration,
} from "@/store/cadenceStore";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function UploadZone({
  onFile,
  isDragging,
  setIsDragging,
}: {
  onFile: (file: File) => void;
  isDragging: boolean;
  setIsDragging: (v: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith("audio/")) onFile(file);
    },
    [onFile, setIsDragging]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFile(file);
      // Reset so the same file can be re-selected after a reload.
      e.target.value = "";
    },
    [onFile]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload MP3 track"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={[
        "flex flex-col items-center justify-center gap-3 w-full",
        "rounded-xl border-2 border-dashed py-10 px-6 cursor-pointer",
        "transition-colors duration-150 select-none",
        isDragging
          ? "border-violet-400 bg-violet-950/30"
          : "border-neutral-700 bg-neutral-900 hover:border-neutral-500 hover:bg-neutral-800",
      ].join(" ")}
    >
      {/* Waveform icon */}
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        className="text-neutral-500"
      >
        <rect x="4"  y="14" width="3" height="12" rx="1.5" fill="currentColor" />
        <rect x="10" y="8"  width="3" height="24" rx="1.5" fill="currentColor" />
        <rect x="16" y="4"  width="3" height="32" rx="1.5" fill="currentColor" />
        <rect x="22" y="10" width="3" height="20" rx="1.5" fill="currentColor" />
        <rect x="28" y="16" width="3" height="8"  rx="1.5" fill="currentColor" />
        <rect x="34" y="12" width="3" height="16" rx="1.5" fill="currentColor" />
      </svg>

      <p className="text-sm text-neutral-400">
        <span className="font-semibold text-violet-400">Click to browse</span>
        {" "}or drag &amp; drop an MP3
      </p>
      <p className="text-xs text-neutral-600">MP3 · WAV · AAC — max 200 MB</p>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="sr-only"
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

function PlayPauseButton({
  isPlaying,
  disabled,
  onClick,
}: {
  isPlaying: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={isPlaying ? "Pause" : "Play"}
      className={[
        "flex items-center justify-center w-11 h-11 rounded-full shrink-0",
        "transition-colors duration-100",
        disabled
          ? "bg-neutral-800 text-neutral-600 cursor-not-allowed"
          : "bg-violet-600 text-white hover:bg-violet-500 active:bg-violet-700",
      ].join(" ")}
    >
      {isPlaying ? (
        /* Pause icon */
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <rect x="3"  y="2" width="4" height="14" rx="1" />
          <rect x="11" y="2" width="4" height="14" rx="1" />
        </svg>
      ) : (
        /* Play icon */
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <path d="M5 3.118C5 2.105 6.12 1.52 6.97 2.075l9.243 5.882a1.2 1.2 0 0 1 0 2.086L6.97 15.925C6.12 16.48 5 15.895 5 14.882V3.118Z" />
        </svg>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function AudioPlayer() {
  const audioAgent = useAudioAgent();

  // Fine-grained Zustand selectors — each re-renders only its subscriber.
  const audioCurrentTime = useCadenceStore(selectAudioCurrentTime);
  const audioLoaded      = useCadenceStore(selectAudioLoaded);
  const audioDuration    = useCadenceStore(selectAudioDuration);

  // Local UI state
  const [isPlaying, setIsPlaying]     = useState(false);
  const [isLoading, setIsLoading]     = useState(false);
  const [loadError, setLoadError]     = useState<string | null>(null);
  const [trackName, setTrackName]     = useState<string | null>(null);
  const [isDragging, setIsDragging]   = useState(false);
  /**
   * While the user is dragging the scrubber, we freeze the displayed position
   * to the drag value so the rAF loop doesn't fight the thumb.
   */
  const [isSeeking, setIsSeeking]     = useState(false);
  const [seekPreview, setSeekPreview] = useState(0);

  // ── File load ────────────────────────────────────────────────────────────

  const handleFile = useCallback(
    async (file: File) => {
      setIsLoading(true);
      setLoadError(null);
      setTrackName(file.name.replace(/\.[^/.]+$/, "")); // strip extension

      // Stop any currently playing audio before decoding the new track.
      if (isPlaying) {
        audioAgent.pause();
        setIsPlaying(false);
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        await audioAgent.load(arrayBuffer);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "Failed to decode audio file."
        );
        setTrackName(null);
      } finally {
        setIsLoading(false);
      }
    },
    [audioAgent, isPlaying]
  );

  // ── Playback controls ────────────────────────────────────────────────────

  const handlePlayPause = useCallback(() => {
    if (!audioLoaded) return;
    if (isPlaying) {
      audioAgent.pause();
      setIsPlaying(false);
    } else {
      audioAgent.play();
      setIsPlaying(true);
    }
  }, [audioAgent, audioLoaded, isPlaying]);

  // ── Scrubber ─────────────────────────────────────────────────────────────

  /**
   * While dragging: update the preview position locally without seeking yet
   * (avoids creating a new SourceNode on every pixel of movement).
   */
  const handleScrubChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSeekPreview(parseFloat(e.target.value));
    },
    []
  );

  const handleScrubStart = useCallback(() => {
    setIsSeeking(true);
    setSeekPreview(audioCurrentTime);
  }, [audioCurrentTime]);

  /**
   * On pointer release: commit the seek to the AudioAgent.
   * The agent will emit AUDIO_TICK immediately so the store updates.
   * We sync seekPreview into a ref via useEffect so the callback
   * can stay stable (no stale closure) without accessing the ref during render.
   */
  const seekPreviewRef = useRef(seekPreview);
  useEffect(() => {
    seekPreviewRef.current = seekPreview;
  }, [seekPreview]);

  const handleScrubCommit = useCallback(() => {
    audioAgent.seek(seekPreviewRef.current);
    setIsSeeking(false);
  }, [audioAgent]);

  // The value the scrubber thumb should display.
  const scrubberValue = isSeeking ? seekPreview : audioCurrentTime;
  const scrubberMax   = audioDuration > 0 ? audioDuration : 1;
  const progressPct   = (scrubberValue / scrubberMax) * 100;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="w-full rounded-2xl bg-neutral-900 border border-neutral-800 p-5 flex flex-col gap-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Rhythm icon */}
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path
              d="M1 9h2l2-5 3 10 2-8 2 6 2-3h3"
              stroke="#a78bfa"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-xs font-semibold tracking-widest uppercase text-violet-400">
            Audio Agent
          </span>
        </div>

        {audioLoaded && trackName && (
          <span className="max-w-[200px] truncate text-xs text-neutral-400" title={trackName}>
            {trackName}
          </span>
        )}
      </div>

      {/* ── Upload zone (shown until a track is loaded) ── */}
      {!audioLoaded && !isLoading && (
        <UploadZone
          onFile={handleFile}
          isDragging={isDragging}
          setIsDragging={setIsDragging}
        />
      )}

      {/* ── Loading spinner ── */}
      {isLoading && (
        <div className="flex items-center justify-center gap-3 py-8 text-sm text-neutral-400">
          <svg
            className="animate-spin"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="8" stroke="#4b5563" strokeWidth="2" />
            <path
              d="M10 2a8 8 0 0 1 8 8"
              stroke="#a78bfa"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          Decoding audio…
        </div>
      )}

      {/* ── Error message ── */}
      {loadError && (
        <p
          role="alert"
          className="rounded-lg bg-red-950/40 border border-red-800 px-4 py-3 text-sm text-red-400"
        >
          {loadError}
        </p>
      )}

      {/* ── Player controls (shown once loaded) ── */}
      {audioLoaded && (
        <div className="flex flex-col gap-3">

          {/* Scrubber track */}
          <div className="relative w-full h-1.5 rounded-full bg-neutral-700 group">
            {/* Filled portion */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-violet-500 pointer-events-none"
              style={{ width: `${progressPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={scrubberMax}
              step={0.01}
              value={scrubberValue}
              aria-label="Seek track position"
              aria-valuetext={`${formatTime(scrubberValue)} of ${formatTime(audioDuration)}`}
              onChange={handleScrubChange}
              onMouseDown={handleScrubStart}
              onTouchStart={handleScrubStart}
              onMouseUp={handleScrubCommit}
              onTouchEnd={handleScrubCommit}
              className={[
                "absolute inset-0 w-full h-full opacity-0 cursor-pointer",
                // Make the thumb visible on hover/focus via a sibling trick
                "peer",
              ].join(" ")}
            />
            {/* Thumb indicator — visible on hover */}
            <div
              aria-hidden="true"
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
              style={{ left: `${progressPct}%` }}
            />
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-4">
            <PlayPauseButton
              isPlaying={isPlaying}
              disabled={!audioLoaded}
              onClick={handlePlayPause}
            />

            {/* Time stamps */}
            <div className="flex items-baseline gap-1 font-mono text-sm tabular-nums">
              <span className="text-neutral-100">{formatTime(scrubberValue)}</span>
              <span className="text-neutral-600">/</span>
              <span className="text-neutral-500">{formatTime(audioDuration)}</span>
            </div>

            {/* Replace track button */}
            <label
              className="ml-auto flex items-center gap-1.5 cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-400 bg-neutral-800 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
              aria-label="Replace audio track"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path
                  d="M2 6.5A4.5 4.5 0 0 1 10.5 3M11 6.5A4.5 4.5 0 0 1 2.5 10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path d="M10.5 1.5v2h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2.5 11.5v-2h-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Replace
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
                aria-hidden="true"
                tabIndex={-1}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
