/**
 * Cadence AI — CameraFeed component
 *
 * Responsibilities:
 *  1. Permission gate  — idle → requesting → active | denied | unavailable.
 *                        Each state renders a distinct UI card.
 *  2. Video element    — mirrored live stream from CameraAgent attached via ref.
 *  3. Target Zone overlay — top-right corner rectangle that shows the
 *                        Xbox Gesture dwell countdown ring.
 *                        Reads targetZoneDwellMs from the Zustand store
 *                        (written by CameraAgent.onPoseLandmarks).
 *  4. Recording badge  — pulsing red dot when mode === "RECORDING" | "RETAKE".
 *  5. Status chip      — current appMode shown bottom-left.
 *
 * Architecture notes:
 *  - useCameraAgent() creates the stable CameraAgent singleton.
 *  - On mount the component registers a streamReady callback so the agent
 *    can hand the MediaStream to the <video> ref without holding a DOM ref.
 *  - MediaPipe is NOT wired in this file (that's the next iteration).
 *    The hook surface (cameraAgent.onPoseLandmarks) is fully ready.
 */

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useCameraAgent } from "@/hooks/useCameraAgent";
import { CameraAgent } from "@/agents/CameraAgent";
import {
  useCadenceStore,
  selectMode,
  selectTargetZoneDwellMs,
} from "@/store/cadenceStore";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GESTURE_DWELL_MS = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// Permission state type
// ─────────────────────────────────────────────────────────────────────────────

type PermissionState = "idle" | "requesting" | "active" | "denied" | "unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function modeLabelText(mode: string): string {
  switch (mode) {
    case "IDLE":       return "Idle";
    case "RECORDING":  return "Recording";
    case "REVIEWING":  return "Reviewing";
    case "RETAKE":     return "Retake";
    case "COMPILING":  return "Compiling";
    default:           return mode;
  }
}

function modeChipStyle(mode: string): string {
  switch (mode) {
    case "RECORDING":
    case "RETAKE":
      return "bg-red-950/80 text-red-300 border-red-700";
    case "REVIEWING":
      return "bg-violet-950/80 text-violet-300 border-violet-700";
    case "COMPILING":
      return "bg-amber-950/80 text-amber-300 border-amber-700";
    default:
      return "bg-neutral-900/80 text-neutral-400 border-neutral-700";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** SVG countdown ring drawn around the Target Zone dwell progress. */
function DwellRing({ progressMs }: { progressMs: number }) {
  // Ring is a circle drawn with stroke-dasharray/dashoffset.
  const SIZE = 56;
  const STROKE = 3;
  const RADIUS = (SIZE - STROKE) / 2;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const progress = Math.min(progressMs / GESTURE_DWELL_MS, 1);
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const isActive = progressMs > 0;

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden="true"
      className={`transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-40"}`}
    >
      {/* Track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={STROKE}
      />
      {/* Progress arc — starts at 12 o'clock */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={progress >= 1 ? "#4ade80" : "#a78bfa"}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        style={{ transition: "stroke-dashoffset 80ms linear, stroke 200ms" }}
      />
      {/* Centre icon: wrist/hand symbol */}
      <text
        x="50%"
        y="54%"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="16"
        fill={progress >= 1 ? "#4ade80" : "rgba(255,255,255,0.7)"}
      >
        ✋
      </text>
    </svg>
  );
}

/** Pulsing red recording dot badge. */
function RecordingBadge() {
  return (
    <div
      role="status"
      aria-label="Recording in progress"
      className="flex items-center gap-1.5 rounded-full bg-red-950/80 border border-red-700 px-2.5 py-1 backdrop-blur-sm"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span className="text-xs font-semibold text-red-300 tracking-wide">
        REC
      </span>
    </div>
  );
}

/** Shown when getUserMedia is not available (non-HTTPS / old browser). */
function UnavailableCard() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <circle cx="20" cy="20" r="18" stroke="#ef4444" strokeWidth="1.5" />
        <path d="M14 26L26 14M14 14l12 12" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-semibold text-neutral-300">Camera unavailable</p>
      <p className="text-xs text-neutral-500 max-w-xs">
        Camera access requires a secure (HTTPS) context and a browser that
        supports <code className="font-mono text-neutral-400">getUserMedia</code>.
      </p>
    </div>
  );
}

/** Shown after the user denies camera permission. */
function DeniedCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <circle cx="20" cy="20" r="18" stroke="#f59e0b" strokeWidth="1.5" />
        <path d="M20 12v10M20 26v2" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div>
        <p className="text-sm font-semibold text-neutral-300">Camera access denied</p>
        <p className="mt-1 text-xs text-neutral-500 max-w-xs">
          Open your browser&apos;s site permissions and allow camera access,
          then click Retry.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg bg-neutral-800 hover:bg-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-200 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

/** Idle call-to-action before the user has clicked Enable Camera. */
function IdleCard({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
      {/* Camera icon */}
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect x="4" y="14" width="40" height="28" rx="5" stroke="#525252" strokeWidth="1.5" />
        <circle cx="24" cy="28" r="8" stroke="#525252" strokeWidth="1.5" />
        <circle cx="24" cy="28" r="4" stroke="#525252" strokeWidth="1.5" />
        <path d="M16 14l3-6h10l3 6" stroke="#525252" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="37" cy="20" r="2" fill="#525252" />
      </svg>

      <div>
        <p className="text-sm font-semibold text-neutral-300">Camera feed</p>
        <p className="mt-1 text-xs text-neutral-500 max-w-xs">
          Enable your webcam so Cadence AI can detect your gestures and
          record choreography segments.
        </p>
      </div>

      <button
        type="button"
        onClick={onEnable}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors"
      >
        Enable Camera
      </button>
    </div>
  );
}

