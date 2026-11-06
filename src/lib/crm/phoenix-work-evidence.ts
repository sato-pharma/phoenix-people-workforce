/**
 * PHOENIX CRM WORK EVIDENCE — "did this person work this day", regardless of whether his team has
 * been STARTED.
 *
 * ## Why this file exists, and what it must never become
 *
 * `crm_visits_unified` is the read door, and its Phoenix branches are INNER-JOINED to
 * `phoenix_crm_started_team_seats()`: a team's Phoenix rows reach the door only from the Saturday the
 * Super Admin pressed Start on it. That gate is CORRECT and stays — it is the owner's own ruling
 * ("Only when I start it", 2026-10-02), and it exists precisely so that one stray visit can never
 * drop a whole team's iReports360 history (see `phoenix-team-starts.ts`). COUNTING is his decision.
 *
 * But a deduction is not counting. Measured on production 2026-10-12, 7–12 October: 121 real Phoenix
 * CRM visits, logged by 6 Medical Reps across 17 person-days, reached NO deduction reader at all,
 * because their teams have no start — and on every one of those days those reps have 0 iReports360
 * rows, so they read as having done nothing. Five of the six are not covered by the CRM connector's
 * zero-signal guard (they have iReports360 rows elsewhere in the month), which left 14 days and
 * 7,193.54 EGP of exposure. Nothing had been charged yet: October held 1 fingerprint candidate and no
 * daily publication, and the last published month was September. This file is what closes it before
 * a single pound moves.
 *
 * ## The rule, in one line
 *
 * Work evidence is a SUPPRESSOR and nothing else. It can only ever REMOVE a deduction day; it never
 * creates one, never adds to a count, a call rate, a coverage figure or a KPI, and nothing that reads
 * a counted number may import from here. That is what makes it safe beside the started-team rule: a
 * day the door already covers is simply suppressed twice, which is the same answer.
 *
 * ## What counts as evidence, and what does not
 *
 *   - A real Phoenix VISIT (`phoenix_crm_visits`, `is_test = false`) PROVES the day. Deliberately the
 *     base table, not `phoenix_crm_countable_visits`: countability waits on approval for an off-plan
 *     visit, and a rep who drove to a doctor and logged him has worked whether or not his manager has
 *     approved the detour yet. The visit credits everyone named on it — the rep, and the manager,
 *     senior or product manager who stood beside him — because each of them was there.
 *   - A real DAY ACTIVITY (`phoenix_crm_day_activities`) PROVES the day. All seven kinds are working
 *     time and LEAVE IS NOT AMONG THEM by the owner's own ruling (`phoenix-crm/day-activities.ts`:
 *     "LEAVE IS NOT HERE"), so there is no kind to screen out — an unapproved vacation cannot be
 *     laundered into a worked day through this door. A half-day activity proves the day exactly as the
 *     read door's own branch treats one; it is the same answer a started team already gets.
 *   - A DAY START (`phoenix_crm_day_starts`, the GPS-stamped "I started working" press) is carried but
 *     PROVES NOTHING on its own. Pressing Start and then doing nothing is the case a manager should
 *     look at, which is neither a silent charge nor a silent pardon: it downgrades the day to a review
 *     rather than cancelling it. {@link phoenixWorkEvidenceProvesWorkedDay} is the one place that
 *     decision lives.
 *   - A visit COPIED from iReports360 history (`imported_from_ireports360_at` set) is NOT evidence here.
 *     Those days are the old system's, and the iReports360 door already answers for them; a copied row
 *     would credit a partner the door never named. See
 *     supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql.
 *
 * ## Keys
 *
 * The loader hands back the hr id AS STORED and never picks a key for you. This repo has three
 * (`canonicalHrIdKey` keeps hyphens, `compactDeductionsHrId` strips them, `normalizeAttendanceHrId`
 * is attendance's own) and silently mismatching them has cost real defects, so each caller indexes
 * the rows with ITS OWN key function through {@link indexPhoenixWorkEvidence}.
 *
 * ## Failure direction
 *
 * This loader THROWS. A swallowed error here means a worked day gets charged, which is the money
 * error, so every deduction caller must let it fail the run — the same fail-closed stance the CRM
 * connector already takes on job titles, base salaries and the holiday calendar. The private
 * calendar's wrapper is the one exception and catches deliberately: its contract is best-effort, and
 * losing coverage there can only ADD a flag, which the connectors' own suppressor then removes.
 */

import { isDayActivity, dayActivityLabel } from "@/lib/phoenix-crm/day-activities";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** `phoenix_crm_visits` — every visit Phoenix CRM holds, started team or not. */
export const PHOENIX_CRM_VISITS_TABLE = "phoenix_crm_visits";

