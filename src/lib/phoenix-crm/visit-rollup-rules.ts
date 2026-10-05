/**
 * Phoenix CRM — the hourly routine-visit rollup, composed.
 *
 * Owner, 2026-10-05: "in nsm and sfe i want every single action that happens on Phoenix CRM by their
 * scope to be sent to telegram to them." The live mirror (`server/notifications.ts`) sends every
 * WORKFLOW action as it happens. Routine PLANNED visits are different only in volume — about 600 a
 * working day — so sending one notice each would be a firehose that is muted in a day. The owner
 * chose, between "live everything" and "live + a visit rollup", the second: routine planned visits
 * are BATCHED into one hourly message per in-scope manager instead of one per visit.
 *
 * ## 🔴 A QUIET HOUR TELLS NOBODY
 *
 * A manager with no routine visits in his scope this hour gets NO message — not an "all clear", not an
 * hourly tick. `planPhoenixCrmVisitRollup` returns no entry for him. Overnight, when nothing is
 * logged, nobody is messaged at all. A notice that arrives every hour whatever happened is one people
 * mute inside a day, and a muted feed is worse than none — the same rule the 06:55 digest rests on.
 *
 * ## Who hears it, and over what scope
 *
 * The same two readers as the live mirror: the NATIONAL SALES MANAGER in the rep's chain, about the
 * visits beneath HIM; and every SFE MANAGER, about every routine visit in the hour (the SFE role has
 * no organogram seat and watches the whole field). The rep never hears it — Golden Rule #1.
 *
 * ## What it may never become
 *
 * Email or the phone. Its event type is on `PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES`, so email is barred
 * by the module guard and push is barred too — in-app and Telegram only, exactly like the digest and
 * the mirror.
 */

import { managerChain, personKey, territoryName, type OrgIndex } from "@/lib/phoenix-crm/scope";

/** On :49 — an odd minute no other hourly job holds (inbound-intake takes every even minute). */
export const VISIT_ROLLUP_CRON = "49 * * * *";
export const VISIT_ROLLUP_JOB_SLUG = "phoenix-crm-visit-rollup";
export const VISIT_ROLLUP_EVENT_TYPE = "crm_visit_rollup";

/**
 * The most reps one message will name before it counts the rest. A Telegram message a manager has to
 * scroll is one he reads the top of; beyond this the tail becomes "and N more reps".
 */
export const VISIT_ROLLUP_MAX_LINES = 15;

/** One routine planned visit, reduced to the two things the rollup names: the rep and his territory. */
export type RollupVisitFact = {
  repName: string;
  territoryName: string;
};

/** A manager and the routine visits in HIS scope this hour. A manager with none is never a recipient. */
export type RollupRecipient = {
  hrId: string;
  name: string;
  visits: ReadonlyArray<RollupVisitFact>;
};

export type PhoenixCrmVisitRollup = {
  hrId: string;
  title: string;
  message: string;
  /** Stable per manager per HOUR, so a retried or double-fired cron tells nobody twice. */
  idempotencyKey: string;
};

/** A visit as the runner hands it in — just what is needed to place it in a scope and name it. */
export type RollupVisitRow = {
  seatId: string | null | undefined;
  repHrId: string | null | undefined;
};

/**
 * Group the hour's routine visits into one bundle per in-scope manager — pure, so it is unit-tested
 * without a database (the Phase-1 mirror is tested the same way).
 *
 * The NATIONAL SALES MANAGER in each rep's chain gets the visits beneath him; every SFE MANAGER gets
 * every visit in the hour. A visit whose seat is not in the organogram is skipped here — it cannot be
 * placed in a scope, and the board still carries it. If one person is both an NSM and an SFE Manager
 * (not the normal shape), the company-wide SFE bundle supersedes his narrower NSM one, so he is told
 * once.
 */
