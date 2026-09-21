/*
 * The heap cap `scripts/dev-server.mjs` gives the Next dev server. The reason for a cap, and for this
 * number, is in the block above the spawn in that file.
 *
 * Pure on purpose, like dev-server-exit-reason.mjs: the launcher hands over its environment, this
 * decides what NODE_OPTIONS Next receives, and tests/dev-server-heap-cap.test.ts pins the decision.
 */

/** MB of V8 old space. Left to itself, Next hands its server half of RAM: 8,086 MB on the owner's 16 GB. */
export const DEFAULT_HEAP_CAP_MB = 4096;

/** A lower cap cannot compile a heavy page: /admin/approvals-hub alone peaked at 1,508 MB of heap (2026-09-21). */
export const MIN_HEAP_CAP_MB = 2048;

// Node takes the flag with dashes or underscores, and Next's own check reads both spellings.
const CALLER_SET_A_CAP = /--max[-_]old[-_]space[-_]size\b/i;

/**
 * @param {Record<string, string | undefined>} env the launcher's own environment
 * @returns {{ nodeOptions: string, note: string, warning: string | null }}
 *   nodeOptions: what Next must receive as NODE_OPTIONS ("" means send none)
 *   note: the launcher's one-line account of the choice
 *   warning: set when PHOENIX_DEV_HEAP_MB held something that could not be used
 */
export function resolveHeapCap(env) {
  const callerOptions = String(env.NODE_OPTIONS ?? "").trim();

  // A cap the caller chose is theirs; this never fights an explicit choice.
  if (CALLER_SET_A_CAP.test(callerOptions)) {
    return { nodeOptions: callerOptions, note: "heap cap from the caller's NODE_OPTIONS", warning: null };
  }

  const requested = String(env.PHOENIX_DEV_HEAP_MB ?? "").trim();
  // 0 hands the choice back to Next. Adding nothing is the whole point: any cap in NODE_OPTIONS,
  // even a huge one, stops Next applying its own half-of-RAM default.
  if (requested === "0" || requested.toLowerCase() === "off") {
    return { nodeOptions: callerOptions, note: "no heap cap (PHOENIX_DEV_HEAP_MB=0): Next takes half of RAM", warning: null };
  }

  let cap = DEFAULT_HEAP_CAP_MB;
  let warning = null;
  if (requested) {
    const value = Number(requested);
    if (Number.isInteger(value) && value >= MIN_HEAP_CAP_MB) {
      cap = value;
    } else {
      warning =
        `[dev-server] PHOENIX_DEV_HEAP_MB=${requested} ignored: it takes whole MB, ${MIN_HEAP_CAP_MB} or more, ` +
        `or 0 for no cap. Using ${DEFAULT_HEAP_CAP_MB}.`;
    }
  }

  return {
    nodeOptions: [callerOptions, `--max-old-space-size=${cap}`].filter(Boolean).join(" "),
    note: `heap cap ${cap} MB`,
    warning,
  };
}