/** `phoenix_crm_day_activities` — a working day that was not a call. */
export const PHOENIX_CRM_DAY_ACTIVITIES_TABLE = "phoenix_crm_day_activities";

/** `phoenix_crm_day_starts` — the GPS-stamped "I started working" press. Evidence, never proof. */
export const PHOENIX_CRM_DAY_STARTS_TABLE = "phoenix_crm_day_starts";

/** One person's Phoenix CRM footprint on one day. */
export type PhoenixWorkEvidenceDay = {
  /** The hr id exactly as Phoenix CRM stored it. Index it with your own key — see the header. */
  hrId: string;
  /** YYYY-MM-DD, the Phoenix visit/activity day (already Cairo). */
  date: string;
  /** Real visits naming this person, in any role. */
  visits: number;
  /** Day-activity labels, de-duplicated, in the order the rep sees them. */
  dayActivities: string[];
  /** "I started working" presses. Carried for the reviewer; proves nothing on its own. */
  dayStarts: number;
};

/**
 * Whether this day's evidence PROVES work was done — the one place that line is drawn.
 *
 * A visit or a day activity proves it. A day start alone does not: it is a press, not an outcome.
 */
export function phoenixWorkEvidenceProvesWorkedDay(
  day: Pick<PhoenixWorkEvidenceDay, "dayActivities" | "visits">,
): boolean {
  return day.visits > 0 || day.dayActivities.length > 0;
}

/** "Phoenix CRM: 18 visits" / "Phoenix CRM: Training" / "Phoenix CRM: 4 visits · Meeting". */
export function describePhoenixWorkEvidence(day: PhoenixWorkEvidenceDay): string {
  const parts: string[] = [];
  if (day.visits > 0) parts.push(day.visits === 1 ? "1 visit" : `${day.visits} visits`);
  for (const label of day.dayActivities) parts.push(label);
  if (parts.length === 0 && day.dayStarts > 0) parts.push("day started, nothing recorded after it");
  return `Phoenix CRM: ${parts.join(" · ")}`;
}

/**
 * Index the loaded rows by `${key}|${date}`, using the CALLER'S own hr-id key function — the reason
 * this is a separate step rather than something the loader decides. A row whose hr id the key
 * function rejects is dropped, exactly as that caller's own gate would drop it.
 */
export function indexPhoenixWorkEvidence(
  days: readonly PhoenixWorkEvidenceDay[],
  keyOf: (hrId: string) => string | null | undefined,
): Map<string, PhoenixWorkEvidenceDay> {
  const indexed = new Map<string, PhoenixWorkEvidenceDay>();
  for (const day of days) {
    const key = keyOf(day.hrId);
    if (!key) continue;
    const mapKey = `${key}|${day.date}`;
    const existing = indexed.get(mapKey);
    // Two stored spellings of one hr id collapse onto one key — add them up rather than letting the
    // second silently replace the first and lose its visits.
    if (!existing) {
      indexed.set(mapKey, { ...day, dayActivities: [...day.dayActivities] });
      continue;
    }
    existing.visits += day.visits;
    existing.dayStarts += day.dayStarts;
    for (const label of day.dayActivities) {
      if (!existing.dayActivities.includes(label)) existing.dayActivities.push(label);
    }
  }
  return indexed;
}

/** The set of `${key}|${date}` pairs a deduction must not charge. */
export function phoenixWorkedDayKeySet(
  days: readonly PhoenixWorkEvidenceDay[],
  keyOf: (hrId: string) => string | null | undefined,
): Set<string> {
  const worked = new Set<string>();
  for (const [mapKey, day] of indexPhoenixWorkEvidence(days, keyOf)) {
    if (phoenixWorkEvidenceProvesWorkedDay(day)) worked.add(mapKey);
  }
  return worked;
}

type VisitRow = {
  visit_date: string | null;
  rep_hr_id: string | null;
  manager_hr_id: string | null;
  senior_hr_id: string | null;
  product_manager_hr_id: string | null;
};

type ActivityRow = { activity_date: string | null; rep_hr_id: string | null; activity_type: string | null };

type StartRow = { started_on: string | null; rep_hr_id: string | null };

