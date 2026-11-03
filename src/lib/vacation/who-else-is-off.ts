import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { canonicalHrIdKey, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id";
import { logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { FILED_VACATION_STATUSES, leaveDaysCovered } from "@/lib/vacation/approved-leave-days";
import { vacationDayPartLabel } from "@/lib/vacation/calculations";

/**
 * Who else on this person's team is off on the dates a leave request asks for, shown to the person
 * deciding it, before the decision (owner, 2026-11-03). It shows; it never blocks, warns, scores or
 * recommends. The decision stays exactly where it was.
 *
 * THE TEAM is everybody else with the same CURRENT manager on the employee master, not a manager
 * name frozen on the request: the question is who is missing from this team today.
 *
 * NEVER THE LEAVE TYPE. A sick day is the teammate's own business, and the approver of one person's
 * annual leave has no claim to it. Name, dates, half day and whether it is decided: nothing else
 * crosses to the screen, and the select below does not even read the type.
 *
 * A FAILED READ IS SAID, NEVER "NOBODY". "Nobody else is off" is the sentence that gets a request
 * approved, so it may only be printed when every read answered. The same goes for a person with no
 * manager on record: no team to look at is not an empty team.
 */

const vacationRequestsTable = "v2_vacation_requests";

/** A PostgREST `.in()` over a long list fails three ways; ~50 is this repo's figure. */
const CHUNK = 50;

export type WhoElseIsOffRow = {
  /** "Full day", "AM only", "PM only". */
  dayPartLabel: string;
  fromDate: string;
  id: string;
  /** A filed request not yet approved is a request and not an absence, so the two read differently. */
  isApproved: boolean;
  name: string;
  toDate: string;
};

export type WhoElseIsOff =
  | { state: "no_manager" }
  | { state: "unavailable" }
  | {
      /** The most teammates away on any one day of the request, with the first day it happens. */
      peak: { count: number; day: string } | null;
      rows: WhoElseIsOffRow[];
      state: "ready";
      /** Teammates, the requester not counted. */
      teamSize: number;
    };

type TeammateInput = { hrId: string; name: string };

type LeaveRowInput = {
  day_part?: unknown;
  employee_hr_id?: unknown;
  end_date?: unknown;
  id?: unknown;
  start_date?: unknown;
  status?: unknown;
};

type LeaveRequestInput = {
  employeeHrId: string;
  endDate: string;
  id: string;
  startDate: string;
};

function cleanDay(value: unknown): string | null {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * The shaping step, pure, so a test can drive it with rows rather than a database. Dates are clipped
 * to the request: a teammate's three-week leave reads as the days it actually collides with.
 */
export function buildWhoElseIsOff(input: {
  excludeRequestId: string;
  leave: readonly LeaveRowInput[];
  range: { from: string; to: string };
  team: readonly TeammateInput[];
}): WhoElseIsOff {
  const nameByKey = new Map(input.team.map((person) => [canonicalHrIdKey(person.hrId), person.name] as const));
  const rows: WhoElseIsOffRow[] = [];
  const peopleByDay = new Map<string, Set<string>>();

  for (const row of input.leave) {
    const id = String(row.id ?? "").trim();
    const key = canonicalHrIdKey(String(row.employee_hr_id ?? ""));
    const name = key ? nameByKey.get(key) : undefined;
    const from = cleanDay(row.start_date);
    const to = cleanDay(row.end_date) ?? from;
    if (!id || id === input.excludeRequestId || !key || !name || !from || !to) continue;
    if (from > input.range.to || to < input.range.from) continue;

    for (const day of leaveDaysCovered(from, to, input.range)) {
      const people = peopleByDay.get(day) ?? new Set<string>();
      people.add(key);
      peopleByDay.set(day, people);
    }
    rows.push({
      dayPartLabel: vacationDayPartLabel(String(row.day_part ?? "")),
      fromDate: from < input.range.from ? input.range.from : from,
      id,
      isApproved: row.status === "approved",
      name,
      toDate: to > input.range.to ? input.range.to : to,
    });
  }

  let peak: { count: number; day: string } | null = null;
  for (const day of [...peopleByDay.keys()].sort()) {
    const count = peopleByDay.get(day)?.size ?? 0;
    if (!peak || count > peak.count) peak = { count, day };
  }

  rows.sort((left, right) => left.fromDate.localeCompare(right.fromDate) || left.name.localeCompare(right.name));
  return { peak, rows, state: "ready", teamSize: input.team.length };
}

/** Only a request still waiting has a decision to inform, and the requester is never shown their team's leave. */
export function shouldShowWhoElseIsOff(input: { isOwnRequest: boolean; status: string }): boolean {
  if (input.isOwnRequest) return false;
  return input.status === "pending_manager" || input.status === "pending_hr";
}

async function readWhoElseIsOff(request: LeaveRequestInput): Promise<WhoElseIsOff> {
  const supabase = getSupabaseAdmin();

  const self = await supabase
    .from("employees")
    .select("manager_hr_id")
    .in("hr_id", hrIdLookupKeys(request.employeeHrId));
  if (self.error) throw new Error(`who-else-is-off employee: ${self.error.message}`);
  const managerHrId = String(
    ((self.data ?? []) as Array<{ manager_hr_id?: string | null }>).find((row) => row.manager_hr_id)?.manager_hr_id ?? "",
  ).trim();
  if (!managerHrId) return { state: "no_manager" };

  const teamResult = await supabase
    .from("employees")
    .select("hr_id, full_name, employment_status")
    .in("manager_hr_id", hrIdLookupKeys(managerHrId));
  if (teamResult.error) throw new Error(`who-else-is-off team: ${teamResult.error.message}`);

  const team: TeammateInput[] = [];
  for (const row of (teamResult.data ?? []) as Array<{
    employment_status?: string | null;
    full_name?: string | null;
    hr_id?: string | null;
  }>) {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId || hrIdsMatch(hrId, request.employeeHrId)) continue;
    if (isTerminalEmploymentStatus(row.employment_status)) continue;
    team.push({ hrId, name: String(row.full_name ?? "").trim() || hrId });
  }

  const wanted = [...new Set(team.flatMap((person) => hrIdLookupKeys(person.hrId)))];
  const leave: LeaveRowInput[] = [];
  for (let at = 0; at < wanted.length; at += CHUNK) {
    const { data, error } = await supabase
      .from(vacationRequestsTable)
      // Named columns, and no `vacation_type`: see the header.
      .select("id, employee_hr_id, start_date, end_date, day_part, status")
      .in("status", [...FILED_VACATION_STATUSES])
      // Overlapping the request, not contained by it.
      .lte("start_date", request.endDate)
      .gte("end_date", request.startDate)
      .in("employee_hr_id", wanted.slice(at, at + CHUNK));
    if (error) throw new Error(`who-else-is-off leave: ${error.message}`);
    leave.push(...((data ?? []) as LeaveRowInput[]));
  }

  return buildWhoElseIsOff({
    excludeRequestId: request.id,
    leave,
    range: { from: request.startDate, to: request.endDate },
    team,
  });
}

/** Never throws: a page deciding a leave request must not fall over for want of a side panel. */
export async function loadWhoElseIsOff(request: LeaveRequestInput): Promise<WhoElseIsOff> {
  try {
    return await readWhoElseIsOff(request);
  } catch (error) {
    logWarning("Who else is off could not be read; the panel says so", {
      context: { message: error instanceof Error ? error.message : String(error) },
      labels: { event: "who_else_is_off_unavailable" },
    });
    return { state: "unavailable" };
  }
}
