import { forbiddenError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { countsAsManagersDoubleVisit } from "@/lib/phoenix-crm/double-visit-plan-rules";
import { countsAsPlannersVisitWithRep } from "@/lib/phoenix-crm/manager-plan-rules";
import { managerChain, managersInScope, personKey, territoryName, territoryReviewer, type ChainMember, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  buildTeamCalendar,
  monthDays,
  productManagerRowKey,
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
import { loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readSeatGroups } from "@/lib/phoenix-crm/server/reports";
import { loadScopeProductManagers, type ScopeProductManager } from "@/lib/phoenix-crm/server/scope-product-managers";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
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
  // The lines' product managers (see below) depend on the territories alone, never on the month, so
  // their read starts HERE, beside the newest-worked-month lookup, instead of after it and before
  // everything else (performance work, 24 Oct 2026: two waves the Calendar paid one after the other).
  // The legs that need them chain off this promise; the rest of the month's reads never wait for it.
  // The `catch` only keeps a refusal from going unhandled when the month lookup fails first — awaiting
  // the promise itself still throws, exactly as the old `await` did.
  const productManagersRead: Promise<ScopeProductManager[]> =
    isTest || viewer.basis !== "all" || seats.length === 0 ? Promise.resolve([]) : loadScopeProductManagers(viewer, seats);
  productManagersRead.catch(() => undefined);
  const month = asked ?? (seats.length === 0 ? thisMonth : ((await latestWorkedMonth(seatIds, isTest, thisMonth)) ?? thisMonth));

  const bounds = monthBounds(month);
  if (!bounds || seats.length === 0) {
    return { days: monthDays(month), isTest, leaveUnread: false, missedRecords, month, rows: [], scope, totals: emptyVisitCountSplit() };
  }

  // HR's leave is read beside the visits, not after them: it never throws (a failed read comes back
  // as `unread`), so running it alongside changes nothing but the wait.
  // 🔴 THE MANAGERS ABOVE THESE TERRITORIES GET A ROW OF THEIR OWN (owner, 2026-10-19: "yes, all manager
  //    levels" — district, regional and national). They were never on this grid because a row was a REP
  //    seat; a manager showed only as the name in a rep's "Under" line. Never upward, as everywhere:
  //    `managersInScope` is the same reach the Managers report uses. Only a manager with a territory in
  //    THIS grid is drawn, so a district on a line that has not opened is not a row of blank days.
  const managers = isTest ? [] : managersOnGrid(viewer, seats);
  // 🔴 AND THE LINES' PRODUCT MANAGERS GET A ROW TOO (owner, 2026-10-20: "EVERYSINGLE ROLE THATS APLLICABLE
  //    TOAPPEAR IN A MODULE FIND ANAD SHOW"). A Product Manager holds no seat, so `managersInScope` never named
  //    him and the visits he rode with these reps stood on the reps' rows only. Who is given them is
  //    `loadScopeProductManagers`'s one rule, narrowed HERE to the company readers: the National Sales Manager's
  //    calendar stays field force only (owner, 2026-10-20, asked this exact question: "Keep it as is" — "his Team
  //    Calendar stays field force only"), though his per-manager board does carry them. The test world draws none,
  //    as it draws no seat manager. A person who also holds a seat keeps the seat's row.
  const seatHolders = new Set(managers.map((member) => member.hrId));
  const productManagersOnGrid = productManagersRead.then((read) => read.filter((manager) => !seatHolders.has(manager.hrId)));

  const [visits, activities, people, leave, managerPeople, productManagerPeople, managerVisits] = await Promise.all([
    loadVisitDays(seatIds, isTest, bounds),
    // 🔴 A MANAGER'S OWN SEAT TOO (owner, 2026-10-23: "if a manager chooses a meeting or anything … it must
    //    appear"). Since 2026-10-20 a district or regional manager records his meeting, training or travel on
    //    his own team seat (`ownDaySeat`), and this read asked the reps' seats alone — so his recorded day drew
    //    blank on his own row. A product manager holds no seat and records none here.
    loadActivityDays([...seatIds, ...managers.map((member) => member.seat.seatId)], isTest, bounds),
    describePeople(viewer, seats),
    productManagersOnGrid.then((productManagers) =>
      loadLeaveDays(
        [
          ...seats,
          ...managers.map((member) => member.seat),
          ...productManagers.map((manager) => ({ occupantHrId: manager.hrId, seatId: productManagerRowKey(manager.hrId) })),
        ],
        bounds,
      ),
    ),
    describeManagers(viewer, managers),
    productManagersOnGrid.then((productManagers) => describeProductManagers(viewer, productManagers)),
    productManagersOnGrid.then((productManagers) => loadManagerDays(managers, productManagers, new Set(seatIds), isTest, bounds)),
  ]);

  const rows = buildTeamCalendar(month, [...managerPeople, ...productManagerPeople, ...people], {
    activities,
    leave: leave.days,
    visits: [...visits, ...managerVisits],
  });
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
): Promise<CalendarVisitDay[]> {
  const fold = newVisitFold();

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
    foldVisitRow(fold, `${seatId}|${day}`, row);
  }
  return visitDaysOf(fold);
}

