import { forbiddenError } from "@/lib/http/api-errors";
import { accountDoctorDepth, type AccountDoctorDepth } from "@/lib/crm/account-doctor-notes";
import { isCallRateWorkingDay } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { fraudScanWindow } from "@/lib/phoenix-crm/fraud-scan-rules";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { leaveDayKey } from "@/lib/phoenix-crm/plan-leave";
import { groupByRegionAndManager } from "@/lib/phoenix-crm/region-manager-groups";
import { seatOccupants, territoryName } from "@/lib/phoenix-crm/scope";
import { readsRegionalTeamReports, readWorldFor, regionalTeamRepSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readSeatGroups } from "@/lib/phoenix-crm/server/reports";
import { districtSeatOf } from "@/lib/phoenix-crm/server/team-visits";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The Weekly Sheet — the Regional Sales Manager's week of his team (owner, 2026-11-08, Dr. Hany Saad's seventh
 * need: "a weekly sheet per rep: the AM and the PM, 50 PM a week and 2 AM accounts a day — 10 a week — and at
 * least 3 doctors of each speciality, Pediatrics, Internal / GP and ENT, inside every account").
 *
 * The week is the field week, Saturday to Wednesday (`isCallRateWorkingDay`: Thursday and Friday are not working
 * days). The targets are per WORKING DAY — 10 PM and 2 AM — so a full week is exactly 50 and 10, and a day of
 * approved leave or a national holiday comes out of the rep's target, as on Call Rate. A visit counts as the team
 * calendar counts it: to a validated customer, AM · PM · Pharmacies apart. The account depth is read from the AM
 * visit comments (`accountDoctorDepth`) — the only place a rep writes the doctors he met.
 *
 * 🔴 NO LOCATION IS READ — the select names no coordinate, distance or location flag.
 */

export const PM_PER_WORKING_DAY = 10;
export const AM_PER_WORKING_DAY = 2;

export type WeeklySheetAccount = {
  customerId: string;
  name: string;
  visits: number;
  depth: AccountDoctorDepth;
};

export type WeeklySheetRep = {
  seatId: string;
  person: string;
  territory: string;
  workingDays: number;
  /** Days of approved leave inside the week's working days. */
  leaveDays: number;
  pm: number;
  pmTarget: number;
  am: number;
  amTarget: number;
  pharmacies: number;
  /** Visits to a customer nobody has validated yet — real work, counted in none of the figures. */
  waiting: number;
  accounts: WeeklySheetAccount[];
  /** Accounts with 3 of each of the three specialities. */
  accountsMet: number;
  /** Nobody sits on the seat this week: no target, never graded "Below". */
  vacant: boolean;
};

/** One group: a region and its district manager (owner, 2026-11-09 — `groupByRegionAndManager`). */
export type WeeklySheetDistrict = { regionName: string; managerName: string; districtName: string; vacantSeats: number; reps: WeeklySheetRep[] };

export type WeeklySheet = {
  weekStart: string;
  weekEnd: string;
  /** "Sat 1 Nov – Wed 5 Nov". */
  label: string;
  districts: WeeklySheetDistrict[];
  /** The holiday calendar or approved leave could not be read: the targets may be a day too high. */
  targetsUncertain: boolean;
};

/** The target for a number of working days. Pure. */
export function weeklySheetTargets(workingDays: number): { pm: number; am: number } {
  return { am: AM_PER_WORKING_DAY * workingDays, pm: PM_PER_WORKING_DAY * workingDays };
}

export type WeeklySheetResult = "Met" | "Below" | "Seat is vacant";

/** One grading rule for the screen and the Excel: an empty seat has no rep to measure, so it is never "Below". */
export function weeklySheetResult(value: number, target: number, vacant: boolean): WeeklySheetResult {
  if (vacant) return "Seat is vacant";
  return value >= target ? "Met" : "Below";
}

/** The Saturday-to-Wednesday week holding this day; the last full one when no day is named. */
export function weeklySheetWindow(cairoToday: string, anyDay: string | null): { from: string; to: string; label: string } {
  if (!anyDay) {
    const last = fraudScanWindow(cairoToday);
    return { from: last.fromIso, label: last.label, to: last.toIso };
  }
  const from = fieldWeekStart(anyDay);
  const to = addDaysIso(from, 4);
  // The label in the same words as the scan's — "Sat 1 Nov – Wed 5 Nov" — read off that window's own formatter.
  return { from, label: fraudScanWindow(addDaysIso(to, 1)).label, to };
}

type VisitRow = {
  id: string;
  seat_id: string | null;
  visit_date: string | null;
  list_type: string | null;
  customer_id: string | null;
  pharmacy_name: string | null;
  customer_validated: boolean | null;
  comment: string | null;
};

async function readVisits(seatIds: string[], isTest: boolean, from: string, to: string): Promise<VisitRow[]> {
  if (seatIds.length === 0) return [];
  return readSeatGroups(seatIds, 150, (part) =>
    fetchAllRowsKeyset<VisitRow>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits_with_history")
          .select("id, seat_id, visit_date, list_type, customer_id, pharmacy_name, customer_validated, comment")
          .eq("is_test", isTest)
          .gte("visit_date", from)
          .lte("visit_date", to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
}

/** The visits' second comment ("detail") — on the visit table, not the countable view. */
async function readDetailComments(visitIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let index = 0; index < visitIds.length; index += 200) {
    const part = visitIds.slice(index, index + 200);
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_visits").select("id, detail_comment").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; detail_comment: string | null }>) {
      if (row.detail_comment) out.set(String(row.id), row.detail_comment);
    }
  }
  return out;
}

