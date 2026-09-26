/**
 * Phoenix CRM — the 06:55 digest, composed.
 *
 * Owner, 2026-09-26, choosing between four shapes: **the District Manager, at 06:55 Cairo, about the
 * previous field day.** Not the rep, not a weekly roll-up, not a live feed. He is in the car or at
 * breakfast, he has a phone, and the one thing worth his attention before the day starts is which of
 * his reps needs a call this morning.
 *
 * ## 🔴 A CLEAN MANAGER IS TOLD NOTHING
 *
 * Not "all good", not a daily tick, not an empty digest. `planPhoenixCrmDigest` returns no entry for
 * him at all. A digest that arrives every morning whatever happened is a digest people mute in a
 * week, and a muted digest is worse than none because everyone believes it is working. This is the
 * assertion the whole feature rests on and it is silent when broken — a "nothing to report" message
 * would send perfectly.
 *
 * ## It is the SAME judgement as the board, over a different window
 *
 * The kinds come from `exceptions.ts`; nothing is judged twice. What differs is deliberate and is
 * the owner's own ruling: the board reads a rolling six field days because he opens it when he has a
 * minute and wants the trend, and the digest reads THE SINGLE PREVIOUS FIELD DAY because at 06:55 he
 * wants yesterday. Two windows on purpose, one set of rules.
 *
 * ## What it may never become
 *
 * Email. The module is in-app and Telegram only, and `enforcePhoenixCrmEmailBlock` filters on the
 * module key rather than on any call site, so this file cannot opt back in even by mistake.
 */

import { EXCEPTION_KINDS, type ExceptionKind, type TerritoryException } from "@/lib/phoenix-crm/exceptions";

/** 06:55 Cairo: before the field day starts, and off every other job's minute so one red names one job. */
export const DIGEST_CRON = "55 6 * * *";
export const DIGEST_JOB_SLUG = "phoenix-crm-daily-digest";

/**
 * The most territories one message will name. Beyond this it counts the rest.
 *
 * A Telegram message a manager has to scroll is one he reads the top of. Nobody in the organogram
 * holds anything like this many, so in practice it never truncates — it is here so that a manager
 * standing in for three colleagues gets a message rather than a wall.
 */
export const DIGEST_MAX_LINES = 12;

export type DigestRecipient = {
  hrId: string;
  name: string;
  /** The territories beneath him. A manager with none is never a recipient. */
  seatIds: ReadonlyArray<string>;
};

export type PhoenixCrmDigest = {
  hrId: string;
  title: string;
  message: string;
  /** Stable per manager per day, so a second fire of the cron tells nobody twice. */
  idempotencyKey: string;
  kinds: ExceptionKind[];
};

const RANK = new Map<ExceptionKind, number>(EXCEPTION_KINDS.map((entry, index) => [entry.key, index]));

function line(row: TerritoryException): string {
  // Names, never HR codes or seat ids (owner rule). A vacant seat has no rep to name, and saying
  // "No rep" is the point of that row rather than a gap in it.
  const who = row.repName ?? "No rep";
  const detail = row.detail ? ` — ${row.detail}` : "";
  return `• ${row.territoryName} · ${who}: ${row.label}${detail}`;
}

/**
 * One digest per manager who has something to hear, and NOTHING for the rest.
 *
 * `rows` is the whole board, already judged; each manager is given the rows for the seats beneath
 * him. A row belonging to no recipient is simply not sent — the SFE's own board still has it.
 */
export function planPhoenixCrmDigest(
  rows: ReadonlyArray<TerritoryException>,
  recipients: ReadonlyArray<DigestRecipient>,
  forDay: string,
  dayLabel: string,
): PhoenixCrmDigest[] {
  const bySeat = new Map<string, TerritoryException>();
  for (const row of rows) bySeat.set(row.seatId, row);

  const digests: PhoenixCrmDigest[] = [];
  for (const manager of recipients) {
    const mine = manager.seatIds
      .flatMap((seatId) => bySeat.get(seatId) ?? [])
      .sort((left, right) => (RANK.get(left.kind) ?? 99) - (RANK.get(right.kind) ?? 99) || left.territoryName.localeCompare(right.territoryName));

    // 🔴 The whole feature. No rows, no message — not an "all good" one.
    if (mine.length === 0) continue;

    const shown = mine.slice(0, DIGEST_MAX_LINES);
    const rest = mine.length - shown.length;
    const body = shown.map(line).join("\n");
    const tail = rest > 0 ? `\n• and ${rest} more on the board.` : "";

    digests.push({
      hrId: manager.hrId,
      title: mine.length === 1 ? `1 territory needs you · ${dayLabel}` : `${mine.length} territories need you · ${dayLabel}`,
      message: `${dayLabel}\n${body}${tail}`,
      // Per manager per DAY, not per fire: the cron can be retried, replayed or fired twice by the
      // platform, and none of those may reach him a second time.
      idempotencyKey: `phoenix_crm:digest:${forDay}:${manager.hrId}`,
      kinds: [...new Set(mine.map((row) => row.kind))],
    });
  }
  return digests;
}