type CalendarVisitDay = { seatId: string; day: string; counts: VisitCountSplit; awaitingValidation: number };

/** AM, PM, the day's distinct pharmacies and the visits still waiting on a customer — keyed `<seat>|<day>`. */
type VisitFold = {
  amPm: Map<string, { am: number; pm: number }>;
  pharmacies: Map<string, Set<string>>;
  waiting: Map<string, number>;
};

function newVisitFold(): VisitFold {
  return { amPm: new Map(), pharmacies: new Map(), waiting: new Map() };
}

/**
 * One countable visit into the day it belongs to — the SAME rules for a rep's row and for the visits a
 * manager rode, so the two can never count one visit two ways.
 */
function foldVisitRow(fold: VisitFold, at: string, row: Row): void {
  if (row.customer_validated !== true) {
    fold.waiting.set(at, (fold.waiting.get(at) ?? 0) + 1);
    return;
  }
  const found = fold.amPm.get(at) ?? { am: 0, pm: 0 };
  // Through the golden rule's own helper: a pharmacy is a third list since 2026-10-02, and an
  // `=== "AM" ? am : pm` would have filed every one of them among the doctors.
  const bucket = visitCountBucketForListType(row.list_type);
  if (bucket === "AM") found.am += 1;
  else if (bucket === "PM") found.pm += 1;
  fold.amPm.set(at, found);
  // Keyed as the day screen keys it (`todayPharmacies`), so the cell and the day it opens agree:
  // a doctor's "ص.الفيومي" and the visit to "صيدلية الفيومي" itself are one pharmacy, and a box that
  // names two pharmacies is two.
  for (const name of pharmacyNamesOnVisit(row.list_type, String(row.pharmacy_name ?? ""))) {
    const pharmacy = pharmacyNameKey(name);
    if (!pharmacy) continue;
    const seen = fold.pharmacies.get(at) ?? new Set<string>();
    seen.add(pharmacy);
    fold.pharmacies.set(at, seen);
  }
}

function visitDaysOf(fold: VisitFold): CalendarVisitDay[] {
  return [...new Set([...fold.amPm.keys(), ...fold.pharmacies.keys(), ...fold.waiting.keys()])].map((at) => {
    const [seatId = "", day = ""] = at.split("|");
    return {
      awaitingValidation: fold.waiting.get(at) ?? 0,
      counts: {
        am: fold.amPm.get(at)?.am ?? 0,
        pharmacies: fold.pharmacies.get(at)?.size ?? 0,
        pm: fold.amPm.get(at)?.pm ?? 0,
      },
      day,
      seatId,
    };
  });
}

/**
 * The managers who get a row: the ones this viewer reads (`managersInScope`, never upward) that stand
 * above at least one territory on the grid. The CEO is never in that list, and neither is the sales-only
 * "Others" bucket, which holds no reps.
 */
function managersOnGrid(viewer: PhoenixCrmViewer, seats: readonly OrgSeat[]): ChainMember[] {
  return managersInScope(viewer.org, viewer.hrId, viewer.basis).filter(
    (member) =>
      !member.seat.isOtherPseudoDm && seats.some((territory) => territory.path.some((seatId) => seatId !== territory.seatId && seatId === member.seat.seatId)),
  );
}

/** Highest seat first (national, regional, district), then by line and name — a chain read top-down. */
async function describeManagers(viewer: PhoenixCrmViewer, members: readonly ChainMember[]): Promise<TeamCalendarPerson[]> {
  if (members.length === 0) return [];
  const above = new Map<string, string | null>();
  for (const member of members) above.set(member.seat.seatId, managerChain(viewer.org, member.seat.seatId)[0]?.hrId ?? null);
  const names = await loadPeopleNames([...members.map((member) => member.hrId), ...above.values()]);
  const depth = new Map(members.map((member) => [member.seat.seatId, member.seat.path.length]));
  return members
    .map((member): TeamCalendarPerson => {
      const managerHrId = above.get(member.seat.seatId) ?? null;
      return {
        kind: "manager",
        manager: managerHrId ? nameOf(names, managerHrId) : null,
        person: nameOf(names, member.hrId),
        seatId: member.seat.seatId,
        territory: [seatTierTitle(member.seat.tier), member.seat.lineName].filter(Boolean).join(" · "),
      };
    })
    .sort(
      (left, right) =>
        (depth.get(left.seatId) ?? 0) - (depth.get(right.seatId) ?? 0) ||
        left.territory.localeCompare(right.territory) ||
        left.person.localeCompare(right.person),
    );
}

