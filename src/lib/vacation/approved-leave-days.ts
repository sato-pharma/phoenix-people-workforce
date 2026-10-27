import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVacationDayPart, normalizeVacationType, vacationTypeLabel } from "@/lib/vacation/calculations";

/**
 * Approved leave, spread over the calendar days it covers, for a named set of people.
 *
 * WHY IT LIVES HERE. HR owns leave, and `v2_vacation_requests` is HR's table. Phoenix CRM's team
 * calendar needs to say why a day is blank, but a Phoenix CRM service may read nothing outside its
 * own tables but the organogram, people's names and the product list — `tests/phoenix-crm-boundary`
 * enforces that, and it caught the first cut of this read sitting inside the module. So the read
 * belongs to the vacation module and the answer crosses as plain data.
 *
 * WHY NOT `listOnVacationToday`. That one answers ONE day for the WHOLE company, which is the
 * question a landing page asks. A month for one team is 31 company-wide reads that way, and none of
 * them filtered to the people being asked about.
 *
 * APPROVED ONLY, AND EVERY TYPE — the two rulings `on-vacation-today.ts` records, for the same
 * reasons: a pending request is a request and not an absence, and an emergency or a sick day
 * removes the same person from the same day's work as an annual one.
 *
 * IT THROWS. A caller that would rather lose the annotation than the report catches it and carries
 * on; a caller that must not draw a blank day as "nobody was away" lets it through. Deciding that
 * here would take the choice away from both.
 */

const vacationRequestsTable = "v2_vacation_requests";

/** One person, away on one Cairo calendar day. The HR id is returned exactly as the row stores it. */
export type ApprovedLeaveDay = {
  hrId: string;
  day: string;
  /** The leave's own name — "Annual Vacation", "Sick Vacation" — never the stored key. */
  typeLabel: string;
  /**
   * The whole day. An "AM only" or "PM only" request leaves the other half of the day at work, which
   * matters to a reader that plans the day (the Phoenix CRM plan, owner 2026-10-02) and to none that
   * only asks whether the person was away. A row with no day part is a full day, the vacation
   * module's own default (service.ts reads it the same way).
   */
  fullDay: boolean;
};

/** A PostgREST `.in()` over a long list fails three ways; ~50 is this repo's figure. */
const CHUNK = 50;

