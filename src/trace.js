// Live trace of what happens behind each chat message, for the "Behind the scenes" panel.
//
// Steps are streamed to the browser as SSE events next to the chat events:
//   { type: "trace", id, phase: "start" | "end" | "point", kind, title, detail, ms }
// kind is one of: request (browser -> backend), llm, tool (MCP call), confirm, upload.
// Set SHOW_FLOW=false to turn the trace (and the panel) off, e.g. for real customers:
// the details include tool arguments and results.

export const SHOW_FLOW = (process.env.SHOW_FLOW ?? "true").toLowerCase() !== "false";
const MAX_TEXT = 4000;

let seq = 0;

/** A tracer that sends steps through `emit`. */
export function tracer(emit) {
  return {
    /** Starts a step; call .end(detail) when it finishes. */
    start(kind, title, detail) {
      const id = ++seq;
      const t0 = performance.now();
      emit({ type: "trace", id, phase: "start", kind, title, detail });
      return {
        end: (extra = {}) => emit({ type: "trace", id, phase: "end", kind, ms: Math.round(performance.now() - t0), detail: extra }),
      };
    },
    /** A step with no duration. */
    point(kind, title, detail) {
      emit({ type: "trace", id: ++seq, phase: "point", kind, title, detail });
    },
  };
}

/** Used outside a chat turn, or when SHOW_FLOW is off. */
export const noTrace = { start: () => ({ end() {} }), point() {} };

/** Shortens long tool results so the panel stays readable. */
export function clip(text) {
  if (typeof text !== "string" || text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}… (${text.length - MAX_TEXT} more characters)`;
}
