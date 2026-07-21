/**
 * Cadence AI — CameraFeed component
 *
 * Responsibilities:
 *  1. Permission gate   — idle → requesting → active | denied | unavailable
 *  2. Video element     — mirrored live stream, attached via ref
 *  3. Canvas overlay    — transparent <canvas> stacked on top of the video,
 *                         sized to match the video via ResizeObserver.
 *                         CameraAgent draws the MediaPipe skeleton onto it
 *                         every rAF frame via setCanvasDrawCallback().
 *  4. Pose init         — once the video is playing, calls cameraAgent.initPose()
 *                         so MediaPipe Pose starts running against the live feed.
 *  5. Target Zone HUD   — top-right corner box + dwell countdown ring (CSS/SVG).
 *  6. Recording badge   — pulsing REC dot when mode is RECORDING | RETAKE.
 *  7. Mode chip         — current appMode chip, bottom-left.
 *
 * Canvas strategy:
 *   The <canvas> sits in absolute inset-0 on top of the <video>.
 *   Both elements use `transform: scaleX(-1)` so the skeleton mirrors
 *   the performer's view. The poseRenderer also applies scaleX(-1) internally
 *   so landmark positions map correctly without coordinate remapping.
 *
 *   Canvas width/height attributes are kept in sync with the video's rendered
 *   size via a ResizeObserver on the container div — this is critical because
 *   CSS width ≠ canvas pixel width and a mismatch causes the skeleton to be
 *   mis-positioned or stretched.
 */

"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { NormalizedLandmarkList } from "@mediapipe/pose";
import { useCameraAgent } from "@/hooks/useCameraAgent";
import { CameraAgent } from "@/agents/CameraAgent";
import { drawPose } from "@/lib/poseRenderer";
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
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PermissionState = "idle" | "requesting" | "active" | "denied" | "unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function modeLabelText(mode: string): string {
  switch (mode) {
    case "IDLE":      return "Idle";
    case "RECORDING": return "Recording";
    case "REVIEWING": return "Reviewing";
    case "RETAKE":    return "Retake";
    case "COMPILING": return "Compiling";
    default:          return mode;
  }
}