function cleanDay(value: unknown): string | null {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * Every day from `from` to `to` inclusive, clipped to `within`.
 *
 * `start_date` and `end_date` are `date` columns, so they are walked at UTC midnight: a date has no
 * time of day to place in a zone, and running one through Cairo would shift the calendar day. The
 * cap is a guard against a malformed pair, never a business limit — no single window here is a year.
 */
export function leaveDaysCovered(from: string, to: string, within: { from: string; to: string }): string[] {
  const start = from < within.from ? within.from : from;
  const end = to > within.to ? within.to : to;
  const out: string[] = [];
  for (let at = Date.parse(`${start}T00:00:00Z`); at <= Date.parse(`${end}T00:00:00Z`); at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
    if (out.length > 400) break;
  }
  return out;
}

/**
 * Approved request rows, spread over the days each covers inside the window — the shaping step, pure,
 * so a test can drive it with rows rather than a database.
 */
export function spreadApprovedLeave(rows: ReadonlyArray<Record<string, unknown>>, range: { from: string; to: string }): ApprovedLeaveDay[] {
  const out: ApprovedLeaveDay[] = [];
  for (const row of rows) {
    const from = cleanDay(row.start_date);
    const to = cleanDay(row.end_date) ?? from;
    const hrId = String(row.employee_hr_id ?? "").trim();
    if (!from || !to || !hrId) continue;
    const typeLabel = vacationTypeLabel(normalizeVacationType(row.vacation_type));
    const fullDay = (normalizeVacationDayPart(row.day_part) ?? "full_day") === "full_day";
    for (const day of leaveDaysCovered(from, to, range)) out.push({ day, hrId, typeLabel, fullDay });
  }
  return out;
}

/** Requests still waiting for a decision — the manager's, then HR's. A returned request waits on the employee, not on a decision. */
export const PENDING_VACATION_STATUSES = ["pending_manager", "pending_hr"] as const;

async function loadLeaveDays(
  statuses: readonly string[],
  hrIds: Iterable<string | null | undefined>,
  range: { from: string; to: string },
  accept: (row: Record<string, unknown>) => boolean = () => true,
): Promise<ApprovedLeaveDay[]> {
  const wanted = [...new Set([...hrIds].map((hrId) => String(hrId ?? "").trim()).filter(Boolean))];
  if (wanted.length === 0 || !cleanDay(range.from) || !cleanDay(range.to)) return [];

  const out: ApprovedLeaveDay[] = [];
  for (let at = 0; at < wanted.length; at += CHUNK) {
    const { data, error } = await getSupabaseAdmin()
      .from(vacationRequestsTable)
      // Named columns, every one checked against the live table (2026-10-02): PostgREST answers a
      // missing column by failing the WHOLE read, not by nulling that field.
      .select("employee_hr_id, start_date, end_date, vacation_type, day_part, status, manager_decision")
      .in("status", [...statuses])
      // Overlapping the window, not contained by it: a vacation that began last month and ends in
      // this one covers days here, and `start_date >= from` would miss every one of them.
      .lte("start_date", range.to)
      .gte("end_date", range.from)
      .in("employee_hr_id", wanted.slice(at, at + CHUNK));
    if (error) throw new Error(`leave: ${error.message}`);
    out.push(...spreadApprovedLeave(((data ?? []) as Array<Record<string, unknown>>).filter(accept), range));
  }
  return out;
}

export async function loadApprovedLeaveDays(
  hrIds: Iterable<string | null | undefined>,
  range: { from: string; to: string },
): Promise<ApprovedLeaveDay[]> {
  return loadLeaveDays(["approved"], hrIds, range);
}

/**
 * Leave the MANAGER has approved, whether or not HR has recorded it yet — the planning module's own
 * line (`loadManagerApprovedVacations` in weekly-planning/service.ts: the manager's yes is the
 * planning decision, independent of the later HR step). For the Planning Calendar (owner, 2026-10-27:
 * an employee's leave must show on every calendar), so a day the plan form would lock as Vacation is
 * the same day the calendar draws as leave. A request still waiting on HR counts only once its
 * manager said yes; nothing that pays or deducts may read this.
 */
export const PLANNING_LEAVE_STATUSES = ["approved", "pending_hr"] as const;

export async function loadPlanningLeaveDays(
  hrIds: Iterable<string | null | undefined>,
  range: { from: string; to: string },
): Promise<ApprovedLeaveDay[]> {
  return loadLeaveDays(PLANNING_LEAVE_STATUSES, hrIds, range, isPlanningLeave);
}

export function isPlanningLeave(row: Record<string, unknown>): boolean {
  if (row.status === "approved") return true;
  return row.status === "pending_hr" && row.manager_decision === "approved";
}

/**
 * The days of requests still WAITING for a decision, for the one reader that shows them as exactly
 * that — the Phoenix CRM plan (owner, 2026-10-08: "if the employee submitted a vacation, show in his
 * plan that it is pending approval"). Same shape as the approved days, and never to be mixed into
 * them: a pending request is a request and not an absence (`on-vacation-today.ts`), so nothing that
 * asks "was he away" may read this.
 */
export async function loadPendingLeaveDays(
  hrIds: Iterable<string | null | undefined>,
  range: { from: string; to: string },
): Promise<ApprovedLeaveDay[]> {
  return loadLeaveDays(PENDING_VACATION_STATUSES, hrIds, range);
}

/**
 * Every request that has been FILED and not refused — the statuses the private calendar already
 * treats as reserving the day (`loadVacationItems`): approved, waiting on the manager or HR, waiting
 * for a covering assignment, or submitted.
 *
 * For the one reader that asks a different question from "was he away": the Field Absence Calendar,
 * which lists the people the system did not see AT ALL on a working day (owner, 2026-10-18: *"no
 * submit vacation, no records for this day"*). A filed request is a record — he told the system — so
 * it takes his name off that day whether or not anyone has decided it yet. A rejected or cancelled
 * request is not here, so the day comes back the moment it is refused. Nothing that pays, deducts or
 * counts an absence may read this.
 */
export const FILED_VACATION_STATUSES = ["approved", "pending_manager", "pending_hr", "needs_assignment", "submitted"] as const;

export async function loadFiledLeaveDays(
  hrIds: Iterable<string | null | undefined>,
  range: { from: string; to: string },
): Promise<ApprovedLeaveDay[]> {
  return loadLeaveDays(FILED_VACATION_STATUSES, hrIds, range);
}
