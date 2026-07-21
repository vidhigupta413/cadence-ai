/**
 * Cadence AI — Pose Renderer
 *
 * Pure canvas-drawing utilities. No React, no agents, no imports.
 * Takes a CanvasRenderingContext2D and a landmark array and draws the
 * full 33-point skeleton: connections first, then landmark dots on top.
 *
 * Drawing is mirrored (scaleX(-1)) to match the mirrored <video> element —
 * we flip the canvas transform rather than re-mapping every x coordinate.
 *
 * Colour scheme:
 *   Left-side  joints/bones  → violet  (#a78bfa)
 *   Right-side joints/bones  → sky     (#38bdf8)
 *   Neutral    joints/bones  → white   (#ffffff)
 *   Low-visibility joints    → 50% opacity
 *   Wrist in Target Zone     → green   (#4ade80) with glow
 */

import type { NormalizedLandmarkList } from "@mediapipe/pose";

// POSE_CONNECTIONS inlined to avoid a static import of the Closure-compiled
// @mediapipe/pose IIFE which has no ES module named exports.
// Source: https://google.github.io/mediapipe/solutions/pose.html#pose-landmark-model
const POSE_CONNECTIONS: Array<[number, number]> = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],
  [11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  [11,23],[12,24],[23,24],
  [23,25],[24,26],[25,27],[26,28],
  [27,29],[28,30],[29,31],[30,32],[27,31],[28,32],
];

// ─────────────────────────────────────────────────────────────────────────────
// Colour palette
// ─────────────────────────────────────────────────────────────────────────────

const COLOUR = {
  left:    "#a78bfa", // violet-400
  right:   "#38bdf8", // sky-400
  neutral: "#ffffff",
  active:  "#4ade80", // green-400 — wrist in Target Zone
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Landmark side classification
// Index ranges from @mediapipe/pose POSE_LANDMARKS_LEFT / RIGHT
// ─────────────────────────────────────────────────────────────────────────────

// MediaPipe body landmark parity (indices 11–32):
//   ODD  indices → LEFT  side: 11(L_shoulder), 13(L_elbow), 15(L_wrist)…
//   EVEN indices → RIGHT side: 12(R_shoulder), 14(R_elbow), 16(R_wrist)…
// Face landmarks (0–10) are treated as neutral.
function landmarkSide(idx: number): "left" | "right" | "neutral" {
  if (idx < 11) return "neutral";
  return idx % 2 === 1 ? "left" : "right";
}

function connectionColour(startIdx: number, endIdx: number): string {
  const s = landmarkSide(startIdx);
  const e = landmarkSide(endIdx);
  if (s === e && s !== "neutral") return COLOUR[s];
  return COLOUR.neutral;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrist indices (used for Target Zone highlight)
// ─────────────────────────────────────────────────────────────────────────────

const LEFT_WRIST_IDX  = 15;
const RIGHT_WRIST_IDX = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Public draw function
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawPoseOptions {
  /**
   * Target Zone in normalised [0,1] coords.
   * Wrists inside this zone are drawn in green with a glow.
   */
  targetZone: { xMin: number; xMax: number; yMin: number; yMax: number };
  /** Minimum visibility score to draw a landmark/connection (0–1). */
  minVisibility?: number;
}

/**
 * Clears the canvas and draws the full pose skeleton for one frame.
 *
 * The canvas transform is flipped on the X axis so the skeleton mirrors
 * the <video> element (which uses `transform: scaleX(-1)`).
 *
 * @param ctx      - 2D context of the overlay canvas.
 * @param landmarks - Normalised landmark list from MediaPipe Results.
 * @param opts      - Drawing configuration.
 */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmarkList,
  opts: DrawPoseOptions,
): void {
  const { targetZone, minVisibility = 0.5 } = opts;
  const { width, height } = ctx.canvas;

  // Clear previous frame.
  ctx.clearRect(0, 0, width, height);

  if (!landmarks || landmarks.length === 0) return;

  // No internal mirror transform needed: the <canvas> element itself carries
  // `transform: scaleX(-1)` in CSS (matching the mirrored <video>), so
  // landmark x-coords from MediaPipe map directly to canvas pixel space.

  // ── Helper: normalised → pixel ─────────────────────────────────────────────
  const px = (x: number) => x * width;
  const py = (y: number) => y * height;

  // Pre-compute which wrists are in the Target Zone.
  const wristActive = new Set<number>();
  for (const idx of [LEFT_WRIST_IDX, RIGHT_WRIST_IDX]) {
    const lm = landmarks[idx];
    if (!lm || (lm.visibility ?? 1) < minVisibility) continue;
    if (
      lm.x >= targetZone.xMin && lm.x <= targetZone.xMax &&
      lm.y >= targetZone.yMin && lm.y <= targetZone.yMax
    ) {
      wristActive.add(idx);
    }
  }

  // ── 1. Draw bone connections ───────────────────────────────────────────────
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";

  for (const [startIdx, endIdx] of POSE_CONNECTIONS) {
    const a = landmarks[startIdx];
    const b = landmarks[endIdx];
    if (!a || !b) continue;

    const vis = Math.min(a.visibility ?? 1, b.visibility ?? 1);
    if (vis < minVisibility) continue;

    const isActive =
      wristActive.has(startIdx) || wristActive.has(endIdx);

    ctx.globalAlpha = isActive ? 1 : Math.max(0.3, vis);
    ctx.strokeStyle = isActive ? COLOUR.active : connectionColour(startIdx, endIdx);
    ctx.beginPath();
    ctx.moveTo(px(a.x), py(a.y));
    ctx.lineTo(px(b.x), py(b.y));
    ctx.stroke();
  }

  // ── 2. Draw landmark dots ──────────────────────────────────────────────────
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!lm) continue;

    const vis = lm.visibility ?? 1;
    if (vis < minVisibility) continue;

    const isWrist  = i === LEFT_WRIST_IDX || i === RIGHT_WRIST_IDX;
    const isActive = wristActive.has(i);
    const radius   = isWrist ? 6 : 4;

    ctx.globalAlpha = isActive ? 1 : Math.max(0.35, vis);

    // Glow effect for active wrists.
    if (isActive) {
      ctx.shadowColor = COLOUR.active;
      ctx.shadowBlur  = 14;
    } else {
      ctx.shadowBlur = 0;
    }

    const colour = isActive
      ? COLOUR.active
      : COLOUR[landmarkSide(i)];

    // Outer ring.
    ctx.strokeStyle = colour;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(px(lm.x), py(lm.y), radius, 0, Math.PI * 2);
    ctx.stroke();

    // Filled centre.
    ctx.fillStyle = colour;
    ctx.globalAlpha *= 0.7;
    ctx.beginPath();
    ctx.arc(px(lm.x), py(lm.y), radius - 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Reset shadow after wrist.
    if (isActive) ctx.shadowBlur = 0;
  }

  ctx.globalAlpha = 1;
}
