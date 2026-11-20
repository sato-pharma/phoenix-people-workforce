/*
 * How many compiled pages the dev server keeps, and for how long. DEV ONLY, and OFF unless asked.
 *
 * WHY (owner, 2026-11-20: "I want the dev server to be super fast"). `next dev` throws away a compiled
 * page once nobody has opened it for 60 s, unless it is one of the 5 most recently opened
 * (next/dist/server/dev/on-demand-entry-handler.js, disposeInactiveEntries; the defaults are in
 * next/dist/server/config-shared.js, onDemandEntries). The spare laptop's start-up warm-up compiles six
 * pages, so by the time anyone opens the sixth the first is already gone and recompiles from cold.
 *
 * Two switches, read only by next.config.ts and only outside production:
 *   PHOENIX_DEV_PAGES_KEPT=<n>          the recently opened pages that are never thrown away (Next: 5)
 *   PHOENIX_DEV_PAGE_IDLE_MINUTES=<m>   how long any other page lives unopened (Next: 1 minute)
 * Neither set: null, and Next keeps its own defaults. Keeping more pages costs heap, so the spare's
 * 4 GB server holds about eight (measured 2026-11-20); never set this on a box without measuring it.
 * Pinned by tests/dev-server-page-retention.test.ts.
 */

export const NEXT_DEFAULT_PAGES_KEPT = 5;
export const NEXT_DEFAULT_IDLE_MS = 60_000;

/** A whole number in [min, max], or null for anything else (unset, blank, words, 0, negative). */
function readWhole(raw, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ pagesBufferLength: number, maxInactiveAge: number } | null}
 */
export function resolvePageRetention(env = process.env) {
  const kept = readWhole(env.PHOENIX_DEV_PAGES_KEPT, 1, 50);
  const idleMinutes = readWhole(env.PHOENIX_DEV_PAGE_IDLE_MINUTES, 1, 24 * 60);
  if (kept === null && idleMinutes === null) return null;
  // Both fields every time: Next validates the object strictly and a half-set one would lean on how
  // it merges defaults, which has changed between versions.
  return {
    pagesBufferLength: kept ?? NEXT_DEFAULT_PAGES_KEPT,
    maxInactiveAge: idleMinutes === null ? NEXT_DEFAULT_IDLE_MS : idleMinutes * 60_000,
  };
}
