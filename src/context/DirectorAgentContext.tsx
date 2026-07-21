/**
 * Cadence AI — Director Agent Context
 *
 * Provides a single DirectorAgent instance to the entire React tree.
 * - Mounts the agent (subscribes to the event bus) on first render.
 * - Forwards every STATE_UPDATED event into the Zustand store.
 * - Unmounts the agent (removes all listeners) on tree teardown.
 *
 * Wrap your root layout with <DirectorAgentProvider> once.
 * Access the agent instance via useDirectorAgent() in any component.
 */

"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { DirectorAgent } from "@/agents/DirectorAgent";
import { eventBus } from "@/lib/eventBus";
import { useCadenceStore } from "@/store/cadenceStore";
import type { AppState } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

const DirectorAgentContext = createContext<DirectorAgent | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

interface DirectorAgentProviderProps {
  children: ReactNode;
}

export function DirectorAgentProvider({
  children,
}: DirectorAgentProviderProps) {
  // Stable instance — never recreated across re-renders.
  const director = useMemo(() => new DirectorAgent(), []);

  // Pull the Zustand setter so we can forward state patches from the event bus.
  const applyPatch = useCadenceStore((s) => s._applyPatch);

  useEffect(() => {
    // 1. Mount the agent — registers all event-bus listeners.
    director.mount();

    // 2. Seed the Zustand store with the director's initial state so
    //    components that render before the first STATE_UPDATED still see
    //    a valid (non-empty) sessionId and mode.
    applyPatch(director.getState() as AppState);

    // 3. Forward every STATE_UPDATED patch from the event bus into Zustand.
    //    Zustand's shallow merge means only subscribers of changed slices
    //    will re-render.
    const handleStateUpdated = (patch: Partial<AppState>) => {
      applyPatch(patch);
    };
    eventBus.on("STATE_UPDATED", handleStateUpdated);

    return () => {
      // Cleanup on tree unmount (e.g. HMR, test teardown).
      director.unmount();
      eventBus.off("STATE_UPDATED", handleStateUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [director]); // applyPatch is stable; director is stable

  return (
    <DirectorAgentContext.Provider value={director}>
      {children}
    </DirectorAgentContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook — access the DirectorAgent instance directly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the DirectorAgent singleton mounted for this React tree.
 *
 * Use this when you need to call imperative methods such as:
 *   director.triggerPunchIn(segmentId)
 *   director.reorderSegments(orderedIds)
 *
 * For reactive state, use useCadenceStore() selectors instead.
 *
 * @throws if called outside of <DirectorAgentProvider>
 */
export function useDirectorAgent(): DirectorAgent {
  const agent = useContext(DirectorAgentContext);
  if (!agent) {
    throw new Error(
      "useDirectorAgent must be called inside <DirectorAgentProvider>. " +
        "Make sure your root layout wraps children with DirectorAgentProvider."
    );
  }
  return agent;
}