/** Skeleton shown while getUserMedia permission prompt is open. */
function RequestingCard() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <svg
        className="animate-spin"
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="14" cy="14" r="11" stroke="#404040" strokeWidth="2.5" />
        <path
          d="M14 3a11 11 0 0 1 11 11"
          stroke="#a78bfa"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <p className="text-sm text-neutral-400">Requesting camera access…</p>
      <p className="text-xs text-neutral-600">
        Check the permission prompt in your browser.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function CameraFeed() {
  const cameraAgent = useCameraAgent();

  // Fine-grained Zustand selectors.
  const mode    = useCadenceStore(selectMode);
  const dwellMs = useCadenceStore(selectTargetZoneDwellMs);

  // Local permission gate state (not part of global state — purely UI).
  const [permission, setPermission] = useState<PermissionState>(() =>
    // If the browser doesn't support getUserMedia, start in unavailable.
    typeof window !== "undefined" && !navigator?.mediaDevices?.getUserMedia
      ? "unavailable"
      : "idle"
  );

  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Register the stream-ready callback on mount ───────────────────────────
  useEffect(() => {
    cameraAgent.setStreamReadyCallback((stream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    });
  }, [cameraAgent]);

  // ── No sync-back effect needed ────────────────────────────────────────────
  // permission is set exclusively by handleEnable and its error branches.
  // If the stream is killed externally (agent.unmount), the video element
  // simply becomes invisible because cameraReady drops to false in the store
  // and the "active" branch is hidden. On the next user interaction the user
  // will click Enable Camera again, which resets permission to "requesting".

  // ── Request camera access ─────────────────────────────────────────────────
  const handleEnable = useCallback(async () => {
    setPermission("requesting");
    try {
      await cameraAgent.requestStream();
      setPermission("active");
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setPermission("denied");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setPermission("unavailable");
      } else {
        // Unexpected error — fall back to denied so the user can retry.
        setPermission("denied");
      }
    }
  }, [cameraAgent]);

  // Derived flags
  const isRecording = mode === "RECORDING" || mode === "RETAKE";

  // Target Zone geometry as percentages — matches CameraAgent.targetZone.
  const tz = CameraAgent.targetZone;
  const tzStyle: React.CSSProperties = {
    right: `${(1 - tz.xMax) * 100}%`,
    top:   `${tz.yMin * 100}%`,
    width: `${(tz.xMax - tz.xMin) * 100}%`,
    height:`${(tz.yMax - tz.yMin) * 100}%`,
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="w-full rounded-2xl bg-neutral-900 border border-neutral-800 overflow-hidden flex flex-col">

      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          {/* Camera icon */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1" y="4" width="14" height="10" rx="2" stroke="#a78bfa" strokeWidth="1.2" />
            <circle cx="8" cy="9" r="2.5" stroke="#a78bfa" strokeWidth="1.2" />
            <path d="M5.5 4l1-2h3l1 2" stroke="#a78bfa" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-semibold tracking-widest uppercase text-violet-400">
            Camera Agent
          </span>
        </div>

        {/* Live indicator — only when stream is active */}
        {permission === "active" && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        )}
      </div>

      {/* ── Content area ── */}
      {permission === "unavailable" && <UnavailableCard />}
      {permission === "denied"      && <DeniedCard onRetry={handleEnable} />}
      {permission === "requesting"  && <RequestingCard />}
      {permission === "idle"        && <IdleCard onEnable={handleEnable} />}

      {/* ── Video viewport — rendered even when permission === active ── */}
      {/* We keep the <video> in the DOM once active so the stream never */}
      {/* gets torn down by a conditional unmount.                        */}
      <div
        className={[
          "relative w-full bg-black",
          // 16:9 aspect ratio
          "aspect-video",
          permission === "active" ? "block" : "hidden",
        ].join(" ")}
      >
        {/* Live video — mirrored so it matches the performer's intuition */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Live camera feed"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: "scaleX(-1)" }}
          onCanPlay={() => {
            // Ensure playback starts (some browsers need an explicit call
            // after srcObject is set).
            videoRef.current?.play().catch(() => {
              // Autoplay blocked — muted video should never hit this in practice.
            });
          }}
        />

        {/* ── Target Zone overlay ── */}
        <div
          aria-label="Gesture target zone"
          className={[
            "absolute rounded-lg border-2 flex items-center justify-center",
            "transition-colors duration-150 pointer-events-none",
            dwellMs > 0
              ? "border-violet-400 bg-violet-500/10"
              : "border-white/20 bg-white/5",
          ].join(" ")}
          style={tzStyle}
        >
          <DwellRing progressMs={dwellMs} />
        </div>

        {/* ── Recording badge — top-left ── */}
        <div className="absolute top-3 left-3 flex items-center gap-2">
          {isRecording && <RecordingBadge />}
        </div>

        {/* ── Mode chip — bottom-left ── */}
        <div className="absolute bottom-3 left-3">
          <span
            className={[
              "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
              "backdrop-blur-sm tracking-wide",
              modeChipStyle(mode),
            ].join(" ")}
          >
            {modeLabelText(mode)}
          </span>
        </div>

        {/* ── Target zone label — shown only while dwell is active ── */}
        {dwellMs > 0 && (
          <div
            aria-live="polite"
            aria-atomic="true"
            className="absolute top-3 right-3 text-xs text-violet-300 font-semibold pointer-events-none"
            style={{
              // Nudge label above the target zone box which sits in the top-right.
              marginRight: `${(tz.xMax - tz.xMin) * 100 + 2}%`,
            }}
          >
            {Math.ceil((GESTURE_DWELL_MS - dwellMs) / 1_000)}s
          </div>
        )}
      </div>
    </div>
  );
}
