/**
 * Rep Doctor Lists — each medical rep's ASSIGNED doctor list from the CRM, and how much of it they
 * actually saw.
 *
 * WHAT THIS ADDS THAT DOCTOR COVERAGE CANNOT. sfe-doctor-coverage.ts builds its panel from visit
 * HISTORY: a contact enters the board because someone visited it. A doctor who sits on a rep's list
 * and is never visited therefore has no row anywhere in Phoenix and is invisible to that board by
 * construction — which is precisely the population a coverage question is about. Measured live
 * 2026-08-21 for 1-21 August: of 7,085 planned rep-to-doctor pairs, 2,941 (42%) had no visit at all.
 * Those 2,941 are the rows this module exists to show.
 *
 * The two boards therefore answer different questions and are both correct:
 *   Doctor Coverage  — of the doctors we DID see, who is short of their visit norm?
 *   Rep Doctor Lists — of the doctors we were SUPPOSED to see, who did we never reach?
 *
 * THE TWO KPIs THIS BOARD REPORTS (owner's definitions, 2026-08-21).
 *
 *   COVERAGE   = visitedDoctors / plannedDoctors. Did the rep touch the doctor AT ALL this month?
 *                Grade is irrelevant; one visit is enough. 100 on the list, 80 seen = 80%.
 *                This is the number that shipped as `adherencePct` in #2259 — renamed here,
 *                because "adherence" is the owner's word for the OTHER KPI and the collision
 *                would have been permanent.
 *
 *   FREQUENCY  = onPlanDoctors / plannedDoctors. Did the rep visit each doctor the number of
 *                times HIS OWN PLAN asked for? Planned 3 and did 3 is the only pass.
 *                **Both directions are deviations** — 3 planned / 2 done is `under`, 3 planned /
 *                4 done is `over`. That is the owner's rule verbatim and is why this cannot be
 *                expressed as a met-or-exceeded ratio.
 *
 * SCORED AGAINST THE PLAN, NEVER AGAINST THE GRADE. The convention is A=3, B=2, C=1, but the
 * owner is explicit that it is not fixed, and production agrees emphatically: measured 2026-08-21,
 * grade A averages 2.04 planned calls and grade B averages 2.03 — statistically the same — and the
 * most common plan for a grade A doctor is a SINGLE visit. Only 14 grade C doctors exist company
 * wide. So the plan is the target. The grade norm is reported BESIDE the KPI as `planBelowGradeNorm`
 * (is the plan itself under-serving this doctor?) and never inside the frequency percentage.
 *
 * THE UNFINISHED MONTH IS SCORED TO DATE. A plan entry carries a date, so mid-month the comparison
 * is against the calls the plan asked for on days that have already happened — otherwise every rep
 * reads as behind schedule until the last day of the month. Measured on August to the 20th, the
 * to-date basis moves exactly-on-plan from 27.0% to 32.1% and false `under` from 28.9% to 21.9%.
 * For any COMPLETE month the two bases are identical, so this only ever affects the live month.
 *
 * SCOPE RULES (deliberate, and surfaced on the board):
 *  - Plan side: every weekly plan entry whose `plan_date` falls in the selected month.
 *  - Actual side: visit_type 0 (regular customer visits), duplicate submissions collapsed — the
 *    same door Doctor Coverage and DV Analytics read through, so the numbers agree.
 *  - CAMPAIGN visits (type -8) are loaded but CANNOT satisfy a planned call, and this is a data
 *    fact rather than a policy choice: all 31,322 campaign rows recorded between 2026-01-01 and
 *    2026-08-20 carry contact id 0, blank name, blank speciality. A campaign row says the rep
 *    worked; it never says which doctor they saw, so there is nothing to match a plan entry
 *    against. They are counted per rep BESIDE both KPIs (owner's ruling 2026-08-21) so that a rep
 *    who spent the month on campaign work is never presented as idle — two did in August 2026
 *    (113 and 62 calls, zero regular visits between them).
 *  - A rep with NO planned doctors is not a 0% performer. `hasMeasurablePlan` marks them, they sort
 *    out of the worst-first ranking, and the table prints a marker rather than a percentage.
 *  - Departed agents are excluded from BOTH sides. The reads door already drops them from visits;
 *    the plan side must drop them too, or a leaver whose plan is still on file scores 0% forever.
 *  - The join is on the vendor's own keys (agent_crm_id + contact_crm_id), present and identical on
 *    both sides, rather than on a resolved hr id — nothing here depends on identity resolution
 *    having succeeded, and the 79 planning agents measured on 2026-08-21 all resolved anyway.
 *  - Contact kind comes from the shared taxonomy (contact-taxonomy.ts). A speciality it has never
 *    seen stays `unclassified` and is COUNTED AND NAMED on the board, never folded into the doctor
 *    total. The plan carried two such values ("Nephrology", "Dermatologist") that the taxonomy was
 *    written before the vendor started sending — both taught to the taxonomy 2026-08-21.
 *
 * DATE DISCIPLINE (same test-enforced rule as sfe-doctor-coverage.ts): CRM dates are Cairo
 * wall-clock and `plan_date`/`visit_date` are plain YYYY-MM-DD, so all month math is string
 * arithmetic — never Date-object parsing or ISO re-serialization, either of which shifts the clock.
 */

import { CRM_PLAN_ENTRIES_TABLE, CRM_PLAN_ENTRIES_UNIFIED_VIEW } from "@/lib/crm/tables";
import { cairoTodayIso } from "@/lib/crm/dates";
import { classifyCrmContactSpeciality, type CrmContactKind } from "@/lib/crm/contact-taxonomy";
import {
  DEFAULT_DOCTOR_COVERAGE_NORMS,
  getDoctorCoverageConfig,
  type DoctorCoverageNorms,
} from "@/lib/crm/doctor-coverage-config";
import { dayScanSlices, expandHrIdFilterValues, getEffectiveExcludedAgentCrmIds, queryVisits, readCompanyWindow } from "@/lib/crm/reads";
import { planEntryKeyOf, planEntryKeysetAfter } from "@/lib/crm/plan-entry-keyset";
import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * How many doctor rows the drill-down ships when no single rep is selected. The company-wide list
 * is ~9,000 rows a month, which is a multi-megabyte payload for a table nobody reads end to end.
 * The cap is NEVER silent: `doctorsTotal` always reports the true count and the board says so, so a
 * truncated list can never be mistaken for a complete one.
 */
export const REP_DOCTOR_DRILLDOWN_CAP = 500;

/** Rows per page when scanning the plan mirror. Matches the CRM reads door. */
const PLAN_PAGE_SIZE = 1000;

/** COVERAGE status — was this doctor reached at all this month? */
export type RepDoctorStatus = "seen" | "missed" | "off_plan";

/**
 * FREQUENCY status — did the number of calls match what the plan asked for, to date?
 *
 * `missed` and `off_plan` are carried here too rather than folded into `under`/`over`, because they
 * are different management problems: `under` is a rep running behind on a doctor he is working,
 * `missed` is a doctor he has not started, and `off_plan` is work on somebody who was never on the
 * list. Only `on_plan` counts toward the frequency percentage.
 */
export type RepDoctorFrequencyStatus = "on_plan" | "under" | "over" | "missed" | "off_plan" | "not_due";

