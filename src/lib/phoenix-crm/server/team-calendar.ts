import { forbiddenError } from "@/lib/http/api-errors";
import { isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { personKey, territoryName, territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  buildTeamCalendar,
  monthDays,
  teamCalendarTotals,
  type TeamCalendarPerson,
  type TeamCalendarRow,
} from "@/lib/phoenix-crm/team-calendar";
import { readsCalendar, readsTeamReports, testModeFor, testReadSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { loadApprovedLeaveDays, type ApprovedLeaveDay } from "@/lib/vacation/approved-leave-days";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { emptyVisitCountSplit, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";

/**
 * Phoenix CRM Wave 2 — the team calendar's data. The owner called it "the most important" of the
 * three reports and asked for it as a TAB of its own inside Phoenix CRM (2026-09-30), not as a
 * section of the Reports page. The grid it rebuilds is `AgentsCalendar.aspx`, which he recorded on
 * 2026-09-29; `team-calendar.ts` beside this file holds what that screen does and why the colour
 * here says WHICH HALVES of the day were worked rather than how busy the day was.
 *
 * 🔴 IT READS `phoenix_crm_countable_visits`, NEVER THE RAW TABLE. Every KPI in this module reads
 * the countable view — an off-plan visit that is not yet approved counts in nothing — and a
 * calendar built on the raw table would show a manager work that no other screen agrees exists.
 *
 * 🔴 AM AND PM COME FROM `list_type`, AND A PHARMACY IS A DISTINCT NAME, NOT A ROW. That is
 * Phoenix CRM's own convention, already set by `today-rules.ts`: a pharmacy here is feedback
 * recorded ON a visit (`pharmacy_name`), so counting pharmacy rows would be a second rule
 * disagreeing with the rep's own day. Grouped case-insensitively for the same reason the List
 * groups them — one pharmacy must never read as two.
 *
 * 🔴 A MANAGER SEES HIS TEAM AND A REP SEES HIMSELF (owner, 2026-10-01: *"I want the medical rep
 * to have also his team calendar seeing only himself"*). Gated on `readsCalendar`, the calendar's
 * OWN predicate — widening `readsTeamReports` instead would have handed a rep the place-vs-actual
 * report, the exceptions board, the brick report and the adoption board along with it, which is
 * precisely what Golden rule #1 keeps off his screens.
 *
 * What keeps his view his own is not a branch in here but the SCOPE: the rows are built from
 * `scopeTerritories`, which for a rep holds his own seat and nobody else's, so there is no path by
 * which he is shown a colleague — not by asking for one, and not by a future edit to this file.
 * Golden rule #1 is untouched either way: his own month is his own work, like his plan and his
 * targets, and this grid carries no distance, no flag and no integrity signal of any kind.
 */

export type TeamCalendarView = {
  month: string;
  rows: TeamCalendarRow[];
  totals: VisitCountSplit;
  /** Every day of the month, so the grid's header needs no arithmetic of its own. */
  days: string[];
  isTest: boolean;
  /**
   * Whose month this is. `own` for a rep reading himself, `team` for anyone reading other people.
   *
   * It exists so the screen can say "Your month" without guessing: a district manager with one rep
   * left also loads one row, so counting rows would call his team view his own and would flip back
   * and forth as people join and leave.
   */
  scope: "own" | "team";
};

type Row = Record<string, unknown>;

/** The first and last Cairo calendar day of a `YYYY-MM` month, or null for anything else. */
export function monthBounds(month: string): { from: string; to: string } | null {
  const days = monthDays(month);
  const from = days[0];
  const to = days[days.length - 1];
  return from && to ? { from, to } : null;
}

function cleanDay(value: unknown): string | null {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export async function loadTeamCalendar(
  viewer: PhoenixCrmViewer,
  raw: { month?: unknown; test?: unknown } = {},
): Promise<TeamCalendarView> {
  if (!readsCalendar(viewer)) throw forbiddenError("This calendar is for a territory you hold or manage.");

  // A rep reads only himself, so the screen can say so. Read from the PREDICATE, never from how
  // many rows came back — a manager whose team is down to one person still reads a team.
  const scope: "own" | "team" = readsTeamReports(viewer) ? "team" : "own";
  const isTest = testModeFor(viewer, raw.test);
  const seats = testReadSeats(viewer, isTest, viewer.scopeTerritories);

  // 🔴 ASKING FOR NO MONTH MEANS "THE LAST MONTH WITH WORK IN IT" (owner, 2026-10-01). It used to
  //    open on the CURRENT month, which on the 1st is empty by definition — he had to press
  //    Previous month every single time to see anything. The arrows always send an explicit
  //    month, so this decides the FIRST load only and never overrides a month somebody chose.
  //
  //    With no work anywhere it falls back to the current month, which is both the old behaviour
  //    and the right answer for a rep who has not started.
  const asked = /^\d{4}-\d{2}$/.test(String(raw.month ?? "")) ? String(raw.month) : null;
  const thisMonth = viewer.cairoToday.slice(0, 7);
  const seatIds = seats.map((seat) => seat.seatId);
  const month = asked ?? (seats.length === 0 ? thisMonth : ((await latestWorkedMonth(seatIds, isTest, thisMonth)) ?? thisMonth));

  const bounds = monthBounds(month);
  if (!bounds || seats.length === 0) {
    return { days: monthDays(month), isTest, month, rows: [], scope, totals: emptyVisitCountSplit() };
  }

  const [visits, activities, people] = await Promise.all([
    loadVisitDays(seatIds, isTest, bounds),
    loadActivityDays(seatIds, isTest, bounds),
    describePeople(viewer, seats),
  ]);
  const leave = await loadLeaveDays(seats, bounds);

  const rows = buildTeamCalendar(month, people, { activities, leave, visits });
  return { days: monthDays(month), isTest, month, rows, scope, totals: teamCalendarTotals(rows) };
}

/** Who holds each seat, where it is, and the name above it — his A.Manager · TM · Line columns. */
async function describePeople(viewer: PhoenixCrmViewer, seats: readonly OrgSeat[]): Promise<TeamCalendarPerson[]> {
  const managerOf = new Map<string, string | null>();
  for (const seat of seats) managerOf.set(seat.seatId, territoryReviewer(viewer.org, seat.seatId)?.hrId ?? null);

  const names = await loadPeopleNames([...seats.map((seat) => seat.occupantHrId), ...managerOf.values()]);
  return seats
    .map((seat) => {
      const managerHrId = managerOf.get(seat.seatId) ?? null;
      return {
        // A vacant seat is still a row: the empty month IS the finding, and dropping it hides a
        // territory nobody is working (the owner's Cairo Pedia rule is the same shape of fact).
        manager: managerHrId ? nameOf(names, managerHrId) : null,
        person: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : "Seat is vacant",
        seatId: seat.seatId,
        territory: territoryName(seat),
      };
    })
    .sort(
      (left, right) =>
        (left.manager ?? "").localeCompare(right.manager ?? "") ||
        left.territory.localeCompare(right.territory) ||
        left.person.localeCompare(right.person),
    );
}

/** AM and PM per seat per day, with the day's pharmacies as DISTINCT names rather than rows. */
async function loadVisitDays(
  seatIds: readonly string[],
  isTest: boolean,
  bounds: { from: string; to: string },
): Promise<{ seatId: string; day: string; counts: VisitCountSplit }[]> {
  const amPm = new Map<string, { am: number; pm: number }>();
  const pharmacies = new Map<string, Set<string>>();

  for (const part of chunk([...seatIds], 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          // Named columns, every one read off the live view: PostgREST answers a column that is not
          // there by failing the WHOLE read rather than nulling that one field.
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, visit_date, list_type, pharmacy_name")
          .eq("is_test", isTest)
          .gte("visit_date", bounds.from)
          .lte("visit_date", bounds.to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const day = cleanDay(row.visit_date);
      const seatId = String(row.seat_id ?? "");
      if (!day || !seatId) continue;
      const at = `${seatId}|${day}`;
      const found = amPm.get(at) ?? { am: 0, pm: 0 };
      if (String(row.list_type ?? "").toUpperCase() === "AM") found.am += 1;
      else found.pm += 1;
      amPm.set(at, found);
      const pharmacy = String(row.pharmacy_name ?? "").trim();
      if (pharmacy) {
        const seen = pharmacies.get(at) ?? new Set<string>();
        seen.add(pharmacy.toLowerCase());
        pharmacies.set(at, seen);
      }
    }
  }

  return [...new Set([...amPm.keys(), ...pharmacies.keys()])].map((at) => {
    const [seatId = "", day = ""] = at.split("|");
    return {
      counts: {
        am: amPm.get(at)?.am ?? 0,
        pharmacies: pharmacies.get(at)?.size ?? 0,
        pm: amPm.get(at)?.pm ?? 0,
      },
      day,
      seatId,
    };
  });
}

/** A working day that was not a call — Phoenix's replacement for his pink `CP` (Campaign). */
async function loadActivityDays(
  seatIds: readonly string[],
  isTest: boolean,
  bounds: { from: string; to: string },
): Promise<{ seatId: string; day: string; activity: PhoenixCrmDayActivity }[]> {
  const out: { seatId: string; day: string; activity: PhoenixCrmDayActivity }[] = [];
  for (const part of chunk([...seatIds], 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_activities")
          .select("id, seat_id, activity_date, activity_type")
          .eq("is_test", isTest)
          .gte("activity_date", bounds.from)
          .lte("activity_date", bounds.to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const day = cleanDay(row.activity_date);
      const seatId = String(row.seat_id ?? "");
      if (day && seatId && isDayActivity(row.activity_type)) out.push({ activity: row.activity_type, day, seatId });
    }
  }
  return out;
}

/**
 * The newest month this scope has anything on, or null for a scope that has never worked.
 *
 * 🔴 WHAT COUNTS AS WORK IS WHAT COLOURS A CELL. A visit or a recorded day activity; never leave,
 * never a Friday. Opening the month on a grid of F and dashes would answer the owner's request
 * with the letter and not the point.
 *
 * Two one-row reads rather than the full month loaders: this runs before anything is known, on
 * every first open of the tab, and it needs a MAXIMUM rather than the rows themselves. It is
 * capped at `notAfter` so a day activity recorded ahead of time cannot open a manager on a month
 * that has not happened yet.
 */
async function latestWorkedMonth(
  seatIds: readonly string[],
  isTest: boolean,
  notAfter: string,
): Promise<string | null> {
  const lastDayOfCap = monthBounds(notAfter)?.to;
  if (!lastDayOfCap) return null;

  const newestIn = async (table: string, dayColumn: string): Promise<string | null> => {
    let newest: string | null = null;
    for (const part of chunk([...seatIds], 150)) {
      const { data, error } = await getSupabaseAdmin()
        .from(table)
        .select(`seat_id, ${dayColumn}`)
        .eq("is_test", isTest)
        .lte(dayColumn, lastDayOfCap)
        .in("seat_id", part)
        .order(dayColumn, { ascending: false })
        .limit(1);
      // A scope with no rows is the normal answer here, not a fault — but a BROKEN read must not
      // read as one, or the tab would quietly go back to opening on the current month for ever.
      if (error) throw new Error(`customer calendar: reading the newest day in ${table} failed — ${error.message}`);
      const day = cleanDay((data?.[0] as Row | undefined)?.[dayColumn]);
      if (day && (newest === null || day > newest)) newest = day;
    }
    return newest;
  };

  const [lastVisit, lastActivity] = await Promise.all([
    newestIn("phoenix_crm_countable_visits", "visit_date"),
    newestIn("phoenix_crm_day_activities", "activity_date"),
  ]);
  const newest = [lastVisit, lastActivity].filter((day): day is string => day !== null).sort().pop();
  return newest ? newest.slice(0, 7) : null;
}

/**
 * Who on this team was away, day by day — HR's own approved rows, turned into seats.
 *
 * 🔴 THE READ ITSELF BELONGS TO THE VACATION MODULE, NOT HERE. A Phoenix CRM service may read
 * nothing outside its own tables but the organogram, people's names and the product list, and
 * `tests/phoenix-crm-boundary` caught the first cut of this touching `v2_vacation_requests`
 * directly. HR owns leave, so HR's module does the reading and hands back plain data.
 *
 * Absence is never derived from a gap in the visits: a rep with no visit on a Tuesday is not on
 * leave, he is a rep with no visit, and a calendar that conflated the two would accuse people of
 * being away.
 *
 * 🔴 A FAILED LEAVE READ LEAVES THE DAYS UNMARKED RATHER THAN FAILING THE MONTH. The visits are the
 * report; leave is the annotation. Losing the whole calendar because a second table was briefly
 * unreachable trades the thing he asked for against the thing he did not — so the throw that
 * module deliberately leaves to its caller is caught right here, and nowhere deeper.
 */
async function loadLeaveDays(
  seats: readonly OrgSeat[],
  bounds: { from: string; to: string },
): Promise<{ seatId: string; day: string }[]> {
  const seatsByHrId = new Map<string, string[]>();
  for (const seat of seats) {
    if (!seat.occupantHrId) continue;
    const held = seatsByHrId.get(seat.occupantHrId) ?? [];
    held.push(seat.seatId);
    seatsByHrId.set(seat.occupantHrId, held);
  }
  if (seatsByHrId.size === 0) return [];

  let away: ApprovedLeaveDay[];
  try {
    away = await loadApprovedLeaveDays([...seatsByHrId.keys()], bounds);
  } catch {
    return [];
  }

  const out: { seatId: string; day: string }[] = [];
  for (const row of away) {
    // `personKey` is the one canonicalisation the org index already applied to `occupantHrId`;
    // upper-casing by hand here would miss whatever else `hrIdForStorage` normalises.
    for (const seatId of seatsByHrId.get(personKey(row.hrId) ?? "") ?? []) out.push({ day: row.day, seatId });
  }
  return out;
}
