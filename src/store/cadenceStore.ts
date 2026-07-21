/**
 * Cadence AI — Zustand Store
 *
 * Mirrors AppState for React components that need fine-grained subscription
 * (e.g. "re-render only when segments change") without subscribing to the
 * entire DirectorAgent state object.
 *
 * THE STORE IS READ-ONLY FROM THE REACT SIDE.
 * All writes flow exclusively through DirectorAgent methods → event bus → here.
 *
 * Usage:
 *   const segments = useCadenceStore((s) => s.segments);
 *   const mode     = useCadenceStore((s) => s.mode);
 */

import { create } from "zustand";
import type { AppState, Segment } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Store shape
// ─────────────────────────────────────────────────────────────────────────────

interface CadenceStore extends AppState {
  /**
   * Called exclusively by DirectorAgentContext when a STATE_UPDATED event
   * arrives. Components must not call this directly.
   *
   * @internal
   */
  _applyPatch: (patch: Partial<AppState>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial state (mirrors AppState zero-values)
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_STATE: AppState = {
  sessionId: "",
  mode: "IDLE",
  retakeTargetId: null,
  audioLoaded: false,
  audioDuration: 0,
  audioCurrentTime: 0,
  cameraReady: false,
  poseActive: false,
  targetZoneDwellMs: 0,
  segments: [] as Segment[],
};

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

export const useCadenceStore = create<CadenceStore>()((set) => ({
  ...INITIAL_STATE,

  _applyPatch: (patch: Partial<AppState>) =>
    set((state) => ({ ...state, ...patch })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Convenience selectors (stable references — safe to use in dependency arrays)
// ─────────────────────────────────────────────────────────────────────────────

export const selectSegments = (s: CadenceStore) => s.segments;
export const selectMode = (s: CadenceStore) => s.mode;
export const selectAudioCurrentTime = (s: CadenceStore) => s.audioCurrentTime;
export const selectAudioLoaded = (s: CadenceStore) => s.audioLoaded;
export const selectAudioDuration = (s: CadenceStore) => s.audioDuration;
export const selectTargetZoneDwellMs = (s: CadenceStore) =>
  s.targetZoneDwellMs;
export const selectRetakeTargetId = (s: CadenceStore) => s.retakeTargetId;