function modeChipStyle(mode: string): string {
  switch (mode) {
    case "RECORDING":
    case "RETAKE":    return "bg-red-950/80 text-red-300 border-red-700";
    case "REVIEWING": return "bg-violet-950/80 text-violet-300 border-violet-700";
    case "COMPILING": return "bg-amber-950/80 text-amber-300 border-amber-700";
    default:          return "bg-neutral-900/80 text-neutral-400 border-neutral-700";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function DwellRing({ progressMs }: { progressMs: number }) {
  const SIZE         = 56;
  const STROKE       = 3;
  const RADIUS       = (SIZE - STROKE) / 2;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const progress     = Math.min(progressMs / GESTURE_DWELL_MS, 1);
  const dashOffset   = CIRCUMFERENCE * (1 - progress);
  const isActive     = progressMs > 0;

  return (
    <svg
      width={SIZE} height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden="true"
      className={`transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-40"}`}
    >
      <circle cx={SIZE/2} cy={SIZE/2} r={RADIUS}
        fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={STROKE} />
      <circle cx={SIZE/2} cy={SIZE/2} r={RADIUS}
        fill="none"
        stroke={progress >= 1 ? "#4ade80" : "#a78bfa"}
        strokeWidth={STROKE} strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE} strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${SIZE/2} ${SIZE/2})`}
        style={{ transition: "stroke-dashoffset 80ms linear, stroke 200ms" }}
      />
      <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle"
        fontSize="16" fill={progress >= 1 ? "#4ade80" : "rgba(255,255,255,0.7)"}>
        ✋
      </text>
    </svg>
  );
}

function RecordingBadge() {
  return (
    <div role="status" aria-label="Recording in progress"
      className="flex items-center gap-1.5 rounded-full bg-red-950/80 border border-red-700 px-2.5 py-1 backdrop-blur-sm">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span className="text-xs font-semibold text-red-300 tracking-wide">REC</span>
    </div>
  );
}

function UnavailableCard() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <circle cx="20" cy="20" r="18" stroke="#ef4444" strokeWidth="1.5" />
        <path d="M14 26L26 14M14 14l12 12" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-semibold text-neutral-300">Camera unavailable</p>
      <p className="text-xs text-neutral-500 max-w-xs">
        Requires a secure (HTTPS) context and a{" "}
        <code className="font-mono text-neutral-400">getUserMedia</code>-capable browser.
      </p>
    </div>
  );
}

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
          Allow camera access in your browser&apos;s site permissions, then click Retry.
        </p>
      </div>
      <button type="button" onClick={onRetry}
        className="rounded-lg bg-neutral-800 hover:bg-neutral-700 px-4 py-2 text-xs font-semibold text-neutral-200 transition-colors">
        Retry
      </button>
    </div>
  );
}

function IdleCard({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 px-6 text-center">
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
      <button type="button" onClick={onEnable}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors">
        Enable Camera
      </button>
    </div>
  );
}

function RequestingCard() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
      <svg className="animate-spin" width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <circle cx="14" cy="14" r="11" stroke="#404040" strokeWidth="2.5" />
        <path d="M14 3a11 11 0 0 1 11 11" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <p className="text-sm text-neutral-400">Requesting camera access…</p>
      <p className="text-xs text-neutral-600">Check the permission prompt in your browser.</p>
    </div>
  );
}

/** Shown while MediaPipe WASM is loading after the stream becomes active. */
function PoseLoadingBadge() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-2 rounded-full bg-neutral-900/80 border border-neutral-700 px-3 py-1.5 backdrop-blur-sm">
        <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" stroke="#404040" strokeWidth="2" />
          <path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="text-xs text-neutral-400">Loading pose model…</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function CameraFeed() {
  const cameraAgent = useCameraAgent();

  const mode    = useCadenceStore(selectMode);
  const dwellMs = useCadenceStore(selectTargetZoneDwellMs);

  const [permission,    setPermission]    = useState<PermissionState>(() =>
    typeof window !== "undefined" && !navigator?.mediaDevices?.getUserMedia
      ? "unavailable"
      : "idle"
  );
  const [poseLoading, setPoseLoading]   = useState(false);
  const [poseReady,   setPoseReady]     = useState(false);

  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Register the stream-ready callback ──────────────────────────────────
  useEffect(() => {
    cameraAgent.setStreamReadyCallback((stream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    });
  }, [cameraAgent]);

  // ── Register the canvas draw callback ───────────────────────────────────
  // The agent calls this every pose frame with the raw landmark list.
  // We capture ctx once and reuse it; if the canvas ref disappears the
  // null-check inside the callback is a safe no-op.
  useEffect(() => {
    const tz = CameraAgent.targetZone;

    const drawCallback = (landmarks: NormalizedLandmarkList) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      drawPose(ctx, landmarks, { targetZone: tz });
    };

    cameraAgent.setCanvasDrawCallback(drawCallback);

    return () => {
      cameraAgent.setCanvasDrawCallback(null);
    };
  }, [cameraAgent]);

  // ── Keep canvas pixel dimensions in sync with the rendered video size ────
  // CSS layout width ≠ canvas.width attribute — a mismatch stretches/squishes
  // the skeleton. We use ResizeObserver on the container to stay accurate even
  // when the viewport resizes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (canvasRef.current) {
          canvasRef.current.width  = Math.round(width);
          canvasRef.current.height = Math.round(height);
        }
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── Request camera access ────────────────────────────────────────────────
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
        setPermission("denied");
      }
    }
  }, [cameraAgent]);

  // ── Initialise pose once the video is playing ────────────────────────────
  // We wire this to the video's onCanPlay event, which fires when the browser
  // has decoded enough data to start rendering frames. At that point
  // videoEl.readyState >= HAVE_CURRENT_DATA and pose.send() will succeed.
  const handleVideoCanPlay = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl || poseReady || poseLoading) return;

    // Ensure playback is running (some browsers require an explicit call).
    videoEl.play().catch(() => { /* autoplay of muted video shouldn't fail */ });

    setPoseLoading(true);
    try {
      await cameraAgent.initPose(videoEl);
      setPoseReady(true);
    } catch (err) {
      console.error("[CameraFeed] MediaPipe init failed:", err);
    } finally {
      setPoseLoading(false);
    }
  }, [cameraAgent, poseLoading, poseReady]);

  // Derived state
  const isRecording = mode === "RECORDING" || mode === "RETAKE";
  const tz          = CameraAgent.targetZone;
  const tzStyle: React.CSSProperties = {
    right:  `${(1 - tz.xMax) * 100}%`,
    top:    `${tz.yMin * 100}%`,
    width:  `${(tz.xMax - tz.xMin) * 100}%`,
    height: `${(tz.yMax - tz.yMin) * 100}%`,
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full rounded-2xl bg-neutral-900 border border-neutral-800 overflow-hidden flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1" y="4" width="14" height="10" rx="2" stroke="#a78bfa" strokeWidth="1.2" />
            <circle cx="8" cy="9" r="2.5" stroke="#a78bfa" strokeWidth="1.2" />
            <path d="M5.5 4l1-2h3l1 2" stroke="#a78bfa" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span className="text-xs font-semibold tracking-widest uppercase text-violet-400">
            Camera Agent
          </span>
        </div>

        <div className="flex items-center gap-3">
          {poseReady && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
              {/* Skeleton icon */}
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="2" r="1.5" stroke="currentColor" strokeWidth="1.1" />
                <path d="M6.5 3.5v3M4 5.5l2.5 1 2.5-1.5M4 11l2.5-2.5L9 11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
              Pose active
            </span>
          )}
          {permission === "active" && (
            <span className="flex items-center gap-1.5 text-xs text-neutral-400">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          )}
        </div>
      </div>

      {/* Permission gate cards */}
      {permission === "unavailable" && <UnavailableCard />}
      {permission === "denied"      && <DeniedCard onRetry={handleEnable} />}
      {permission === "requesting"  && <RequestingCard />}
      {permission === "idle"        && <IdleCard onEnable={handleEnable} />}

      {/* Video + canvas viewport — kept in DOM once active to avoid stream teardown */}
      <div
        ref={containerRef}
        className={[
          "relative w-full bg-black aspect-video",
          permission === "active" ? "block" : "hidden",
        ].join(" ")}
      >
        {/* Live video feed — mirrored */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Live camera feed"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: "scaleX(-1)" }}
          onCanPlay={handleVideoCanPlay}
        />

        {/* Canvas skeleton overlay — same mirror as the video */}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: "scaleX(-1)" }}
        />

        {/* Pose loading spinner (while WASM initialises) */}
        {poseLoading && <PoseLoadingBadge />}

        {/* Target Zone HUD */}
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

        {/* Recording badge */}
        <div className="absolute top-3 left-3 flex items-center gap-2">
          {isRecording && <RecordingBadge />}
        </div>

        {/* Mode chip */}
        <div className="absolute bottom-3 left-3">
          <span className={[
            "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
            "backdrop-blur-sm tracking-wide",
            modeChipStyle(mode),
          ].join(" ")}>
            {modeLabelText(mode)}
          </span>
        </div>

        {/* Dwell countdown label */}
        {dwellMs > 0 && (
          <div
            aria-live="polite"
            aria-atomic="true"
            className="absolute top-3 right-3 text-xs text-violet-300 font-semibold pointer-events-none"
            style={{ marginRight: `${(tz.xMax - tz.xMin) * 100 + 2}%` }}
          >
            {Math.ceil((GESTURE_DWELL_MS - dwellMs) / 1_000)}s
          </div>
        )}
      </div>
    </div>
  );
}