export type RepDoctorListRepRow = {
  /** Collapsed type-0 calls this rep made to doctors that are ON his plan. Off-plan work is not
   * counted here — it has its own column, so this number and `plannedCallsToDate` are comparable. */
  actualCalls: number;
  /** Null for a rep hired after the CRM cutover who has no CRM id — he is keyed `hr:<id>` instead. */
  agentCrmId: number | null;
  agentHrId: string | null;
  /** KPI 1 — percentage of planned doctors reached AT ALL, on the plan SO FAR. 0 when nothing was
   * planned. Shipped as `adherencePct` in #2259. The numerator is unchanged; the denominator is
   * `coverageDueDoctors`, not `plannedDoctors` — see that field for why. */
  coveragePct: number;
  /** The coverage denominator: planned doctors who were due by `asOf`, plus any visited early.
   *
   * WITH A WINDOW this is identically `plannedDoctors` — `asOf` is the window's last day, so
   * nothing in it is undue. The field is still reported because the Reps List drill-down reads the
   * same builder on the to-date basis, where the two genuinely differ. On the KPIs board, read
   * `plannedDoctors`. It is identical to `plannedDoctors` for any COMPLETE month either way, so no
   * closed month's number moves.
   *
   * Mid-month the two are far apart, and the gap is the whole reason this field exists. Measured on
   * production for August 2026: the month finished with 9,812 planned rep-to-doctor pairs, but on
   * 3 August only 3,092 of them were due — 68.5% were scheduled for days that had not happened yet.
   * Dividing by all 9,812 on the 3rd caps coverage at 31.5% by arithmetic alone, so a rep who had
   * seen every doctor asked of him so far still reads as a failure, and the figure recovers over
   * the month purely because the denominator stops growing. That is the same unfairness
   * `plannedCallsToDate` was added to remove from frequency, and it is removed here the same way.
   *
   * A doctor visited BEFORE the plan asked for stays in, or coverage could exceed 100%. */
  coverageDueDoctors: number;
  /** KPI 2 — percentage of planned doctors whose call count matched the plan exactly, to date.
   * 0 when nothing was planned. Deliberately NOT met-or-exceeded: over-visiting is a deviation. */
  frequencyPct: number;
  gradeA: number;
  gradeB: number;
  gradeC: number;
  /** Planned doctors with no type-0 visit this month. */
  missedDoctors: number;
  /** Planned doctors whose calls are all scheduled for days that have not happened yet. Held OUT of
   * the frequency denominator — they are not late. Always 0 for a complete month. */
  notDueDoctors: number;
  /** Planned doctors visited EXACTLY as many times as the plan asked for, to date. The numerator
   * of `frequencyPct`; its denominator is `plannedDoctors - notDueDoctors`. */
  onPlanDoctors: number;
  /** Planned doctors visited MORE times than planned. A deviation, on the owner's rule. */
  overDoctors: number;
  /** Planned calls falling on days that have already happened — the fair denominator mid-month.
   * Equals `plannedCalls` for any complete month. */
  plannedCallsToDate: number;
  /** Planned doctors visited at least once but fewer times than planned. */
  underDoctors: number;
  /** Doctors whose PLAN asks for fewer calls than the configured grade norm — a signal about plan
   * quality, reported beside the KPIs and never inside either percentage. */
  underPlannedVsGrade: number;
  /** Doctors visited this month who are NOT on this rep's plan. */
  offPlanDoctors: number;
  /** Distinct HCP accounts (pharmacies, hospitals, contracts) on the plan. */
  plannedAccounts: number;
  /** Total plan ENTRIES, i.e. planned calls — higher than plannedDoctors when a doctor is planned
   * more than once in the month. */
  plannedCalls: number;
  /** Distinct SP contacts on the plan — the doctor list itself. */
  plannedDoctors: number;
  /** Campaign calls (visit type -8) this rep logged. These prove the rep WORKED but name no doctor
   * (every one of the 31,322 ever recorded carries contact id 0), so they can never mark a planned
   * doctor as seen — they are reported beside coverage and frequency, never inside either. */
  campaignCalls: number;
  /** False when this rep has no planned doctors at all, so there is nothing to be a percentage OF.
   * Such a rep is not a 0% performer and must not be ranked as one. */
  hasMeasurablePlan: boolean;
  plannedUnclassified: number;
  repKey: string;
  repName: string;
  /** Plan entries still at vendor status 0 (New) — never verified by a supervisor. */
  unverifiedCalls: number;
  /** Planned doctors with at least one type-0 visit this month. */
  visitedDoctors: number;
};

export type RepDoctorListDoctorRow = {
  contactCrmId: number;
  contactName: string;
  gradeRaw: string | null;
  kind: CrmContactKind;
  /** null for an off-plan doctor — there is no planned call to point at. */
  lastPlanDate: string | null;
  /** Every distinct day the plan booked this contact inside the window, earliest first. Empty for
   * an off-plan doctor. The KPIs board prints these beside a doctor nobody has reached yet, because
   * a doctor planned for next Tuesday and a doctor planned for last Tuesday are both "not covered"
   * and only one of them is late. */
  planDates: string[];
  lastVisitDate: string | null;
  /** `visits` minus `plannedCallsToDate`. Negative is behind, positive is over. 0 is on plan.
   * Signed on purpose — "how far off, and which way" is the whole question. */
  frequencyDelta: number;
  frequencyStatus: RepDoctorFrequencyStatus;
  /** The configured norm for this doctor's grade, or null when the grade is blank or unscored.
   * Context only — never the target the frequency status is measured against. */
  gradeNormCalls: number | null;
  /** True when the PLAN asks for fewer calls than the grade norm, i.e. the plan itself may be the
   * problem rather than the rep. Reported separately from every KPI. */
  planBelowGradeNorm: boolean;
  /** How many times the plan asks for this contact this month. 0 for an off-plan doctor. */
  plannedCalls: number;
  /** Of `plannedCalls`, how many fall on days that have already happened. The number `visits` is
   * actually compared against. Equals `plannedCalls` once the month is complete. */
  plannedCallsToDate: number;
  regionName: string | null;
  repKey: string;
  repName: string;
  speciality: string | null;
  status: RepDoctorStatus;
  visits: number;
};

export type RepDoctorListFilters = {
  /** Frequency bucket, independent of `status`. Both may be applied at once — "seen but under" is
   * a real question and needs both halves. */
  frequency?: string;
  kind?: string;
  repKey?: string;
  search?: string;
  status?: string;
};

export type RepDoctorListsBoard = {
  appliedFilters: RepDoctorListFilters;
  /** The last day scored: today for the live month, the month's last day for a complete one. The
   * board prints it, so a mid-month percentage can never be mistaken for a full-month one. */
  asOf: string;
  doctors: RepDoctorListDoctorRow[];
  /** True count before REP_DOCTOR_DRILLDOWN_CAP — so the cap is always visible. */
  doctorsTotal: number;
  isCurrentMonth: boolean;
  month: string;
  monthLabel: string;
  /** Latest `synced_at` on any plan row in the window, or null when the mirror is empty. */
  planSyncedAt: string | null;
  repOptions: Array<{ repKey: string; repName: string }>;
  reps: RepDoctorListRepRow[];
  /** Reps with visits this month but no plan entries at all. */
  repsWithoutPlan: number;
  /** Reps who have a plan, reached none of it, and whose month is entirely CAMPAIGN work. Their 0%
   * is arithmetically true and completely misleading — surfaced so it is never read as "idle". */
  repsAllCampaign: number;
  totals: {
    actualCalls: number;
    campaignCalls: number;
    coverageDueDoctors: number;
    coveragePct: number;
    frequencyPct: number;
    missedDoctors: number;
    notDueDoctors: number;
    offPlanDoctors: number;
    onPlanDoctors: number;
    overDoctors: number;
    plannedAccounts: number;
    plannedCalls: number;
    plannedCallsToDate: number;
    plannedDoctors: number;
    reps: number;
    underDoctors: number;
    underPlannedVsGrade: number;
    unverifiedCalls: number;
    visitedDoctors: number;
  };
  /** Speciality values the shared taxonomy has never seen, with their contact counts. Surfaced so a
   * new vendor value is a visible decision rather than a silent omission from the doctor total. */
  unclassifiedSpecialities: Array<{ contacts: number; label: string }>;
};

