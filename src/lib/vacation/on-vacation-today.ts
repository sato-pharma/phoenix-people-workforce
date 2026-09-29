/**
 * Who is on a vacation TODAY — as named people, not a count.
 *
 * WHY IT EXISTS. Owner instruction, 2026-09-29: "make on her landing page appear on a vacation
 * today." HR Operations runs attendance and leave administration, and the one question that seat
 * has every single morning — who is not at work today — had no answer anywhere on her landing
 * page. The Vacation Report could answer it, but only after a filter, and a fact you have to
 * assemble is a fact nobody checks.
 *
 * APPROVED ONLY. A pending request is a request, not an absence: printing one here would tell her
 * somebody is off who is still at their desk waiting for a manager. The pending queue is its own
 * figure elsewhere on the page.
 *
 * EVERY VACATION TYPE, not just Annual. The question is who is absent, and an emergency or sick
 * day removes the same person from the same day's work as an annual one. The type is printed on
 * each row so the reason is never lost — the owner's rule is names, never codes, so it reads
 * "Emergency Vacation", never `emergency`.
 *
 * TODAY IS A CAIRO DAY. `currentCairoDateOnlyIso` resolves the calendar day the owner's rule means;
 * `start_date`/`end_date` are `date` columns, so the comparison is day-to-day with no zone in it.
 *
 * DATE-ONLY VALUES ARE FORMATTED AT UTC MIDNIGHT — the same rule `hr-my-record.tsx` carries and for
 * the same reason: a `date` column has no time of day to place in a zone, and running it through
 * Cairo would shift the calendar day. Do not "fix" the `timeZone: "UTC"` below.
 *
 * READ-ONLY AND FAIL-SOFT AT THE CALLER, never here: this module throws on a database error so the
 * command centre can name the source as unavailable rather than draw an empty panel, which would
 * read as "nobody is off today" — the misleading zero AGENTS.md §7 forbids.
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { vacationDayPartLabel, vacationTypeLabel } from "@/lib/vacation/calculations";

const vacationRequestsTable = "v2_vacation_requests";

/** One person, absent today. Plain data — this crosses the server/client boundary as props. */
export type OnVacationTodayRow = {
  /** "Full day", "AM only", "PM only" — never the stored key. */
  dayPartLabel: string;
  /** Where it is actioned: the seat's own Vacation Report, filtered to this request. */
  href: string;
  hrId: string;
  id: string;
  /** Line or department, whichever the record carries. Empty string when it carries neither. */
  meta: string;
  name: string;
  /** "last day today", or "until 03 Oct 2026" when the absence runs past today. */
  untilLabel: string;
  /** "Annual Vacation", "Emergency Vacation", … */
  typeLabel: string;
};

type OnVacationTodayDbRow = {
  day_part?: unknown;
  department_name?: unknown;
  employee_hr_id?: unknown;
  employee_name?: unknown;
  end_date?: unknown;
  id?: unknown;
  line_name?: unknown;
  start_date?: unknown;
  vacation_type?: unknown;
};

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

/** A stored calendar day as a person reads it. UTC by design — see the header. */
function calendarDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(parsed);
}

/**
 * The shaping step, pure, so a test can drive it with rows rather than a database.
 *
 * Sorted by NAME, not by date: every row here covers the same day, so a date sort is arbitrary
 * while a name sort is what somebody scanning for a particular person needs.
 */
export function buildOnVacationTodayRows(
  records: readonly OnVacationTodayDbRow[],
  todayIso: string,
): OnVacationTodayRow[] {
  return records
    // The return type is ANNOTATED, not inferred. `vacationDayPartLabel` returns the literal union
    // `"Full day" | "AM only" | "PM only"` (its source array is `as const`), so an inferred row is
    // NARROWER than `OnVacationTodayRow`, whose `dayPartLabel` is a plain string — and the
    // `row is OnVacationTodayRow` predicate below is then rejected, because a predicate's type must
    // be assignable to its parameter's type. Widening here is what makes the whole chain check.
    .map((record): OnVacationTodayRow | null => {
      const id = cleanString(record.id);
      const hrId = cleanString(record.employee_hr_id);
      // The stored name, never the HR ID dressed up as one: a row that cannot name the person is
      // still a real absence, so it prints the ID rather than being dropped.
      const name = cleanString(record.employee_name) || hrId;
      if (!id || !name) return null;
      const endDate = cleanString(record.end_date);
      return {
        dayPartLabel: vacationDayPartLabel(cleanString(record.day_part)),
        href: `/hr/leave-management/vacation-report?requestId=${encodeURIComponent(id)}`,
        hrId,
        id,
        meta: cleanString(record.line_name) || cleanString(record.department_name),
        name,
        typeLabel: vacationTypeLabel(cleanString(record.vacation_type)),
        untilLabel: !endDate || endDate === todayIso ? "last day today" : `until ${calendarDay(endDate)}`,
      };
    })
    .filter((row): row is OnVacationTodayRow => row !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everyone on an APPROVED vacation covering today. Throws on a database error — the caller names
 * the source as unavailable rather than rendering an empty list (see the header).
 */
export async function listOnVacationToday(todayIso?: string): Promise<OnVacationTodayRow[]> {
  const today = todayIso ?? currentCairoDateOnlyIso();
  const { data, error } = await getSupabaseAdmin()
    .from(vacationRequestsTable)
    // Named columns, every one verified against the live table: PostgREST answers a missing column
    // by failing the WHOLE read, not by nulling that field (AGENTS.md §2.1, Database).
    .select("id,employee_hr_id,employee_name,department_name,line_name,vacation_type,day_part,start_date,end_date")
    .eq("status", "approved")
    .lte("start_date", today)
    .gte("end_date", today);
  if (error) throw new Error(error.message);
  return buildOnVacationTodayRows((data ?? []) as OnVacationTodayDbRow[], today);
}