export function buildVisitRollupRecipients(
  visits: ReadonlyArray<RollupVisitRow>,
  org: OrgIndex,
  names: (hrId: string | null | undefined) => string,
  sfeHrIds: ReadonlyArray<string>,
): RollupRecipient[] {
  const sfeKeys = new Set(sfeHrIds.map((hrId) => personKey(hrId)).filter((key): key is string => key !== null));
  const nsmFacts = new Map<string, RollupVisitFact[]>();
  const nsmHrIdByKey = new Map<string, string>();
  const allFacts: RollupVisitFact[] = [];

  for (const visit of visits) {
    const seat = visit.seatId ? org.seats.get(visit.seatId) : undefined;
    if (!seat) continue;
    const fact: RollupVisitFact = { repName: names(visit.repHrId), territoryName: territoryName(seat) };
    allFacts.push(fact);

    const nsmHrId = managerChain(org, seat.seatId).find((member) => member.seat.tier === "NSM")?.hrId ?? null;
    const nsmKey = personKey(nsmHrId);
    if (nsmKey && nsmHrId) {
      nsmHrIdByKey.set(nsmKey, nsmHrId);
      const bundle = nsmFacts.get(nsmKey) ?? [];
      bundle.push(fact);
      nsmFacts.set(nsmKey, bundle);
    }
  }

  const recipients: RollupRecipient[] = [];
  for (const [nsmKey, facts] of nsmFacts) {
    // An NSM who is also an SFE Manager hears the wider company bundle instead, never both.
    if (sfeKeys.has(nsmKey)) continue;
    const hrId = nsmHrIdByKey.get(nsmKey);
    if (hrId) recipients.push({ hrId, name: names(hrId), visits: facts });
  }
  for (const hrId of sfeHrIds) {
    recipients.push({ hrId, name: names(hrId), visits: allFacts });
  }
  return recipients;
}

/**
 * One rollup per manager who has something to hear, and NOTHING for the rest. `windowLabel` is the
 * Cairo hour range ("1:00 PM–2:00 PM"); `hourBucket` is the stable per-hour key the idempotency uses.
 */
export function planPhoenixCrmVisitRollup(
  recipients: ReadonlyArray<RollupRecipient>,
  windowLabel: string,
  hourBucket: string,
): PhoenixCrmVisitRollup[] {
  const rollups: PhoenixCrmVisitRollup[] = [];
  for (const manager of recipients) {
    // 🔴 The whole feature. No visits in scope this hour, no message — not an "all clear" one.
    if (manager.visits.length === 0) continue;

    const byRep = new Map<string, { repName: string; territoryName: string; count: number }>();
    for (const visit of manager.visits) {
      const key = `${visit.repName}\u0000${visit.territoryName}`;
      const entry = byRep.get(key) ?? { repName: visit.repName, territoryName: visit.territoryName, count: 0 };
      entry.count += 1;
      byRep.set(key, entry);
    }

    const rows = [...byRep.values()].sort(
      (left, right) => right.count - left.count || left.repName.localeCompare(right.repName),
    );
    const total = manager.visits.length;
    const shown = rows.slice(0, VISIT_ROLLUP_MAX_LINES);
    const rest = rows.length - shown.length;
    const body = shown
      .map((row) => `• ${row.repName} · ${row.territoryName} — ${row.count} ${row.count === 1 ? "visit" : "visits"}`)
      .join("\n");
    const tail = rest > 0 ? `\n• and ${rest} more rep${rest === 1 ? "" : "s"}.` : "";

    rollups.push({
      hrId: manager.hrId,
      title: `${total} routine ${total === 1 ? "visit" : "visits"} · ${windowLabel}`,
      message:
        `${total} routine planned ${total === 1 ? "visit" : "visits"} from ${rows.length} ` +
        `rep${rows.length === 1 ? "" : "s"}, ${windowLabel} Cairo:\n${body}${tail}`,
      // Per manager per HOUR, not per fire: a retry or a double fire of the cron reaches nobody twice.
      idempotencyKey: `phoenix_crm:visit_rollup:${manager.hrId}:${hourBucket}`,
    });
  }
  return rollups;
}