/** The plan-mirror projection this board reads. Exported so tests can build fixtures against the
 * real shape rather than a hand-written lookalike that can drift from it. */
export type PlanRow = {
  /** Null on a native (post-cutover) plan row for a rep with no CRM id; `agent_hr_id` then carries him. */
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_grade: string | null;
  contact_name: string | null;
  crm_region_name: string | null;
  plan_date: string | null;
  plan_status: number | null;
  speciality: string | null;
  synced_at: string | null;
};

/** The visits-mirror projection this board reads (see the `columns` list in getRepDoctorLists). */
export type VisitRow = {
  agent_crm_id: number | null;
  /** 0 = regular customer visit, -8 = campaign. Both are loaded; only 0 can satisfy a planned
   * doctor, because a campaign row carries no contact. */
  visit_type: number | null;
  agent_hr_id: string | null;
  agent_name: string | null;
  contact_crm_id: number | null;
  crm_contact_grade: string | null;
  speciality: string | null;
  visit_date: string | null;
};

/** "YYYY-MM" for a "YYYY-MM-DD" date string. String slice only — never Date parsing. */
export function monthKeyOfDate(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/** First and last day of a month key, inclusive. */
export function monthBounds(monthKey: string): { from: string; to: string } {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one. UTC-only construction, and only the day
  // NUMBER is read back out — no instant derived from it ever reaches a stored or displayed value.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(lastDay).padStart(2, "0")}` };
}

export function resolveRepDoctorListMonth(month: string | undefined): string {
  if (month && MONTH_KEY_PATTERN.test(month)) return month;
  return monthKeyOfDate(cairoTodayIso());
}

export function monthLabelOf(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/** A+ folds into A, matching Doctor Coverage's tiering so the two boards grade identically. */
export function gradeTierOf(grade: string | null | undefined): "A" | "B" | "C" | null {
  const normalized = String(grade ?? "").trim().toUpperCase();
  if (normalized === "A+" || normalized === "A") return "A";
  if (normalized === "B") return "B";
  if (normalized === "C") return "C";
  return null;
}

/**
 * The FREQUENCY verdict for one contact — the owner's second KPI.
 *
 * His rule, verbatim: "if he tell three times and he visited three times, then this is correct. But
 * if he tell three times and visited four times, then there is here an issue. And if he tell three
 * times and visited two times, he is also an issue." So an exact match is the only pass, and this
 * can never be expressed as a met-or-exceeded ratio.
 *
 * WHY THE TWO SIDES USE DIFFERENT DENOMINATORS. Over-visiting is judged against the WHOLE month's
 * plan and falling behind against the plan TO DATE, because the two mistakes are not symmetric in
 * time. A rep who has already made more calls than the entire month asks for cannot undo them — that
 * is a real `over` on the 3rd of the month. A rep short of today's schedule still has the rest of
 * the month to catch up, so scoring him against calls the plan plants next week would invent a
 * deviation that does not exist. Once the month closes `plannedToDate === plannedCalls` and the two
 * collapse into the single exact-match rule above.
 *
 * `not_due` is a doctor the plan schedules only for days that have not happened yet. He is neither
 * a pass nor a failure, so he is kept OUT of the frequency denominator entirely — counting him as
 * on-plan would flatter the score, and counting him as missed would be an accusation about a call
 * that is not late.
 */
export function frequencyStatusOf(input: {
  actual: number;
  plannedCalls: number;
  plannedToDate: number;
}): RepDoctorFrequencyStatus {
  // Never on the plan at all. The rep worked somebody else's list, or somebody nobody listed.
  if (input.plannedCalls <= 0) return "off_plan";
  // Already past the whole month's ask — irreversible, so it outranks the to-date test below.
  if (input.actual > input.plannedCalls) return "over";
  if (input.plannedToDate <= 0) return "not_due";
  if (input.actual === 0) return "missed";
  if (input.actual < input.plannedToDate) return "under";
  return "on_plan";
}

/** Chunk size for the `agent_crm_id` filter. A PostgREST `.in()` travels in the URL, so past a few
 * hundred values the request comes back `{ data: [], error: null }` — an empty set indistinguishable
 * from a true answer, and the exact fault that once reported "0 of 409 candidates have a file". 50
 * is the house limit. */
const PLAN_AGENT_CHUNK = 50;

/** Chunk size for the `agent_hr_id` filter. Each hr id is sprayed into up to five casing/alias
 * variants (`expandHrIdFilterValues`), so 10 ids keep the URL list inside the same 50-value limit. */
const PLAN_HR_ID_CHUNK = 10;

/** The one projection every plan scan reads, whichever way it pages. */
const PLAN_SCAN_COLUMNS =
  "agent_crm_id, agent_hr_id, contact_crm_id, contact_grade, contact_name, crm_plan_entry_id, crm_region_name, plan_date, plan_status, speciality, synced_at";

/** A plan row as a scan reads it — with the entry id its keyset cursor carries (`plan-entry-keyset.ts`). */
type ScannedPlanRow = PlanRow & { crm_plan_entry_id?: number | string | null };

/** Reads every plan entry whose date falls inside the window. Returns [] before the migration
 * ships, so the page renders an honest empty state instead of a crash.
 *
 * Exported for the trend reader, which walks many months and must go through the SAME projection —
 * a second hand-written select is how the month board and the trend line start disagreeing.
 *
 * `agentCrmIds` narrows the read to one manager's reps. It filters on the CRM id and NOT on
 * `agent_hr_id`, which looks like the obvious key and is a trap: the plan mirror leaves the hr id
 * null on a large and *varying* share of rows — measured on production 2026-08-27, 791 of 18,645
 * August rows but 5,795 of 20,778 May rows (27.9%), and 26 of 98 agents in a four-month window
 * carry no hr id on a single plan row. An hr-id filter would silently drop a quarter of a month's
 * lists. `agent_crm_id` is null on none of the VENDOR rows. An EMPTY array means "no agents in
 * scope" and returns no rows — never everything.
 *
 * `agentHrIds` exists for the CRM cutover, and is never a replacement for `agentCrmIds`. A rep hired
 * after it has no CRM id, so his native plan rows carry a NULL `agent_crm_id` and only an hr id can
 * find them. Pass BOTH for a mixed set: the two lists are read as separate passes and UNIONED (a row
 * found by both is returned once), so the vendor rows with no hr id are still found by their CRM id.
 * Supplied lists that are all empty → no rows. */
export async function scanPlanEntries(
  from: string,
  to: string,
  options?: { agentCrmIds?: readonly number[]; agentHrIds?: readonly string[] },
): Promise<PlanRow[]> {
  const supabase = getSupabaseAdmin();
  type AgentChunk = { column: "agent_crm_id" | "agent_hr_id"; values: readonly (number | string)[] } | null;
  const agentChunks: AgentChunk[] = [];
  if (options?.agentCrmIds || options?.agentHrIds) {
    const crmIds = options.agentCrmIds ?? [];
    const hrIds = (options.agentHrIds ?? []).map((id) => String(id ?? "").trim()).filter((id) => id.length > 0);
    if (crmIds.length === 0 && hrIds.length === 0) return [];
    for (let start = 0; start < crmIds.length; start += PLAN_AGENT_CHUNK) {
      agentChunks.push({ column: "agent_crm_id", values: crmIds.slice(start, start + PLAN_AGENT_CHUNK) });
    }
    for (let start = 0; start < hrIds.length; start += PLAN_HR_ID_CHUNK) {
      // Every casing variant: the plan mirror stores whatever casing the roster used.
      agentChunks.push({ column: "agent_hr_id", values: expandHrIdFilterValues(hrIds.slice(start, start + PLAN_HR_ID_CHUNK)) });
    }
  } else {
    agentChunks.push(null);
  }

  // 🔴 A COMPANY-WIDE WINDOW IS READ ONE DAY AT A TIME (2026-10-01, "slow to transfer between page and
  // page"). This is the visits door's own answer to the same fault — `readCompanyWindow` in reads.ts,
  // whose header is the account — reused rather than written twice. An OFFSET page over the whole
  // window cannot stop early: Postgres reads every row in it through the date index and sorts them
  // all to hand back one thousand, and the next page does it again. Measured on production
  // 2026-10-01: September held 25,862 plan rows, each page cost 62 ms in the database whatever its
  // offset, and the 26 pages ran one after another on EVERY rep landing (the KPI tile reads this
  // board company-wide), where one day's slice costs 22 ms and the unordered probe 8 ms.
  // The days are disjoint and cover the window, so their union is exactly the rows of the single scan,
  // re-sorted into ascending entry id. That id is NOT unique in the view (`plan-entry-keyset.ts`), so a
  // day pages on (entry id, hr id), never on the id alone. A window that names agents is not sliced; it
  // walks the whole (day, entry id, hr id) keyset below.
  const days = agentChunks.length === 1 && agentChunks[0] === null ? dayScanSlices(from, to) : null;
  if (days) {
    const scanDay = async (day: string): Promise<ScannedPlanRow[] | null> => {
      const scanned: ScannedPlanRow[] = [];
      let cursor: ScannedPlanRow | null = null;
      for (;;) {
        let query = supabase.from(CRM_PLAN_ENTRIES_UNIFIED_VIEW).select(PLAN_SCAN_COLUMNS).eq("plan_date", day);
        if (cursor !== null) query = query.or(planEntryKeysetAfter(cursor, { byDate: false }));
        const { data, error } = await query
          .order("crm_plan_entry_id", { ascending: true })
          .order("agent_hr_id", { ascending: true, nullsFirst: false })
          .limit(PLAN_PAGE_SIZE);
        if (error) {
          if (isPlanSchemaMissing(error)) return null;
          throw new Error(error.message);
        }
        const page = (data ?? []) as unknown as ScannedPlanRow[];
        scanned.push(...page);
        const last = page[page.length - 1] ?? null;
        if (page.length < PLAN_PAGE_SIZE || last?.crm_plan_entry_id == null) return scanned;
        cursor = last;
      }
    };
    const windowRows = await readCompanyWindow<ScannedPlanRow>({
      days,
      pageSize: PLAN_PAGE_SIZE,
      probe: async () => {
        const { data, error } = await supabase
          .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
          .select(PLAN_SCAN_COLUMNS)
          .gte("plan_date", from)
          .lte("plan_date", to)
          .limit(PLAN_PAGE_SIZE);
        if (error) {
          if (isPlanSchemaMissing(error)) return null;
          throw new Error(error.message);
        }
        return (data ?? []) as unknown as ScannedPlanRow[];
      },
      scanDay,
      order: (left, right) => Number(left.crm_plan_entry_id) - Number(right.crm_plan_entry_id),
      sortDays: true,
    });
    return windowRows ?? [];
  }

  // 🔴 A WINDOW THAT NAMES AGENTS WALKS A KEYSET, NEVER AN OFFSET (Stage 2a, 28 Oct 2026). These two
  // shapes — ten hr ids, or fifty CRM ids, over a month — were the two heaviest statements in Phoenix:
  // 4,218 calls touching 312 GB of pages between them since the 25 Oct boot. An OFFSET page re-built the
  // whole window and sorted it to hand back a thousand rows, then the next page did it again; ordered by
  // the entry id ALONE it could also hand a tied row back twice and its twin never. Each page now starts
  // where the last one ended, and its `plan_date >= <last day>` lands on the view's grouped day, so the
  // days already read are never grouped again.
  //
  // Each chunk comes back in ascending entry id, as it did under the OFFSET scan; ties keep the
  // keyset's (day, hr id) order. Callers that need one order across chunks re-sort (`inPlanEntryOrder`).
  const rows: PlanRow[] = [];
  // Only a union of two passes can return one entry twice. The whole key makes that exact: the entry id
  // alone would also drop the second rep's row that shares it.
  const seenEntries = new Set<string>();
  const dedupe = agentChunks.length > 1;
  for (const chunk of agentChunks) {
    const chunkRows: ScannedPlanRow[] = [];
    let cursor: ScannedPlanRow | null = null;
    for (;;) {
      let query = supabase
        .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
        .select(PLAN_SCAN_COLUMNS)
        .gte("plan_date", cursor?.plan_date ?? from)
        .lte("plan_date", to);
      if (chunk) query = query.in(chunk.column, [...chunk.values]);
      if (cursor !== null) query = query.or(planEntryKeysetAfter(cursor, { byDate: true }));
      const { data, error } = await query
        .order("plan_date", { ascending: true })
        .order("crm_plan_entry_id", { ascending: true })
        .order("agent_hr_id", { ascending: true, nullsFirst: false })
        .limit(PLAN_PAGE_SIZE);
      if (error) {
        if (isPlanSchemaMissing(error)) return [];
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as ScannedPlanRow[];
      for (const row of page) {
        if (dedupe) {
          const key = planEntryKeyOf(row);
          if (seenEntries.has(key)) continue;
          seenEntries.add(key);
        }
        chunkRows.push(row);
      }
      const last = page[page.length - 1] ?? null;
      if (page.length < PLAN_PAGE_SIZE || last?.crm_plan_entry_id == null || !last.plan_date) break;
      cursor = last;
    }
    rows.push(...inPlanEntryOrder(chunkRows));
  }
  return rows;
}

/** Plan rows in ascending entry id — the order a company-wide `scanPlanEntries` returns. The entry id
 * is not unique in the view (`plan-entry-keyset.ts`); the sort is stable, so tied rows keep the order
 * they arrived in. Pure, exported for its test. */
export function inPlanEntryOrder(rows: readonly PlanRow[]): PlanRow[] {
  const entryId = (row: PlanRow) => Number((row as ScannedPlanRow).crm_plan_entry_id);
  return [...rows].sort((left, right) => entryId(left) - entryId(right));
}

/** The plan mirror is newer than several environments' schemas; a missing table degrades to an
 * empty board rather than a crash page, matching every other CRM reader's posture. */
function isPlanSchemaMissing(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return (
    message.includes(CRM_PLAN_ENTRIES_TABLE) ||
    message.includes(CRM_PLAN_ENTRIES_UNIFIED_VIEW) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

/**
 * The rep half of every key on this board: the CRM id as a string — exactly the `repKey` every rep
 * with a CRM id has always had — or `hr:<canonical hr id>` for a rep hired after the CRM cutover,
 * who has none. Keyed on the CRM id alone, all such reps shared ONE `null` key: their plans merged
 * into a single "Unmapped CRM agent null" row and their visits were skipped, so each read 0% against
 * the whole cohort's doctors. `null` only when neither id is present.
 */
export function repDoctorListRepKey(agentCrmId: number | null | undefined, agentHrId: string | null | undefined): string | null {
  if (agentCrmId) return String(agentCrmId);
  const hrKey = canonicalHrIdKey(agentHrId);
  return hrKey ? `hr:${hrKey}` : null;
}

function contactKey(repKey: string, contactCrmId: number): string {
  return `${repKey}:${contactCrmId}`;
}

export type RepDoctorListsInput = {
  /** Last day to score, as YYYY-MM-DD. Defaults to today (Cairo) clamped to the month's last day.
   *
   * Injectable so the frequency rule is testable: the to-date basis is the one part of this board
   * whose answer changes with the wall clock, and a test that depends on the real date is a test
   * that passes today and fails in September. Production never passes it. */
  asOf?: string;
  /**
   * The scored period, when it is not the whole month.
   *
   * SUPPLYING THIS CHANGES THE BASIS, and that is its whole purpose. Owner, 2026-09-04: *"you can
   * show that until now, she covered twenty of hundred doctors ... so her coverage is twenty
   * percent. Also, make an option to filter by period and choose, for example, one week, two
   * weeks."* A window is therefore scored WHOLE — every planned call inside it counts, whether or
   * not its day has arrived — so coverage divides by the window's entire list rather than by the
   * part of it that has come due. The fair mid-month read is a SHORTER WINDOW, not a shrinking
   * denominator, which is the one lever a manager can see and reason about.
   *
   * Rows outside the window are dropped here rather than trusted to the caller: this function is
   * the pure half and has to be correct for whatever it is handed.
   *
   * Omitted, the board keeps its original to-date basis against today — which is what the Reps List
   * drill-down still wants, and what every closed month has always produced anyway.
   */
  window?: { from: string; to: string };
  /** Canonical (upper-cased, trimmed) hr id → the employee's display name. */
  employeeNameByHrId: ReadonlyMap<string, string>;
  /** Departed agents, from the CRM reads door. Applied to the PLAN side here; the visits side has
   * already had them removed by the door itself. */
  excludedAgentCrmIds: readonly number[];
  filters?: RepDoctorListFilters;
  month: string;
  /** Admin-editable grade norms, shared with Doctor Coverage so the two boards cannot disagree
   * about what a grade is worth. Passed in rather than read here, because this function is pure. */
  norms: DoctorCoverageNorms;
  planRows: readonly PlanRow[];
  /** Type-0 visits for the same window, duplicate submissions already collapsed. */
  visitRows: readonly VisitRow[];
  /**
   * Ship EVERY doctor row instead of the first REP_DOCTOR_DRILLDOWN_CAP.
   *
   * For the KPIs board's Coverage tab, which lists one rep's doctors and cannot name that rep in
   * `filters.repKey` — that filter narrows `reps` too, and the board needs every rep. The board
   * picks one rep's rows out of this list on the server and returns only those, so the company-wide
   * rows never travel to a browser. The rows already exist in memory either way; this only stops
   * them being cut.
   */
  uncapped?: boolean;
};

/**
 * Builds the board for one month.
 *
 * Both halves are read for the same window and joined in memory. That is deliberate rather than a
 * SQL join: the plan mirror and the visits mirror have different exclusion rules (the visits door
 * owns departed-agent and duplicate-submission logic and must stay the single source of it), and
 * pushing the join into SQL would fork that logic into a second place.
 */
export async function getRepDoctorLists(input: {
  filters?: RepDoctorListFilters;
  month: string;
  /** The scored period inside that month. Defaults to the whole month. Both mirrors are read for
   * exactly this span, so a week's board never pays for a month's rows — and the builder cuts to it
   * again anyway, because it must be right on whatever it is handed. */
  window?: { from: string; to: string };
  /** See `RepDoctorListsInput.uncapped`. */
  uncapped?: boolean;
  /**
   * Read only these reps' plans and visits, by either id — the KPIs board's narrowing for a scope of
   * a few people (crm/kpi-board-agents.ts chooses the ids). The builder is handed exactly the rows
   * the company-wide read gives these reps, in the same order, so every figure is the one it was.
   * Omitted, the whole company is read as before.
   */
  agents?: { crmIds: readonly number[]; hrIds: readonly string[] };
  /**
   * Opt-in, DISPLAY callers only: a whole-company window (no `agents`) may come from a copy up to a
   * minute old, shared by every viewer of the same window (crm/reads.ts, "A dashboard may reuse a
   * company window"). Each viewer's scope is still applied to those rows afterwards, so the copy holds
   * company rows, never one viewer's board. Never for a read that decides money, a deduction, an
   * approval or a notification. A read narrowed to `agents` always reads live.
   */
  reuseRecentWindow?: boolean;
}): Promise<RepDoctorListsBoard> {
  const monthWindow = monthBounds(input.month);
  const from = input.window?.from ?? monthWindow.from;
  const to = input.window?.to ?? monthWindow.to;
  const agents = input.agents;

  const [planRows, visitRows, excludedAgentCrmIds, directory, norms] = await Promise.all([
    agents
      ? // Two passes (CRM ids, then hr ids) come back one after the other; the company-wide read comes
        // back in entry-id order, and the builder takes a rep's identity from his FIRST plan row, so
        // the union is put back into that order.
        scanPlanEntries(from, to, { agentCrmIds: agents.crmIds, agentHrIds: agents.hrIds }).then(inPlanEntryOrder)
      : scanPlanEntries(from, to),
    queryVisits<VisitRow>({
      collapseDoubleVisits: true,
      columns:
        "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, crm_contact_grade, speciality, visit_date, visit_type",
      dateFrom: from,
      dateTo: to,
      // Campaign rows are loaded but can never satisfy a planned call — see the split in
      // buildRepDoctorListsBoard. They are here so a rep who spent the month on campaign work is
      // shown as working rather than as a zero (owner's ruling 2026-08-21).
      visitTypes: [0, CAMPAIGN_TYPE],
      reuseRecentWindow: input.reuseRecentWindow === true,
      // One read, in the visits door's id order — the same order the company-wide read is in.
      ...(agents ? { agentCrmOrHrIds: { crmIds: agents.crmIds, hrIds: agents.hrIds } } : {}),
    }),
    getEffectiveExcludedAgentCrmIds(),
    getEmployeeDirectoryRows({ includeInactive: true }),
    // Grade norms are CONTEXT on this board, never the target — so a settings table that is missing
    // or unreadable must not take the KPIs down with it. Degrade to the compile-time defaults.
    getDoctorCoverageConfig()
      .then((config) => config.norms)
      .catch(() => DEFAULT_DOCTOR_COVERAGE_NORMS),
  ]);

  const employeeNameByHrId = new Map<string, string>();
  for (const employee of directory) {
    employeeNameByHrId.set(employee.hrId.trim().toUpperCase(), employee.displayName || employee.fullName);
  }

  return buildRepDoctorListsBoard({
    employeeNameByHrId,
    excludedAgentCrmIds,
    filters: input.filters,
    month: input.month,
    norms,
    planRows,
    uncapped: input.uncapped,
    visitRows,
    window: input.window,
  });
}

/**
 * The whole join, as a pure function — every number this board reports is produced here.
 *
 * Separated from the IO deliberately. This is the half that can be wrong in a way nobody notices:
 * "this rep never visited 59 doctors" is an accusation, and it has to be verifiable without a
 * database. tests/crm-rep-doctor-lists.test.ts drives it with fixtures.
 */
export function buildRepDoctorListsBoard(input: RepDoctorListsInput): RepDoctorListsBoard {
  const month = input.month;
  const filters = input.filters ?? {};
  const norms = input.norms;

  // ── THE SCORED WINDOW ────────────────────────────────────────────────────────────────────────
  // `asOf` is the last day whose planned calls COUNT. Two bases, and which one is in force is
  // decided by whether a window was asked for:
  //
  //   WINDOW GIVEN   asOf = the window's own last day, so the whole window counts. A doctor the
  //                  plan schedules for the 28th is part of September's list on the 4th, and
  //                  September's coverage is measured against all of it. Pick week 1 to be judged
  //                  on week 1.
  //   NO WINDOW      asOf = today, clamped to the month's end — the original to-date basis, kept
  //                  for the Reps List drill-down which reads one rep's own month.
  //
  // For any COMPLETE month the two are the same day, so no closed month's number moves either way.
  // String comparison throughout: YYYY-MM-DD sorts correctly as text, and parsing to a Date would
  // shift the Cairo wall-clock the vendor sends (see DATE DISCIPLINE above).
  const bounds = monthBounds(month);
  const monthEnd = bounds.to;
  const windowFrom = input.window?.from ?? bounds.from;
  const windowTo = input.window?.to ?? bounds.to;
  // THE WINDOW WINS when there is one. `asOf` is the to-date injection point for the WINDOWLESS
  // caller, and letting it override a window would make the basis depend on which of two arguments a
  // caller happened to set — the KPIs board passes no asOf today, so the bug would have been silent
  // until someone added one, and then coverage would quietly revert to the due-so-far divisor.
  const today = input.asOf ?? cairoTodayIso();
  const asOf = input.window ? windowTo : today < monthEnd ? today : monthEnd;

  // Both sides are cut to the window before anything is counted. A caller that read a whole month
  // and then asked for week 2 must not have month rows scored against a week's dates.
  const windowPlanRows = input.planRows.filter(
    (row) => row.plan_date != null && row.plan_date >= windowFrom && row.plan_date <= windowTo,
  );
  const windowVisitRows = input.visitRows.filter(
    (row) => row.visit_date != null && row.visit_date >= windowFrom && row.visit_date <= windowTo,
  );

  // THE SPLIT. A campaign row (visit type -8) proves the rep worked but names no doctor: every one
  // of the 31,322 recorded between 2026-01-01 and 2026-08-20 carries contact id 0, blank name,
  // blank speciality. So it can never mark a planned doctor as seen -- there is no doctor on it to
  // match. It is counted beside BOTH KPIs instead, so a rep who spent the month on campaign work is
  // never presented as idle (owner's ruling 2026-08-21). Coverage keeps meaning exactly one thing:
  // planned doctors CONFIRMED seen.
  const visitRows = windowVisitRows.filter((row) => row.visit_type !== CAMPAIGN_TYPE);
  const campaignRows = windowVisitRows.filter((row) => row.visit_type === CAMPAIGN_TYPE);

  // Symmetry with the visits door, which has already dropped these agents from `visitRows`.
  // `?? -1` mirrors the view's `exclusion_crm_id`: a rep with no CRM id is excluded by nothing here,
  // just as the visits door never excludes his rows.
  const excluded = new Set(input.excludedAgentCrmIds);
  const planRows = windowPlanRows.filter((row) => !excluded.has(row.agent_crm_id ?? -1));

  // Rep display names: the employee record first (the owner's rule is human-readable names, and the
  // directory carries the nickname-aware one), then the vendor's own label from the visits mirror,
  // then an explicit unmapped marker. A plan entry carries no agent name field at all, so a rep who
  // planned but never visited has only the first source.
  const nameByHrId = input.employeeNameByHrId;
  const vendorNameByRepKey = new Map<string, string>();
  // windowVisitRows, not visitRows: a rep whose whole window is campaign work has NO type-0 row,
  // so reading only the joinable rows would leave them nameless and print "Unmapped CRM agent 1550".
  for (const visit of windowVisitRows) {
    const repKey = repDoctorListRepKey(visit.agent_crm_id, visit.agent_hr_id);
    const name = visit.agent_name?.trim();
    if (repKey && name && !vendorNameByRepKey.has(repKey)) vendorNameByRepKey.set(repKey, name);
  }
  const hrIdByRepKey = new Map<string, string | null>();
  const crmIdByRepKey = new Map<string, number | null>();
  const noteIdentity = (agentCrmId: number | null, agentHrId: string | null): void => {
    const repKey = repDoctorListRepKey(agentCrmId, agentHrId);
    if (!repKey || hrIdByRepKey.has(repKey)) return;
    hrIdByRepKey.set(repKey, agentHrId);
    crmIdByRepKey.set(repKey, agentCrmId || null);
  };
  for (const row of planRows) noteIdentity(row.agent_crm_id, row.agent_hr_id);
  for (const visit of windowVisitRows) noteIdentity(visit.agent_crm_id, visit.agent_hr_id);
  const repNameOf = (repKey: string): string => {
    const hrId = hrIdByRepKey.get(repKey);
    const fromDirectory = hrId ? nameByHrId.get(hrId.trim().toUpperCase()) : undefined;
    if (fromDirectory) return fromDirectory;
    const fromVendor = vendorNameByRepKey.get(repKey);
    if (fromVendor) return fromVendor;
    const crmId = crmIdByRepKey.get(repKey);
    return crmId != null ? `Unmapped CRM agent ${crmId}` : `Unmapped agent ${hrId ?? repKey}`;
  };

  // ── Plan side ────────────────────────────────────────────────────────────────────────────────
  type PlanContact = {
    repKey: string;
    contactCrmId: number;
    gradeRaw: string | null;
    kind: CrmContactKind;
    lastPlanDate: string | null;
    name: string;
    /** Distinct plan days; sorted once the plan side is complete. */
    planDates: Set<string>;
    plannedCalls: number;
    plannedCallsToDate: number;
    regionName: string | null;
    speciality: string | null;
    unverifiedCalls: number;
  };
  const planned = new Map<string, PlanContact>();
  const unclassifiedContacts = new Map<string, Set<number>>();
  let planSyncedAt: string | null = null;

  for (const row of planRows) {
    if (row.synced_at && (!planSyncedAt || row.synced_at > planSyncedAt)) planSyncedAt = row.synced_at;
    const contactCrmId = row.contact_crm_id;
    // 0 is the vendor's "unspecified contact" sentinel, exactly as on a visit — not a real person.
    if (!contactCrmId) continue;
    const repKey = repDoctorListRepKey(row.agent_crm_id, row.agent_hr_id);
    if (!repKey) continue;
    const key = contactKey(repKey, contactCrmId);
    const kind = classifyCrmContactSpeciality(row.speciality);
    if (kind === "unclassified" && row.speciality?.trim()) {
      const label = row.speciality.trim();
      const bucket = unclassifiedContacts.get(label) ?? new Set<number>();
      bucket.add(contactCrmId);
      unclassifiedContacts.set(label, bucket);
    }
    const dueByNow = Boolean(row.plan_date && row.plan_date <= asOf);
    const existing = planned.get(key);
    if (existing) {
      existing.plannedCalls += 1;
      if (dueByNow) existing.plannedCallsToDate += 1;
      if (row.plan_status === 0) existing.unverifiedCalls += 1;
      if (row.plan_date && (!existing.lastPlanDate || row.plan_date > existing.lastPlanDate)) {
        existing.lastPlanDate = row.plan_date;
      }
      if (row.plan_date) existing.planDates.add(row.plan_date);
      continue;
    }
    planned.set(key, {
      repKey,
      contactCrmId,
      gradeRaw: row.contact_grade,
      kind,
      lastPlanDate: row.plan_date,
      name: row.contact_name?.trim() || `Contact ${contactCrmId}`,
      planDates: new Set(row.plan_date ? [row.plan_date] : []),
      plannedCalls: 1,
      plannedCallsToDate: dueByNow ? 1 : 0,
      regionName: row.crm_region_name,
      speciality: row.speciality,
      unverifiedCalls: row.plan_status === 0 ? 1 : 0,
    });
  }

  // ── Actual side ──────────────────────────────────────────────────────────────────────────────
  type VisitedContact = {
    repKey: string;
    contactCrmId: number;
    gradeRaw: string | null;
    lastVisitDate: string | null;
    speciality: string | null;
    visits: number;
  };
  const visited = new Map<string, VisitedContact>();
  const repsWithVisits = new Set<string>();
  for (const visit of visitRows) {
    const repKey = repDoctorListRepKey(visit.agent_crm_id, visit.agent_hr_id);
    const contactCrmId = visit.contact_crm_id;
    if (!repKey) continue;
    repsWithVisits.add(repKey);
    if (!contactCrmId) continue;
    const key = contactKey(repKey, contactCrmId);
    const visitDate = visit.visit_date ? visit.visit_date.slice(0, 10) : null;
    const existing = visited.get(key);
    if (existing) {
      existing.visits += 1;
      if (visitDate && (!existing.lastVisitDate || visitDate > existing.lastVisitDate)) {
        existing.lastVisitDate = visitDate;
      }
      continue;
    }
    visited.set(key, {
      repKey,
      contactCrmId,
      gradeRaw: visit.crm_contact_grade,
      lastVisitDate: visitDate,
      speciality: visit.speciality,
      visits: 1,
    });
  }

  // ── Join ─────────────────────────────────────────────────────────────────────────────────────
  const doctorRows: RepDoctorListDoctorRow[] = [];
  const repAccumulator = new Map<string, RepDoctorListRepRow>();
  const repFor = (repKey: string): RepDoctorListRepRow => {
    const existing = repAccumulator.get(repKey);
    if (existing) return existing;
    const created: RepDoctorListRepRow = {
      actualCalls: 0,
      agentCrmId: crmIdByRepKey.get(repKey) ?? null,
      agentHrId: hrIdByRepKey.get(repKey) ?? null,
      campaignCalls: 0,
      coverageDueDoctors: 0,
      coveragePct: 0,
      frequencyPct: 0,
      gradeA: 0,
      gradeB: 0,
      gradeC: 0,
      hasMeasurablePlan: false,
      missedDoctors: 0,
      notDueDoctors: 0,
      offPlanDoctors: 0,
      onPlanDoctors: 0,
      overDoctors: 0,
      plannedAccounts: 0,
      plannedCalls: 0,
      plannedCallsToDate: 0,
      plannedDoctors: 0,
      plannedUnclassified: 0,
      repKey,
      repName: repNameOf(repKey),
      underDoctors: 0,
      underPlannedVsGrade: 0,
      unverifiedCalls: 0,
      visitedDoctors: 0,
    };
    repAccumulator.set(repKey, created);
    return created;
  };

  for (const [key, contact] of planned) {
    const rep = repFor(contact.repKey);
    rep.plannedCalls += contact.plannedCalls;
    rep.plannedCallsToDate += contact.plannedCallsToDate;
    rep.unverifiedCalls += contact.unverifiedCalls;
    if (contact.kind === "hcp") rep.plannedAccounts += 1;
    else if (contact.kind === "unclassified") rep.plannedUnclassified += 1;

    const seen = visited.get(key);
    const actual = seen?.visits ?? 0;
    const frequencyStatus = frequencyStatusOf({
      actual,
      plannedCalls: contact.plannedCalls,
      plannedToDate: contact.plannedCallsToDate,
    });
    const tier = gradeTierOf(contact.gradeRaw);
    // The grade norm is CONTEXT — "should this doctor have been planned more often?" — and only the
    // scored kinds carry one. It never enters `frequencyStatus`, which answers to the plan alone.
    const gradeNormCalls =
      tier && (contact.kind === "sp" || contact.kind === "hcp") ? norms[contact.kind][tier] : null;
    const planBelowGradeNorm = gradeNormCalls !== null && contact.plannedCalls < gradeNormCalls;

    // Only SP contacts count toward the doctor list and both KPIs — a pharmacy is not a doctor,
    // the same split the taxonomy was written to enforce on Doctor Coverage.
    if (contact.kind === "sp") {
      rep.plannedDoctors += 1;
      rep.actualCalls += actual;
      if (tier === "A") rep.gradeA += 1;
      else if (tier === "B") rep.gradeB += 1;
      else if (tier === "C") rep.gradeC += 1;
      // COVERAGE: one visit is enough, and that is the whole test.
      if (seen) rep.visitedDoctors += 1;
      else rep.missedDoctors += 1;
      // ...but only against the part of the list that has come due. A doctor first planned for the
      // 28th cannot have been seen on the 3rd, and counting him as a miss is arithmetic, not
      // performance. `seen` keeps an early visit in the denominator so the ratio cannot pass 100%.
      if (contact.plannedCallsToDate > 0 || seen) rep.coverageDueDoctors += 1;
      if (planBelowGradeNorm) rep.underPlannedVsGrade += 1;
      // FREQUENCY: `missed` needs no counter of its own — it is what is left once the other four
      // buckets are taken out of the due population, and `missedDoctors` above already names it.
      if (frequencyStatus === "on_plan") rep.onPlanDoctors += 1;
      else if (frequencyStatus === "under") rep.underDoctors += 1;
      else if (frequencyStatus === "over") rep.overDoctors += 1;
      else if (frequencyStatus === "not_due") rep.notDueDoctors += 1;
    }

    doctorRows.push({
      contactCrmId: contact.contactCrmId,
      contactName: contact.name,
      frequencyDelta: actual - contact.plannedCallsToDate,
      frequencyStatus,
      gradeNormCalls,
      gradeRaw: contact.gradeRaw,
      kind: contact.kind,
      lastPlanDate: contact.lastPlanDate,
      // YYYY-MM-DD sorts correctly as text — no Date parsing (see DATE DISCIPLINE above).
      planDates: [...contact.planDates].sort(),
      lastVisitDate: seen?.lastVisitDate ?? null,
      planBelowGradeNorm,
      plannedCalls: contact.plannedCalls,
      plannedCallsToDate: contact.plannedCallsToDate,
      regionName: contact.regionName,
      repKey: rep.repKey,
      repName: rep.repName,
      speciality: contact.speciality,
      status: seen ? "seen" : "missed",
      visits: actual,
    });
  }

  // Visited but never planned. Counted for doctors only, for the same reason as above.
  for (const [key, contact] of visited) {
    if (planned.has(key)) continue;
    const kind = classifyCrmContactSpeciality(contact.speciality);
    const rep = repFor(contact.repKey);
    if (kind === "sp") rep.offPlanDoctors += 1;
    doctorRows.push({
      contactCrmId: contact.contactCrmId,
      contactName: `Contact ${contact.contactCrmId}`,
      // Every call here is unplanned, so the whole visit count is the overshoot. Owner's ruling
      // 2026-08-21: these stay a count BESIDE the KPI and never enter the frequency percentage —
      // its denominator is planned doctors, and these were never planned.
      frequencyDelta: contact.visits,
      frequencyStatus: "off_plan",
      gradeNormCalls: null,
      gradeRaw: contact.gradeRaw,
      kind,
      lastPlanDate: null,
      planDates: [],
      lastVisitDate: contact.lastVisitDate,
      planBelowGradeNorm: false,
      plannedCalls: 0,
      plannedCallsToDate: 0,
      regionName: null,
      repKey: rep.repKey,
      repName: rep.repName,
      speciality: contact.speciality,
      status: "off_plan",
      visits: contact.visits,
    });
  }

  // The visit projection carries no contact name, so an off-plan row would print a bare id — which
  // the owner's naming rule forbids. Fill it from any planned row for the same contact (a doctor
  // off THIS rep's plan is usually on another's) before falling back to the id form.
  const nameByContactId = new Map<number, string>();
  for (const contact of planned.values()) nameByContactId.set(contact.contactCrmId, contact.name);
  for (const row of doctorRows) {
    if (row.status !== "off_plan") continue;
    const known = nameByContactId.get(row.contactCrmId);
    if (known) row.contactName = known;
  }

  // Campaign work, counted against the rep and never against a doctor. repFor() is used so a rep
  // whose ONLY activity is campaign still gets a row rather than vanishing from the board.
  for (const row of campaignRows) {
    const repKey = repDoctorListRepKey(row.agent_crm_id, row.agent_hr_id);
    if (!repKey) continue;
    repsWithVisits.add(repKey);
    repFor(repKey).campaignCalls += 1;
  }

  for (const rep of repAccumulator.values()) {
    rep.hasMeasurablePlan = rep.plannedDoctors > 0;
    rep.coveragePct =
      rep.coverageDueDoctors > 0 ? Math.round((rep.visitedDoctors / rep.coverageDueDoctors) * 100) : 0;
    // Doctors with nothing due yet are held out of the frequency denominator (see frequencyStatusOf).
    // Mid-month that is the difference between a fair score and one that punishes next week's plan.
    const dueDoctors = rep.plannedDoctors - rep.notDueDoctors;
    rep.frequencyPct = dueDoctors > 0 ? Math.round((rep.onPlanDoctors / dueDoctors) * 100) : 0;
  }

  const repsWithPlan = new Set([...planned.values()].map((contact) => contact.repKey));
  const repsWithoutPlan = [...repsWithVisits].filter((repKey) => !repsWithPlan.has(repKey)).length;
  // Has a plan, reached none of it, and did campaign work instead. Arithmetically 0%, and the one
  // shape on this board most likely to be misread as an idle rep.
  const repsAllCampaign = [...repAccumulator.values()].filter(
    (rep) => rep.hasMeasurablePlan && rep.visitedDoctors === 0 && rep.campaignCalls > 0,
  ).length;

  // ── Filters ──────────────────────────────────────────────────────────────────────────────────
  const search = filters.search?.trim().toLowerCase() ?? "";
  const filteredDoctors = doctorRows.filter((row) => {
    if (filters.repKey && row.repKey !== filters.repKey) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.frequency && row.frequencyStatus !== filters.frequency) return false;
    if (filters.kind && row.kind !== filters.kind) return false;
    if (search) {
      const haystack = `${row.contactName} ${row.speciality ?? ""} ${row.repName} ${row.regionName ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  // Missed first (the actionable half), then most-planned, then name — a stable order that puts the
  // doctors nobody reached at the top without needing a sort click.
  const statusRank: Record<RepDoctorStatus, number> = { missed: 0, off_plan: 1, seen: 2 };
  filteredDoctors.sort(
    (left, right) =>
      statusRank[left.status] - statusRank[right.status] ||
      right.plannedCalls - left.plannedCalls ||
      left.contactName.localeCompare(right.contactName),
  );

  // Worst-first, but ONLY among reps who have something to be measured against. A rep with no
  // planned doctors has no percentage -- ranking their arithmetic 0 alongside a real 2% presents
  // "nothing was assigned" as "nothing was done", which is an accusation the data does not support.
  // They sort to the end and the table prints a marker instead of 0% (owner's fix 2026-08-21).
  const reps = [...repAccumulator.values()]
    .filter((rep) => !filters.repKey || rep.repKey === filters.repKey)
    .sort(
      (left, right) =>
        Number(right.hasMeasurablePlan) - Number(left.hasMeasurablePlan) ||
        left.coveragePct - right.coveragePct ||
        right.plannedDoctors - left.plannedDoctors ||
        left.repName.localeCompare(right.repName),
    );

  const totals = {
    actualCalls: 0,
    campaignCalls: 0,
    coverageDueDoctors: 0,
    coveragePct: 0,
    frequencyPct: 0,
    missedDoctors: 0,
    notDueDoctors: 0,
    offPlanDoctors: 0,
    onPlanDoctors: 0,
    overDoctors: 0,
    plannedAccounts: 0,
    plannedCalls: 0,
    plannedCallsToDate: 0,
    plannedDoctors: 0,
    reps: 0,
    underDoctors: 0,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: 0,
  };
  for (const rep of reps) {
    totals.actualCalls += rep.actualCalls;
    totals.campaignCalls += rep.campaignCalls;
    totals.coverageDueDoctors += rep.coverageDueDoctors;
    totals.missedDoctors += rep.missedDoctors;
    totals.notDueDoctors += rep.notDueDoctors;
    totals.offPlanDoctors += rep.offPlanDoctors;
    totals.onPlanDoctors += rep.onPlanDoctors;
    totals.overDoctors += rep.overDoctors;
    totals.plannedAccounts += rep.plannedAccounts;
    totals.plannedCalls += rep.plannedCalls;
    totals.plannedCallsToDate += rep.plannedCallsToDate;
    totals.plannedDoctors += rep.plannedDoctors;
    totals.reps += 1;
    totals.underDoctors += rep.underDoctors;
    totals.underPlannedVsGrade += rep.underPlannedVsGrade;
    totals.unverifiedCalls += rep.unverifiedCalls;
    totals.visitedDoctors += rep.visitedDoctors;
  }
  // Company percentages are recomputed from the summed counts, NOT averaged across reps — averaging
  // percentages would weigh a rep with 21 doctors the same as one with 234, and the observed spread
  // is exactly that wide (median 107, measured 2026-08-21).
  totals.coveragePct =
    totals.coverageDueDoctors > 0
      ? Math.round((totals.visitedDoctors / totals.coverageDueDoctors) * 100)
      : 0;
  const totalDueDoctors = totals.plannedDoctors - totals.notDueDoctors;
  totals.frequencyPct =
    totalDueDoctors > 0 ? Math.round((totals.onPlanDoctors / totalDueDoctors) * 100) : 0;

  // A single rep's whole list is ~250 rows at the observed maximum, so it ships uncapped — the cap
  // exists only to stop the company-wide view (~9,000 rows) becoming a multi-megabyte payload.
  // `uncapped` is the KPIs board, which keeps these rows on the server (see RepDoctorListsInput).
  const capped =
    filters.repKey || input.uncapped ? filteredDoctors : filteredDoctors.slice(0, REP_DOCTOR_DRILLDOWN_CAP);

  return {
    appliedFilters: filters,
    asOf,
    doctors: capped,
    doctorsTotal: filteredDoctors.length,
    isCurrentMonth: month === monthKeyOfDate(cairoTodayIso()),
    month,
    monthLabel: monthLabelOf(month),
    planSyncedAt,
    repOptions: [...repAccumulator.values()]
      .map((rep) => ({ repKey: rep.repKey, repName: rep.repName }))
      .sort((left, right) => left.repName.localeCompare(right.repName)),
    reps,
    repsAllCampaign,
    repsWithoutPlan,
    totals,
    unclassifiedSpecialities: [...unclassifiedContacts.entries()]
      .map(([label, contacts]) => ({ contacts: contacts.size, label }))
      .sort((left, right) => right.contacts - left.contacts),
  };
}
