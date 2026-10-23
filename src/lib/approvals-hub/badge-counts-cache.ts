import type { AccessContext } from "@/lib/auth/permissions";
import { sharedReadKey } from "@/lib/cache/shared-read";

/**
 * A per-viewer, twenty-second memory of the batched sidebar badge counts
 * (/api/approvals/badge-counts) — 2026-10-23, every page change under 1 second.
 *
 * WHY. Every open tab of every signed-in person polls that endpoint every 30 s, and every portal page
 * change mounts the chrome again and asks at once. Production on 2026-10-23 recorded 141 calls in about
 * 27 minutes costing 226 s of server time — about 1.6 s each, eleven domain reads per call — and most
 * of them were the same person asking again within seconds (a second tab, a page change, a tab shown
 * again) for numbers that had not moved. A badge is a nudge, not a ledger: the page it links to always
 * reads live, and a count up to 20 s old is invisible next to a 30 s poll.
 *
 * THE RULES THAT KEEP IT SAFE.
 *   • NEVER SHARED ACROSS VIEWERS. The key is the viewer's WHOLE access context — HR id, login id,
 *     role, scope, source, and the test-persona and View as Seat links when present — so two people,
 *     one person in two roles, and the owner viewing a seat each get their own entry. Every badge read
 *     takes nothing but that context, so the key holds everything that can change the answer.
 *   • ONLY A SIGNED-IN VIEWER IS REMEMBERED. A guest, a system context, or a context with no identity
 *     at all is computed every time and never stored.
 *   • NEVER A FAILED READ. A response is stored only when every domain either answered or was refused
 *     by a permission guard (isForbiddenError in the route) — a refusal is the viewer's standing, the
 *     same answer every time, and five of the eleven domains refuse most seats by design. Any other
 *     rejection, and any domain that reports `available: false` (the plan, leave and excuse badges do
 *     on a failed read), keeps that response out of the memory, so the next poll asks again.
 *   • THE AGE RUNS FROM THE START OF THE READ, so a remembered count is never more than 20 s older
 *     than the data it was read from.
 *   • ONE READ AT A TIME PER VIEWER. Two tabs asking together share one read instead of running two.
 *   • BOUNDED. At most BADGE_COUNTS_CACHE_MAX_ENTRIES viewers are held; the oldest go first.
 *
 * WHAT IT COSTS. A request the viewer just decided can stay on the badge for up to 20 s after the
 * decision (no write path clears this memory; the TTL is the backstop). The page itself reads live.
 *
 * In-process on purpose: each server instance keeps its own small map, exactly like the permission
 * matrix cache. Pinned by tests/badge-counts-viewer-cache.test.ts.
 */
export const BADGE_COUNTS_CACHE_TTL_MS = 20_000;
export const BADGE_COUNTS_CACHE_MAX_ENTRIES = 500;

/** What the route's inline read hands back: the response body, and whether it may be remembered. */
export type BadgeCountsComputation<Body> = { body: Body; cacheable: boolean };

/** How a response was served — the route records each outcome under its own timing name. */
export type BadgeCountsServed<Body> = { body: Body; cache: "hit" | "miss" | "joined" | "bypass" };

type Entry = { storedAt: number; body: unknown };

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<BadgeCountsComputation<unknown>>>();

/**
 * The memory key for this viewer, or null when the viewer must never be remembered. The whole
 * context goes into the key (sharedReadKey sorts it, so field order cannot split one viewer in two).
 */
export function badgeCountsViewerKey(access: AccessContext): string | null {
  if (access.source !== "session" && access.source !== "dev-header") return null;
  if (!access.hrId && !access.loginId) return null;
  return `badge-counts:${sharedReadKey(access)}`;
}

/**
 * True when a settled set of domain reads may be remembered: every rejection is a permission refusal
 * (`isRefusal`), and no answered domain says its own read failed (`available: false`).
 */
export function badgeCountsAreCacheable(
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
  isRefusal: (reason: unknown) => boolean,
): boolean {
  for (const result of results) {
    if (result.status === "rejected") {
      if (!isRefusal(result.reason)) return false;
      continue;
    }
    const value = result.value;
    if (value && typeof value === "object" && (value as { available?: unknown }).available === false) return false;
  }
  return true;
}

/**
 * Serves one viewer's badge counts: the remembered response while it is under 20 s old, the read
 * already running for this viewer if there is one, or a fresh read — stored only when `cacheable`.
 */
export async function serveViewerBadgeCounts<Body>(
  key: string | null,
  compute: () => Promise<BadgeCountsComputation<Body>>,
  now: () => number = Date.now,
): Promise<BadgeCountsServed<Body>> {
  if (key === null) {
    const { body } = await compute();
    return { body, cache: "bypass" };
  }

  const remembered = entries.get(key);
  if (remembered) {
    if (now() - remembered.storedAt < BADGE_COUNTS_CACHE_TTL_MS) {
      return { body: remembered.body as Body, cache: "hit" };
    }
    entries.delete(key);
  }

  const running = inFlight.get(key);
  if (running) {
    const { body } = await running;
    return { body: body as Body, cache: "joined" };
  }

  const startedAt = now();
  const read = compute();
  inFlight.set(key, read as Promise<BadgeCountsComputation<unknown>>);
  try {
    const result = await read;
    if (result.cacheable) remember(key, startedAt, result.body, now());
    return { body: result.body, cache: "miss" };
  } finally {
    // Only the read that is still registered is removed — never a newer one for the same viewer.
    if (inFlight.get(key) === read) inFlight.delete(key);
  }
}

function remember(key: string, storedAt: number, body: unknown, at: number): void {
  entries.delete(key);
  entries.set(key, { storedAt, body });
  // Expired entries at the front go first, then the oldest past the cap. Insertion order is age order
  // to within one read's length, which is all a bound on memory needs.
  for (const [oldestKey, oldest] of entries) {
    if (entries.size <= BADGE_COUNTS_CACHE_MAX_ENTRIES && at - oldest.storedAt < BADGE_COUNTS_CACHE_TTL_MS) break;
    entries.delete(oldestKey);
  }
}

/** Test-only: forget every remembered viewer and every running read. */
export function _resetBadgeCountsCache(): void {
  entries.clear();
  inFlight.clear();
}

/** Test-only: how many viewers are remembered right now. */
export function _badgeCountsCacheSize(): number {
  return entries.size;
}