/**
 * A product manager's row (owner, 2026-10-20): his name, his app role and the lines he is named on, and the
 * person he reports to as his A.Manager column — read from the product-manager roster the viewer already
 * carries, never from a seat he does not hold. Sorted by role, then line, then name.
 */
async function describeProductManagers(viewer: PhoenixCrmViewer, productManagers: readonly ScopeProductManager[]): Promise<TeamCalendarPerson[]> {
  if (productManagers.length === 0) return [];
  const above = new Map<string, string | null>();
  for (const manager of productManagers) {
    // The Training Manager rides on these rows too (owner, 2026-10-24); her manager is on her own roster.
    const roster = [...viewer.productManagers, ...(viewer.trainingManagers ?? [])].find((entry) => personKey(entry.hrId) === manager.hrId);
    above.set(manager.hrId, personKey(roster?.managerHrId ?? null));
  }
  const names = await loadPeopleNames([...productManagers.map((manager) => manager.hrId), ...above.values()]);
  return productManagers
    .map((manager): TeamCalendarPerson => {
      const managerHrId = above.get(manager.hrId) ?? null;
      return {
        kind: "manager",
        manager: managerHrId ? nameOf(names, managerHrId) : null,
        person: nameOf(names, manager.hrId),
        seatId: productManagerRowKey(manager.hrId),
        seatless: true,
        territory: [manager.role, manager.lineNames.join(" + ")].filter(Boolean).join(" · "),
      };
    })
    .sort((left, right) => left.territory.localeCompare(right.territory) || left.person.localeCompare(right.person));
}

/**
 * A manager's days, each on the row of HIS seat: the single visits he logged himself (AM or PM by the
 * half it was planned in, or the Cairo half it was logged in) and the visits he rode with a rep.
 *
 * 🔴 HIS OWN SINGLE VISITS COME THROUGH `loadManagerOwnVisitDays`, THE ONE DOOR OUT OF THAT TABLE
 *    (`manager-plan-readers.ts`). They count in no KPI and the calendar keeps it so: the row shows that
 *    he worked, and `teamCalendarTotals` leaves a manager's row out of the month's three figures.
 *
 * 🔴 A RIDE-ALONG IS A DOUBLE OR CHAIN VISIT THAT NAMES HIM (`countsAsManagersDoubleVisit`, the rule the
 *    manager's plan report judges by), read from the countable view like every rep row, so a visit
 *    nobody has validated waits exactly as it waits on the rep's own row. It is also on the rep's row —
 *    each of the two people worked it — which is why nothing here reaches the totals. Only visits in
 *    territories this viewer already reads are kept: never wider than the grid.
 *
 * 🔴 A PRODUCT MANAGER'S RIDE-ALONG IS THE REP'S VISIT NAMING HIM IN ITS PRODUCT-MANAGER SLOT
 *    (`countsAsPlannersVisitWithRep`, the rule his own plan report judges by, owner 2026-10-17), and his row is
 *    keyed `product-manager:<hr id>` (owner, 2026-10-20). His own single visits come through the same door as
 *    a seat manager's — one list of people, one read.
 */
