/**
 * Cadence AI — Typed Event Bus
 *
 * A single mitt-backed singleton that every agent uses to communicate.
 * No agent holds a direct reference to any other — this bus is the
 * only coupling surface between agents.
 *
 * Usage:
 *   import { eventBus } from "@/lib/eventBus";
 *   eventBus.emit("GESTURE_CUT", { confidence: 0.97 });
 *   eventBus.on("GESTURE_CUT", ({ confidence }) => { ... });
 *   eventBus.off("GESTURE_CUT", handler);
 */

import mitt from "mitt";
import type { CadenceEvents } from "@/lib/types";

// Typed singleton — one instance for the lifetime of the browser tab.
export const eventBus = mitt<CadenceEvents>();
