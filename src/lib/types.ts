/**
 * Cadence AI — Core Type Definitions
 * Single source of truth for all shared interfaces.
 * Consumed by the Director Agent, Zustand store, and all agent modules.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export type AppMode =
  | "IDLE"
  | "RECORDING"
  | "REVIEWING"
  | "RETAKE"
  | "COMPILING";

export type SegmentStatus = "RECORDING" | "UPLOADING" | "READY" | "ERROR";

// ─────────────────────────────────────────────────────────────────────────────
// Kinematic / Analyst types
// ─────────────────────────────────────────────────────────────────────────────

export interface JointVelocities {
  leftWrist: number;
  rightWrist: number;
  leftElbow: number;
  rightElbow: number;
  leftShoulder: number;
  rightShoulder: number;
  leftHip: number;
  rightHip: number;
}

export interface VelocitySnapshot {
  /** Milliseconds from segment start */
  t: number;
  joints: JointVelocities;
}

export type EnergyClass = "LOW" | "MEDIUM" | "HIGH" | "EXPLOSIVE";

export interface EnergyLog {
  energyClass: EnergyClass;
  movementQuality: string;
  /** Milliseconds from segment start */
  peakTimestamp: number;
  peakJoints: (keyof JointVelocities)[];
  /** ≤ 4 words, used as timeline cue label */
  cueLabel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment
// ─────────────────────────────────────────────────────────────────────────────

export interface Segment {
  segmentId: string;
  sessionId: string;
  /** Display order in timeline (mutable via drag-and-drop) */
  index: number;
  status: SegmentStatus;

  /** Web Audio clock value at MediaRecorder.start() (seconds) */
  startTime: number;
  /** Web Audio clock value at MediaRecorder.stop() — null while recording */
  endTime: number | null;

  /** Object URL pointing to the low-res Blob in IndexedDB (available < 1 s) */
  previewUrl: string | null;
  /** S3 object key — set after Scribe upload resolves */
  s3Key: string | null;

  /** Raw velocity snapshots accumulated during this segment */
  velocitySnapshots: VelocitySnapshot[];
  /** IBM Granite energy analysis — null until Analyst resolves */
  energyLog: EnergyLog | null;

  /** Set when this segment replaced another via Punch-In */
  replacesSegmentId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// App State (Director Agent canonical state)
// ─────────────────────────────────────────────────────────────────────────────

export interface AppState {
  // Session
  sessionId: string;
  mode: AppMode;
  /** Non-null only during RETAKE — identifies the segment being replaced */
  retakeTargetId: string | null;

  // Audio Agent
  audioLoaded: boolean;
  audioDuration: number;
  audioCurrentTime: number;

  // Camera Agent
  cameraReady: boolean;
  poseActive: boolean;
  /** Live dwell counter exposed to the UI for the countdown ring (ms) */
  targetZoneDwellMs: number;

  // Timeline
  segments: Segment[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Bus payload types
// ─────────────────────────────────────────────────────────────────────────────

/** Landmark as returned by MediaPipe Pose (normalised 0–1) */
export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

// mitt v3 requires an index signature covering both string and symbol keys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CadenceEvents extends Record<string | symbol, any> {
  // Camera Agent → *
  POSE_UPDATE: { landmarks: PoseLandmark[] };
  VELOCITY_SNAPSHOT: VelocitySnapshot & { segmentId: string };
  GESTURE_CUT: { confidence: number };
  RECORDING_READY: { blob: Blob; segmentId: string };

  // Audio Agent → *
  AUDIO_TICK: { currentTime: number };
  AUDIO_ENDED: Record<string, never>;

  // Scribe Agent → *
  SCRIBE_PREVIEW_READY: { segmentId: string; previewUrl: string };
  SCRIBE_SAVED: { segmentId: string; s3Key: string };

  // Analyst Agent → *
  ANALYST_RESULT: { segmentId: string; energyLog: EnergyLog };

  // Editor Agent → *
  COMPILE_COMPLETE: { downloadUrl: string };

  // Director Agent → React UI
  STATE_UPDATED: Partial<AppState>;

  // Director Agent → all agents
  PUNCH_IN_START: { targetSegmentId: string; seekTo: number };
}