async function readCustomerNames(customerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let index = 0; index < customerIds.length; index += 200) {
    const part = customerIds.slice(index, index + 200);
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) out.set(String(row.id), row.name ?? "Customer");
  }
  return out;
}

export async function loadWeeklySheet(viewer: PhoenixCrmViewer, anyDay: string | null): Promise<WeeklySheet> {
  if (!readsRegionalTeamReports(viewer)) throw forbiddenError("This report is for the Regional Sales Manager.");
  const window = weeklySheetWindow(viewer.cairoToday, anyDay);
  const seats = regionalTeamRepSeats(viewer);
  const isTest = readWorldFor(viewer, null);
  const [rows, holidays, leave] = await Promise.all([
    readVisits(
      seats.map((seat) => seat.seatId),
      isTest,
      window.from,
      window.to,
    ),
    loadCallRateHolidays(window.from, window.to),
    loadSeatLeaveDays(seats, { from: window.from, to: window.to }),
  ]);
  const amRows = rows.filter((row) => row.customer_validated === true && visitCountBucketForListType(row.list_type) === "AM" && row.customer_id);
  const [details, customerNames, names] = await Promise.all([
    readDetailComments(amRows.map((row) => String(row.id))),
    readCustomerNames([...new Set(amRows.map((row) => String(row.customer_id)))]),
    loadPeopleNames([...seats.flatMap((seat) => seatOccupants(seat)), ...seats.map((seat) => districtSeatOf(viewer, seat)?.occupantHrId ?? null)]),
  ]);

  const days = Array.from({ length: 5 }, (_, offset) => addDaysIso(window.from, offset));
  const bySeat = new Map<string, VisitRow[]>();
  for (const row of rows) {
    const key = String(row.seat_id ?? "");
    bySeat.set(key, [...(bySeat.get(key) ?? []), row]);
  }

  const repBySeat = new Map<string, WeeklySheetRep>();
  for (const seat of seats) {
    const working = days.filter((day) => isCallRateWorkingDay(day, holidays.dates));
    const leaveDays = leave.unread ? 0 : working.filter((day) => leave.days.has(leaveDayKey(seat.seatId, day))).length;
    const workingDays = working.length - leaveDays;
    const targets = weeklySheetTargets(workingDays);
    const mine = bySeat.get(seat.seatId) ?? [];
    let am = 0;
    let pm = 0;
    let waiting = 0;
    const pharmaciesByDay = new Map<string, Set<string>>();
    const accountComments = new Map<string, { visits: number; comments: string[] }>();
    for (const row of mine) {
      if (row.customer_validated !== true) {
        waiting += 1;
        continue;
      }
      const bucket = visitCountBucketForListType(row.list_type);
      if (bucket === "AM") am += 1;
      else if (bucket === "PM") pm += 1;
      const day = String(row.visit_date ?? "").slice(0, 10);
      for (const name of pharmacyNamesOnVisit(row.list_type, String(row.pharmacy_name ?? ""))) {
        const key = pharmacyNameKey(name);
        if (!key) continue;
        const set = pharmaciesByDay.get(day) ?? new Set<string>();
        set.add(key);
        pharmaciesByDay.set(day, set);
      }
      if (bucket === "AM" && row.customer_id) {
        const entry = accountComments.get(row.customer_id) ?? { comments: [], visits: 0 };
        entry.visits += 1;
        entry.comments.push(row.comment ?? "", details.get(String(row.id)) ?? "");
        accountComments.set(row.customer_id, entry);
      }
    }
    const accounts: WeeklySheetAccount[] = [...accountComments.entries()]
      .map(([customerId, entry]) => ({ customerId, depth: accountDoctorDepth(entry.comments), name: customerNames.get(customerId) ?? "Customer", visits: entry.visits }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const people = seatOccupants(seat);
    const vacant = people.length === 0;
    const rep: WeeklySheetRep = {
      accounts,
      accountsMet: accounts.filter((account) => account.depth.met).length,
      am,
      amTarget: vacant ? 0 : targets.am,
      leaveDays,
      person: people.length ? people.map((hrId) => nameOf(names, hrId)).join(" · ") : "Seat is vacant",
      pharmacies: [...pharmaciesByDay.values()].reduce((sum, set) => sum + set.size, 0),
      pm,
      pmTarget: vacant ? 0 : targets.pm,
      seatId: seat.seatId,
      territory: territoryName(seat),
      vacant,
      waiting,
      workingDays,
    };
    repBySeat.set(seat.seatId, rep);
  }

  // Grouped by region and district manager (owner, 2026-11-09), in the organogram's region order.
  const districts: WeeklySheetDistrict[] = groupByRegionAndManager(seats, (seat) => seat, (seat) => districtSeatOf(viewer, seat)).map((group) => {
    const reps = group.items.flatMap((seat) => {
      const rep = repBySeat.get(seat.seatId);
      return rep ? [rep] : [];
    });
    return {
      districtName: group.district ? territoryName(group.district) : "No district manager",
      managerName: group.district ? (group.district.occupantHrId ? nameOf(names, group.district.occupantHrId) : "Seat is vacant") : "No district manager",
      regionName: group.regionName,
      reps: reps.sort((left, right) => left.territory.localeCompare(right.territory) || left.person.localeCompare(right.person)),
      vacantSeats: reps.filter((rep) => rep.vacant).length,
    };
  });
  return { districts, label: window.label, targetsUncertain: !holidays.complete || leave.unread, weekEnd: window.to, weekStart: window.from };
}
