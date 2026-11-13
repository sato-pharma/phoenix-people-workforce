// The words of the Telegram half of the punch-feed alarm. Pure: no clock, no database, no sender, so
// the unit suite can read exactly what he would be sent. The sender is punch-feed-stalled-telegram.ts.

import { cairoTimestamp } from "@/lib/observability/database-restart";

/** `missedWorkingDays` at or above this means no punch was ever stored (ingestion-health.ts). */
const NEVER_INGESTED = 99;

export const PUNCH_FEED_STALLED_TITLE = "Fingerprint punches have stopped arriving";

export type PunchFeedStalledFacts = {
  /** ISO time the last punch was stored, or null when none ever was. */
  lastIngestedAt: string | null;
  /** Whole working days, through yesterday, on which no punch was stored. */
  missedWorkingDays: number;
};

export function buildPunchFeedStalledMessage(facts: PunchFeedStalledFacts): string {
  const never = facts.missedWorkingDays >= NEVER_INGESTED || !facts.lastIngestedAt;
  const days = facts.missedWorkingDays === 1 ? "1 working day" : `${facts.missedWorkingDays} working days`;
  return [
    never
      ? "No fingerprint punch has ever reached Phoenix."
      : `No fingerprint punch has reached Phoenix for ${days}.`,
    ...(never ? [] : [`The last one arrived on ${cairoTimestamp(String(facts.lastIngestedAt))}.`]),
    "",
    "Attendance is falling behind for everyone who punches at the office, and the days with no punch",
    "will read as absent until the punches arrive.",
    "",
    "The attendance agent has to be running on a computer that is on the office network.",
  ].join("\n");
}
