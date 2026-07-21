/**
 * Cadence AI — useAudioAgent hook
 *
 * Creates and manages the AudioAgent singleton for the React tree.
 * Returns the stable agent instance so components can call imperative
 * methods (play, pause, seek) without re-render overhead.
 *
 * Mount/unmount lifecycle is tied to the component that calls this hook.
 * In practice this is the AudioPlayer component, which is rendered once
 * at the top level for the lifetime of the session.
 *
 * Usage:
 *   const audioAgent = useAudioAgent();
 *   audioAgent.play();
 *   audioAgent.seek(32.5);
 */

"use client";

import { useEffect, useMemo } from "react";
import { AudioAgent } from "@/agents/AudioAgent";

export function useAudioAgent(): AudioAgent {
  // Stable instance — created once per mounting component.
  const agent = useMemo(() => new AudioAgent(), []);

  useEffect(() => {
    agent.mount();
    return () => agent.unmount();
  }, [agent]);

  return agent;
}
