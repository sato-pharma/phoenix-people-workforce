// Decides when an open tab is running an older deploy than the server now serves.
//
// WHY this exists. The sidebar, the permission seeds and every client module ship inside the JS
// bundle a tab downloaded when it was opened. A deploy replaces the server but cannot reach a tab
// that is already open: soft navigations keep using the old bundle, so a tab left open across a
// merge keeps showing the old menu without a single error. `stale-deploy-recovery.ts` reloads only
// AFTER a chunk fails to load, which a healthy old tab never triggers. Measured 2026-10-04: the CEO
// kept a tab from 10:26 to 14:24 across the Awareness Approvals deploy and never saw the new row.
//
// Pure on purpose — the component only wires timers to these functions, so the decision is tested
// without a browser.

/** How often a visible tab asks the server which build it is running. */
export const REVISION_POLL_MS = 5 * 60_000;

/** A tab coming back to the foreground re-checks at once, but never more often than this. */
export const REVISION_FOCUS_MIN_GAP_MS = 30_000;

/** The `revision` field of /api/healthz, or null when absent, blank or not a string. */
export function readRevision(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const revision = (payload as { revision?: unknown }).revision;
  return typeof revision === "string" && revision.trim().length > 0 ? revision.trim() : null;
}

/**
 * True only when BOTH builds are known and differ. An unknown revision on either side (local dev,
 * a platform that stamps none) never prompts: guessing would nag every viewer on every poll.
 */
export function isNewerDeploy(loaded: string | null | undefined, live: string | null | undefined): boolean {
  const a = typeof loaded === "string" ? loaded.trim() : "";
  const b = typeof live === "string" ? live.trim() : "";
  return a.length > 0 && b.length > 0 && a !== b;
}

/** Whether a focus or visibility event should trigger a check now. */
export function shouldCheckOnFocus(lastCheckAt: number | null, now: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= REVISION_FOCUS_MIN_GAP_MS;
}
