import { forbiddenError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { personKey, territoryName, territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  buildTeamCalendar,
  monthDays,
  teamCalendarTotals,
  type TeamCalendarPerson,
  type TeamCalendarRow,
} from "@/lib/phoenix-crm/team-calendar";
import {
  canEnterMissedRecordOn,
  canEnterMissedRecords,
  readsCalendar,
  readsTeamReports,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { chunk } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readSeatGroups } from "@/lib/phoenix-crm/server/reports";
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
 * 🔴 IT READS `phoenix_crm_countable_visits`, NEVER THE RAW TABLE, AND IT READS
 * `customer_validated = true` ON IT. Every KPI in this module reads the countable view — an off-plan
 * visit that is not yet approved counts in nothing — and a calendar built on the raw table would show
 * a manager work that no other screen agrees exists. The view answers only the APPROVAL half of
 * "does this count"; the other half is the customer's own admission to the list, which the owner
 * ruled on again on 2026-10-01 ("not counted in KPIs till validated"), and which a PostgREST reader
 * has to ask for by name. Reading the view without it is not half-right — it is a second opinion.
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
  /**
   * Where the Super Admin may enter a record a rep MISSED (owner, 2026-10-01): the last day he may
   * enter for, and the territories he may enter on — so a day with nothing on it opens for him too,
   * on the page where the entry is made. Null for everyone else, whose cells open only on a day with
   * work on it, exactly as before.
   */
  missedRecords: { through: string; seatIds: string[] } | null;
  /**
   * 🔴 HR's leave could not be read, so an approved vacation is drawn as a run of BLANK days — which
   * a manager reads as a week the rep did nothing. Said beside the grid, never swallowed: the plan
   * report has carried the same sentence since 2026-10-01 (`plan-leave.ts` LEAVE_UNREAD_NOTE).
   */
  leaveUnread: boolean;
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
  const missedRecords = canEnterMissedRecords(viewer)
    ? { through: viewer.visitDay, seatIds: seats.filter((seat) => canEnterMissedRecordOn(viewer, seat, isTest)).map((seat) => seat.seatId) }
    : null;

  // 🔴 ASKING FOR NO MONTH MEANS "THE LAST MONTH WITH WORK IN IT" (owner, 2026-10-01). It used to
  //    open on the CURRENT month, which on the 1st is empty by definition — he had to press
  //    Previous month every single time to see anything. The arrows always send an explicit
  //    month, so this decides the FIRST load only and never overrides a month somebody chose.
  //
  //    With no work anywhere it falls back to the current month, which is both the old behaviour
  //    and the right answer for a rep who has not started.
  //
  //    It reads `cairoToday`, never `viewer.visitDay`: the 02:00 cutoff belongs to Today, the
  //    visit form and day activities, while plans and reports keep the calendar day. `through`
  //    on `missedRecords` above is the other half of that rule and is correctly the visit day —
  //    it bounds what a Super Admin may still ENTER, which is a day, not a month.
  const asked = /^\d{4}-\d{2}$/.test(String(raw.month ?? "")) ? String(raw.month) : null;
  const thisMonth = viewer.cairoToday.slice(0, 7);
  const seatIds = seats.map((seat) => seat.seatId);
  const month = asked ?? (seats.length === 0 ? thisMonth : ((await latestWorkedMonth(seatIds, isTest, thisMonth)) ?? thisMonth));

  const bounds = monthBounds(month);
  if (!bounds || seats.length === 0) {
    return { days: monthDays(month), isTest, leaveUnread: false, missedRecords, month, rows: [], scope, totals: emptyVisitCountSplit() };
  }

  // HR's leave is read beside the visits, not after them: it never throws (a failed read comes back
  // as `unread`), so running it alongside changes nothing but the wait.
  const [visits, activities, people, leave] = await Promise.all([
    loadVisitDays(seatIds, isTest, bounds),
    loadActivityDays(seatIds, isTest, bounds),
    describePeople(viewer, seats),
    loadLeaveDays(seats, bounds),
  ]);

  const rows = buildTeamCalendar(month, people, { activities, leave: leave.days, visits });
  return {
    days: monthDays(month),
    isTest,
    leaveUnread: leave.unread,
    missedRecords,
    month,
    rows,
    scope,
    totals: teamCalendarTotals(rows),
  };
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
): Promise<{ seatId: string; day: string; counts: VisitCountSplit; awaitingValidation: number }[]> {
  const amPm = new Map<string, { am: number; pm: number }>();
  const pharmacies = new Map<string, Set<string>>();
  const waiting = new Map<string, number>();

  // Groups of territories read four at a time, handed back as the one walk per batch of 150 returned
  // them — same rows, same order (`readSeatGroups`).
  const rows = await readSeatGroups([...seatIds], 150, (part) =>
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          // Named columns, every one read off the live view: PostgREST answers a column that is not
          // there by failing the WHOLE read rather than nulling that one field.
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, visit_date, list_type, pharmacy_name, customer_validated")
          .eq("is_test", isTest)
          // NOT filtered here any more. A visit to a customer nobody has validated is work the rep
          // really did, and it still counts in none of the three figures — but the row is read so
          // the day can SAY how many are waiting instead of showing the manager an empty cell. On a
          // team that has just started that is every visit it has (owner's pick, 2026-10-02).
          .gte("visit_date", bounds.from)
          .lte("visit_date", bounds.to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
  for (const row of rows) {
    const day = cleanDay(row.visit_date);
    const seatId = String(row.seat_id ?? "");
    if (!day || !seatId) continue;
    const at = `${seatId}|${day}`;
    if (row.customer_validated !== true) {
      waiting.set(at, (waiting.get(at) ?? 0) + 1);
      continue;
    }
    const found = amPm.get(at) ?? { am: 0, pm: 0 };
    // Through the golden rule's own helper: a pharmacy is a third list since 2026-10-02, and an
    // `=== "AM" ? am : pm` would have filed every one of them among the doctors.
    const bucket = visitCountBucketForListType(row.list_type);
    if (bucket === "AM") found.am += 1;
    else if (bucket === "PM") found.pm += 1;
    amPm.set(at, found);
    // Keyed as the day screen keys it (`todayPharmacies`), so the cell and the day it opens agree:
    // a doctor's "ص.الفيومي" and the visit to "صيدلية الفيومي" itself are one pharmacy, and a box that
    // names two pharmacies is two.
    for (const name of pharmacyNamesOnVisit(row.list_type, String(row.pharmacy_name ?? ""))) {
      const pharmacy = pharmacyNameKey(name);
      if (!pharmacy) continue;
      const seen = pharmacies.get(at) ?? new Set<string>();
      seen.add(pharmacy);
      pharmacies.set(at, seen);
    }
  }

  return [...new Set([...amPm.keys(), ...pharmacies.keys(), ...waiting.keys()])].map((at) => {
    const [seatId = "", day = ""] = at.split("|");
    return {
      awaitingValidation: waiting.get(at) ?? 0,
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
 * with the letter and not the point. That is also why the visit probe carries
 * `customer_validated = true`: the grid it opens is built by `loadVisitDays`, which counts only
 * those, so a probe without it could open a manager on a month whose every cell then reads 0.
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

  // 🔴 THE SELECT LIST IS A LITERAL IN EACH READ, NEVER BUILT FROM THE COLUMN NAME. The first cut
  //    of this passed `\`seat_id, ${dayColumn}\`` and the typecheck refused it: PostgREST's types
  //    parse the select string at COMPILE time, so a template literal resolves to a ParserError
  //    rather than a row shape. It is the same house rule the sweeps in `reads.ts` follow, and
  //    the reason the two reads below are written out instead of parameterised.
  const newestOf = async (
    table: string,
    run: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
    dayOf: (row: Row) => unknown,
  ): Promise<string | null> => {
    let newest: string | null = null;
    for (const part of chunk([...seatIds], 150)) {
      const { data, error } = await run(part);
      // A scope with no rows is the normal answer here, not a fault — but a BROKEN read must not
      // read as one, or the tab would quietly go back to opening on the current month for ever.
      if (error) throw new Error(`phoenix-crm calendar: reading the newest day in ${table} failed — ${error.message}`);
      const row = (data as Row[] | null)?.[0];
      const day = row ? cleanDay(dayOf(row)) : null;
      if (day && (newest === null || day > newest)) newest = day;
    }
    return newest;
  };

  const [lastVisit, lastActivity] = await Promise.all([
    newestOf(
      "phoenix_crm_countable_visits",
      (part) =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits")
          .select("seat_id, visit_date")
          .eq("is_test", isTest)
          // Not filtered: this asks WHEN he last worked, so that the calendar reaches that far. A
          // started team whose customers are all unvalidated would otherwise read as never having
          // worked at all, and the grid would stop before its own visits.
          .lte("visit_date", lastDayOfCap)
          .in("seat_id", part)
          .order("visit_date", { ascending: false })
          .limit(1),
      (row) => row.visit_date,
    ),
    newestOf(
      "phoenix_crm_day_activities",
      (part) =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_activities")
          .select("seat_id, activity_date")
          .eq("is_test", isTest)
          .lte("activity_date", lastDayOfCap)
          .in("seat_id", part)
          .order("activity_date", { ascending: false })
          .limit(1),
      (row) => row.activity_date,
    ),
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
 * 🔴 A FAILED LEAVE READ LEAVES THE DAYS UNMARKED RATHER THAN FAILING THE MONTH — AND IT SAYS SO.
 * The visits are the report; leave is the annotation, so losing the whole calendar because a second
 * table was briefly unreachable trades the thing he asked for against the thing he did not. But it
 * used to be caught and DISCARDED, which left a rep's approved vacation drawn as a run of blank
 * white cells — read by a manager as a week the rep did nothing. The throw is still caught right
 * here and nowhere deeper; `unread` is what the screen prints beside the grid, exactly as the plan
 * report already does (`plan-leave.ts` LEAVE_UNREAD_NOTE).
 */
async function loadLeaveDays(
  seats: readonly OrgSeat[],
  bounds: { from: string; to: string },
): Promise<{ days: { seatId: string; day: string }[]; unread: boolean }> {
  const seatsByHrId = new Map<string, string[]>();
  for (const seat of seats) {
    if (!seat.occupantHrId) continue;
    const held = seatsByHrId.get(seat.occupantHrId) ?? [];
    held.push(seat.seatId);
    seatsByHrId.set(seat.occupantHrId, held);
  }
  // A vacant territory has nobody to be on leave, so there is nothing missing and nothing to say.
  if (seatsByHrId.size === 0) return { days: [], unread: false };

  let away: ApprovedLeaveDay[];
  try {
    away = await loadApprovedLeaveDays([...seatsByHrId.keys()], bounds);
  } catch (error) {
    logError("Phoenix CRM team calendar could not read approved leave", {
      error,
      labels: { event: "phoenix_crm_calendar_leave_unread" },
    });
    return { days: [], unread: true };
  }

  const out: { seatId: string; day: string }[] = [];
  for (const row of away) {
    // `personKey` is the one canonicalisation the org index already applied to `occupantHrId`;
    // upper-casing by hand here would miss whatever else `hrIdForStorage` normalises.
    for (const seatId of seatsByHrId.get(personKey(row.hrId) ?? "") ?? []) out.push({ day: row.day, seatId });
  }
  return { days: out, unread: false };
}
