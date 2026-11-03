/**
 * The Approvals hub's one line about the Marketing inbox (owner, 2026-11-03).
 *
 * Marketing keeps its own inbox, by his own repeated order, so the hub never lists its requests and
 * nothing is decided from it. It only says how much is waiting there and for how long, and links
 * across. Pure, so a test can drive the wording without a database.
 */

export type MarketingInboxWaiting = {
  count: number;
  /** Whole days since the oldest waiting request was submitted. Null when none carries a submission date. */
  oldestDays: number | null;
};

/** `count` is the caller's, the same gating-step count the sidebar badge shows, so the two never disagree. */
export function summarizeMarketingInboxWaiting(input: {
  count: number;
  nowIso: string;
  submittedAt: ReadonlyArray<string | null | undefined>;
}): MarketingInboxWaiting {
  const now = Date.parse(input.nowIso);
  let oldestDays: number | null = null;
  for (const value of input.submittedAt) {
    const since = value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(since) || !Number.isFinite(now)) continue;
    const days = Math.max(0, Math.floor((now - since) / 86_400_000));
    if (oldestDays === null || days > oldestDays) oldestDays = days;
  }
  return { count: input.count, oldestDays };
}

/** The link's words. A failed read says so: a missing line would read as an empty inbox. */
export function marketingInboxWaitingLabel(waiting: MarketingInboxWaiting | null): string | null {
  if (!waiting) return "Marketing inbox · could not be read";
  if (waiting.count <= 0) return null;
  if (waiting.oldestDays === null) return `Marketing inbox · ${waiting.count} waiting`;
  const days = waiting.oldestDays === 1 ? "1 day" : `${waiting.oldestDays} days`;
  return `Marketing inbox · ${waiting.count} waiting · oldest ${days}`;
}
