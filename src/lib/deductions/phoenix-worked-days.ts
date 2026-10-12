/**
 * THE ONE SUPPRESSOR EVERY DEDUCTION CONNECTOR CONSULTS: days Phoenix CRM proves were worked.
 *
 * Owner, 2026-10-12: "you must also check the phoenix crm before deciding a deduction, check every
 * source throughout everywhere to confirm u give acurate data bec this is people money its a
 * deduction."
 *
 * The defect this closes, measured on production the same day: `crm_visits_unified`'s Phoenix
 * branches are inner-joined to the STARTED teams, so a rep whose team the Super Admin has not
 * pressed Start on logs real visits that reach no deduction reader at all. 7–12 October: 121 visits,
 * 6 Medical Reps, 17 person-days, every one of those days carrying 0 iReports360 rows — 14 days and
 * 7,193.54 EGP that the zero-signal guard did not catch. Nothing had been charged yet.
 *
 * ## The two rules this helper exists to keep
 *
 *   1. **It only ever REMOVES a day.** It is read where a connector has already decided to charge,
 *      never where one decides whether a person has any signal at all. Feeding a zero-signal guard
 *      (`anySignal` in dsm-no-record, `hasAnySignalThisMonth` in holiday-bridge,
 *      `firstSignalByPerson` in half-day) would turn a mapping-gap SKIP into a charge — the opposite
 *      of the point.
 *   2. **It changes nothing that is COUNTED.** No call rate, coverage figure or KPI reads from here;
 *      the started-team rule and every counted number are untouched. See
 *      `src/lib/crm/phoenix-work-evidence.ts` for why that separation is the whole design.
 *
 * Keys are `${compactDeductionsHrId}:${date}` — the convention every connector's own day maps
 * already use, so a suppression lookup sits beside an activity lookup with no re-keying.
 *
 * FAILS CLOSED: the loader throws, and no caller may swallow it. A silent failure here charges a day
 * someone provably worked.
 */

import {
  loadPhoenixWorkEvidenceDays,
  phoenixWorkEvidenceProvesWorkedDay,
  describePhoenixWorkEvidence,
  type PhoenixWorkEvidenceDay,
} from "@/lib/crm/phoenix-work-evidence";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";

/** `${compact}:${date}`, or null when the hr id does not resolve. */
export function phoenixWorkedDayKey(hrId: string | null | undefined, date: string): string | null {
  const compact = compactDeductionsHrId(hrId ?? "");
  return compact ? `${compact}:${date}` : null;
}

export type PhoenixWorkedDays = {
  /** `${compact}:${date}` for every day Phoenix CRM PROVES was worked — a visit or a day activity. */
  keys: ReadonlySet<string>;
  /** The same days' evidence, for the reason line a reviewer reads. A day start alone appears here. */
  evidence: ReadonlyMap<string, PhoenixWorkEvidenceDay>;
};

/** Fold loaded evidence into compact-keyed suppression. Pure, so the keying is pinned by a test. */
export function selectPhoenixWorkedDays(days: readonly PhoenixWorkEvidenceDay[]): PhoenixWorkedDays {
  const keys = new Set<string>();
  const evidence = new Map<string, PhoenixWorkEvidenceDay>();
  for (const day of days) {
    const key = phoenixWorkedDayKey(day.hrId, day.date);
    if (!key) continue;
    const merged = evidence.get(key);
    if (!merged) {
      evidence.set(key, { ...day, dayActivities: [...day.dayActivities] });
    } else {
      // Two stored spellings of one hr id compact onto one key — add them up rather than letting the
      // second replace the first and lose its visits.
      merged.visits += day.visits;
      merged.dayStarts += day.dayStarts;
      for (const label of day.dayActivities) {
        if (!merged.dayActivities.includes(label)) merged.dayActivities.push(label);
      }
    }
  }
  for (const [key, day] of evidence) {
    if (phoenixWorkEvidenceProvesWorkedDay(day)) keys.add(key);
  }
  return { evidence, keys };
}

/** Every Phoenix-CRM-proven worked day in the window, keyed for the deduction connectors. */
export async function loadPhoenixWorkedDays(input: { end: string; start: string }): Promise<PhoenixWorkedDays> {
  return selectPhoenixWorkedDays(await loadPhoenixWorkEvidenceDays(input));
}

/** The reason line a suppressed day carries into a connector's evidence, or null when there is none. */
export function phoenixWorkedDayReason(worked: PhoenixWorkedDays, key: string): string | null {
  const day = worked.evidence.get(key);
  return day ? describePhoenixWorkEvidence(day) : null;
}
