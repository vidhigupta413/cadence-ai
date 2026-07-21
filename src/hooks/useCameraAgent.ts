/**
 * Cadence AI — useCameraAgent hook
 *
 * Creates and manages the CameraAgent singleton for the React tree.
 * Returns the stable agent instance so CameraFeed can call imperative
 * methods (requestStream, startRecording, stopRecording, onPoseLandmarks).
 *
 * Usage:
 *   const cameraAgent = useCameraAgent();
 *   await cameraAgent.requestStream();
 */

"use client";

import { useEffect, useMemo } from "react";
import { CameraAgent } from "@/agents/CameraAgent";

export function useCameraAgent(): CameraAgent {
  // Stable instance — created once per mounting component.
  const agent = useMemo(() => new CameraAgent(), []);

  useEffect(() => {
    agent.mount();
    return () => agent.unmount();
  }, [agent]);

  return agent;
}