async function loadManagerDays(
  managers: readonly ChainMember[],
  productManagers: readonly ScopeProductManager[],
  territorySeatIds: ReadonlySet<string>,
  isTest: boolean,
  bounds: { from: string; to: string },
): Promise<CalendarVisitDay[]> {
  if (managers.length === 0 && productManagers.length === 0) return [];
  const seatOf = new Map(managers.map((member) => [member.hrId, member.seat.seatId]));
  const productManagerIds = new Set<string>();
  for (const manager of productManagers) {
    if (seatOf.has(manager.hrId)) continue;
    seatOf.set(manager.hrId, productManagerRowKey(manager.hrId));
    productManagerIds.add(manager.hrId);
  }
  const hrIds = [...seatOf.keys()];
  const fold = newVisitFold();

  const own = await loadManagerOwnVisitDays({ end: bounds.to, isTest, managerHrIds: hrIds, start: bounds.from });
  for (const day of own) {
    const seatId = seatOf.get(day.hrId);
    if (!seatId) continue;
    const at = `${seatId}|${day.date}`;
    // 🔴 BY THE CUSTOMER'S LIST, NEVER THE HALF (owner, 2026-10-23): a pharmacy he called on is a Pharmacies
    // figure on his row, exactly as a rep's is — never an AM or PM visit because of the hour he went.
    const split = day.split ?? { am: day.am ?? 0, pharmacies: 0, pm: day.pm ?? 0 };
    const found = fold.amPm.get(at) ?? { am: 0, pm: 0 };
    found.am += split.am;
    found.pm += split.pm;
    fold.amPm.set(at, found);
    if (split.pharmacies > 0) {
      // One key per own pharmacy visit: his own visits are one per customer and day, so each is a pharmacy.
      const seen = fold.pharmacies.get(at) ?? new Set<string>();
      for (let index = 0; index < split.pharmacies; index += 1) seen.add(`own-visit:${index}`);
      fold.pharmacies.set(at, seen);
    }
  }

  const seen = new Set<string>();
  // Every (part, slot) read is independent, so they run side by side (performance brief, 2026-10-23) — the
  // tab used to wait on three passes over the view one after another. The rows are still folded in the
  // same order as before, so the `seen` de-dupe keeps exactly the same visit.
  const reads: Array<{ column: "manager_hr_id" | "senior_hr_id" | "product_manager_hr_id"; asked: string[] }> = [];
  for (const part of chunk(hrIds, 100)) {
    for (const column of ["manager_hr_id", "senior_hr_id", "product_manager_hr_id"] as const) {
      // The product-manager slot is asked of the product managers only, and not at all when none is drawn.
      const asked = column === "product_manager_hr_id" ? part.filter((hrId) => productManagerIds.has(hrId)) : part;
      if (asked.length > 0) reads.push({ column, asked });
    }
  }
  const results = await Promise.all(
    reads.map(({ column, asked }) =>
      fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_countable_visits")
            .select("id, seat_id, visit_date, list_type, pharmacy_name, customer_validated, kind, manager_hr_id, senior_hr_id, product_manager_hr_id")
            .eq("is_test", isTest)
            .gte("visit_date", bounds.from)
            .lte("visit_date", bounds.to)
            .in(column, asked),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  );
  {
    for (const rows of results) {
      for (const row of rows) {
        const day = cleanDay(row.visit_date);
        if (!day || !territorySeatIds.has(String(row.seat_id ?? ""))) continue;
        const visit = { kind: row.kind, managerHrId: row.manager_hr_id, productManagerHrId: row.product_manager_hr_id, seniorHrId: row.senior_hr_id };
        const named = [row.manager_hr_id, row.senior_hr_id, row.product_manager_hr_id].map((value) => personKey(String(value ?? "")));
        for (const hrId of new Set(named)) {
          const seatId = hrId ? seatOf.get(hrId) : undefined;
          if (!hrId || !seatId) continue;
          // A seat manager rode it when it is a double or chain visit naming him; a product manager when it
          // names him in his own slot — each by the rule his own plan report already judges by.
          const rode = productManagerIds.has(hrId) ? countsAsPlannersVisitWithRep(visit, hrId) : countsAsManagersDoubleVisit(visit, hrId);
          if (!rode) continue;
          // The two reads overlap on a visit naming him in both slots, and a chain visit can name two
          // managers — one visit, once per manager.
          const once = `${String(row.id)}|${hrId}`;
          if (seen.has(once)) continue;
          seen.add(once);
          foldVisitRow(fold, `${seatId}|${day}`, row);
        }
      }
    }
  }
  return visitDaysOf(fold);
}

/** A working day that was not a call — Phoenix's replacement for his pink `CP` (Campaign). */
async function loadActivityDays(
  seatIds: readonly string[],
  isTest: boolean,
  bounds: { from: string; to: string },
): Promise<{ seatId: string; day: string; activity: PhoenixCrmDayActivity }[]> {
  const out: { seatId: string; day: string; activity: PhoenixCrmDayActivity }[] = [];
  // The parts read side by side and are kept in their original order (performance brief, 2026-10-23).
  const parts = await Promise.all(
    chunk([...seatIds], 150).map((part) =>
      fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_day_activities")
            .select("id, seat_id, activity_date, activity_type")
            .eq("is_test", isTest)
            .gte("activity_date", bounds.from)
            .lte("activity_date", bounds.to)
            .in("seat_id", part),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  );
  for (const rows of parts) {
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
    // The parts are one-row reads with no order between them, so they run side by side (performance
    // brief, 2026-10-23); the newest day is the same whichever answers first.
    const answers = await Promise.all(chunk([...seatIds], 150).map((part) => run(part)));
    for (const { data, error } of answers) {
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
  seats: ReadonlyArray<Pick<OrgSeat, "seatId" | "occupantHrId">>,
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