function isoDay(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function storedHrId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Fold the three reads into one row per (hr id as stored, day). Pure, so the whole shape of the
 * evidence — who a visit credits, which kinds prove a day, how a day start is carried — is pinned by
 * a test without a database.
 */
export function foldPhoenixWorkEvidence(input: {
  activities: readonly ActivityRow[];
  starts: readonly StartRow[];
  visits: readonly VisitRow[];
}): PhoenixWorkEvidenceDay[] {
  const byKey = new Map<string, PhoenixWorkEvidenceDay>();
  const dayOf = (hrId: string, date: string): PhoenixWorkEvidenceDay => {
    const key = `${hrId}|${date}`;
    const existing = byKey.get(key);
    if (existing) return existing;
    const fresh: PhoenixWorkEvidenceDay = { date, dayActivities: [], dayStarts: 0, hrId, visits: 0 };
    byKey.set(key, fresh);
    return fresh;
  };

  for (const row of input.visits) {
    const date = isoDay(row.visit_date);
    if (!date) continue;
    // Everyone named on the visit was there — the rep, and whichever manager, senior or product
    // manager stood beside him. One visit credits each of them once.
    const participants = new Set<string>();
    for (const raw of [row.rep_hr_id, row.manager_hr_id, row.senior_hr_id, row.product_manager_hr_id]) {
      const hrId = storedHrId(raw);
      if (hrId) participants.add(hrId);
    }
    for (const hrId of participants) dayOf(hrId, date).visits += 1;
  }

  for (const row of input.activities) {
    const date = isoDay(row.activity_date);
    const hrId = storedHrId(row.rep_hr_id);
    // A kind the vocabulary does not list is dropped rather than read as a worked day: the kind IS
    // the whole record (`parseDayActivityDraft` refuses an unknown one for the same reason), and
    // pardoning a day on a label nobody has classified is the riskier default.
    if (!date || !hrId || !isDayActivity(row.activity_type)) continue;
    const day = dayOf(hrId, date);
    const label = dayActivityLabel(row.activity_type);
    if (!day.dayActivities.includes(label)) day.dayActivities.push(label);
  }

  for (const row of input.starts) {
    const date = isoDay(row.started_on);
    const hrId = storedHrId(row.rep_hr_id);
    if (!date || !hrId) continue;
    dayOf(hrId, date).dayStarts += 1;
  }

  return [...byKey.values()].sort((left, right) => left.date.localeCompare(right.date) || left.hrId.localeCompare(right.hrId));
}

/**
 * Every Phoenix CRM work-evidence day in the window, for the whole company or for named people.
 *
 * THROWS on a failed read — see the header. `hrIds`, when given, filters the REP side only: a
 * manager's own credit comes from visits his reps logged, so narrowing those reads by hr id would
 * drop exactly the rows that prove his day. Company-wide is the shape every deduction caller wants
 * anyway. Each read pages by id, because one company month is several thousand visits.
 */
export async function loadPhoenixWorkEvidenceDays(input: {
  end: string;
  start: string;
}): Promise<PhoenixWorkEvidenceDay[]> {
  const start = isoDay(input.start);
  const end = isoDay(input.end);
  if (!start || !end || end < start) return [];

  const supabase = getSupabaseAdmin();
  // Every read pages by id: PostgREST stops at 1,000 rows, and a company month holds several thousand
  // visits, so an unpaged read proved only the first 1,000 and charged the rest (src/lib/supabase/paginated.ts).
  const everyRow = async <T extends { id: string }>(label: string, buildQuery: () => unknown): Promise<T[]> => {
    try {
      return await fetchAllRowsKeyset<T>(buildQuery, { cursorColumn: "id", cursorOf: (row) => row.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
      throw new Error(
        `Failed to read Phoenix CRM ${label} for work evidence: ${message}. ` +
          "Without them a day someone provably worked in Phoenix CRM would be charged a deduction.",
      );
    }
  };
  const [visits, activities, starts] = await Promise.all([
    everyRow<VisitRow & { id: string }>("visits", () =>
      supabase
        .from(PHOENIX_CRM_VISITS_TABLE)
        .select("id,visit_date,rep_hr_id,manager_hr_id,senior_hr_id,product_manager_hr_id")
        .eq("is_test", false)
        .is("imported_from_ireports360_at", null)
        .gte("visit_date", start)
        .lte("visit_date", end),
    ),
    everyRow<ActivityRow & { id: string }>("day activities", () =>
      supabase
        .from(PHOENIX_CRM_DAY_ACTIVITIES_TABLE)
        .select("id,activity_date,rep_hr_id,activity_type")
        .eq("is_test", false)
        .gte("activity_date", start)
        .lte("activity_date", end),
    ),
    everyRow<StartRow & { id: string }>("day starts", () =>
      supabase
        .from(PHOENIX_CRM_DAY_STARTS_TABLE)
        .select("id,started_on,rep_hr_id")
        .eq("is_test", false)
        .gte("started_on", start)
        .lte("started_on", end),
    ),
  ]);

  return foldPhoenixWorkEvidence({ activities, starts, visits });
}
