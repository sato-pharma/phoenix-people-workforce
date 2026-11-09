import { forbiddenError } from "@/lib/http/api-errors";
import { addDaysIso } from "@/lib/crm/dates";
import { cairoMonthDayTime12h } from "@/lib/format/cairo-datetime";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { groupByRegionAndManager } from "@/lib/phoenix-crm/region-manager-groups";
import { personKey, seatOccupants, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsRegionalTeamReports, regionalReportWorlds, regionalTeamRepSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadManagerOwnVisitRows } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { readSeatGroups } from "@/lib/phoenix-crm/server/reports";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Visits — Yesterday and Today: the Regional Sales Manager's team report (owner, 2026-11-08, Dr. Hany Saad's
 * second need: "a report with the number of yesterday's visits and the times they were entered, and today's
 * visits and the times they were entered").
 *
 * Every rep under his district managers, grouped by district manager, with each day's AM · PM · Pharmacies
 * counted APART (the golden rule) and every visit's "Saved at" time — `captured_at`, the moment the rep saved
 * it. A district manager's own visits are listed in his own row and counted in no rep's figure.
 *
 * 🔴 NO LOCATION IS READ. The select names no coordinate, distance or location flag: the far-visit evidence is
 * not a Regional Sales Manager's (`readsPlaceVsActual`). "Today" is the VISIT day (`viewer.visitDay`, which runs
 * to 02:00 Cairo) and yesterday is the day before it.
 *
 * 🔴 A TEST ACCOUNT READS THE REAL TEAM AND ITS OWN TEST WORK BESIDE IT, the way every report does for one
 * (`regionalReportWorlds`). Read in the test world alone, the TEST- login that mirrors the Regional
 * Sales Manager showed every rep at zero (owner, 2026-11-09).
 */

export type TeamVisitTime = {
  /** "09:42 AM", Cairo time — null for a visit copied from the old CRM, which recorded no time. */
  savedAt: string | null;
  /** "AM", "PM" or "Pharmacy". */
  list: "AM" | "PM" | "Pharmacy";
  /**
   * Who the visit was to, printed beside its time (owner, 2026-11-09: "group by am/pm put customer name and beside
   * the visit time sort ascending"): the customer's name, a pharmacy visit's pharmacy. Null when neither is known.
   */
  customer: string | null;
  /** The instant, for sorting. */
  at: string | null;
  /**
   * The visit was saved to a customer nobody has validated yet: real work, listed with its time, counted in none of
   * the three figures. The square tags it so the reader can tell which of the times the "waiting" figure means.
   */
  waiting: boolean;
};

export type TeamVisitDay = {
  am: number;
  pm: number;
  pharmacies: number;
  /** Visits saved to a customer nobody has validated yet — real work, counted in none of the three. */
  waiting: number;
  times: TeamVisitTime[];
};

export type TeamVisitRep = {
  seatId: string;
  /** "Seat is vacant" when nobody sits in it — then `vacant` is true and the seat is listed by territory alone. */
  person: string;
  /** A rep seat with nobody in it: never a rep, never "no visits saved". */
  vacant: boolean;
  territory: string;
  yesterday: TeamVisitDay;
  today: TeamVisitDay;
};

export type TeamVisitDistrict = {
  /** The organogram region — the group's heading names it with the manager (`regionManagerTitle`). */
  regionName: string;
  managerName: string;
  managerHrId: string | null;
  districtName: string;
  /** The region's rep seats with nobody in them. */
  vacantSeats: number;
  /** The district manager's own visits, listed apart and counted in no rep's figure. Null when the seat is vacant. */
  managerOwn: { yesterday: TeamVisitDay; today: TeamVisitDay } | null;
  /**
   * The district manager's count: the total of his reps' visits, each day (owner, 2026-11-09: "put the district
   * managers visits count the total number visits of his reps"). His own visits stay apart, in `managerOwn`.
   */
  repsTotal: { yesterday: TeamVisitDay; today: TeamVisitDay };
  reps: TeamVisitRep[];
};

export type TeamVisitsReport = {
  yesterday: string;
  today: string;
  districts: TeamVisitDistrict[];
  totals: { yesterday: TeamVisitDay; today: TeamVisitDay };
};

const DISTRICT_TIERS = new Set(["DM", "ACTING_DM"]);

type VisitRow = {
  id: string;
  seat_id: string | null;
  customer_id: string | null;
  visit_date: string | null;
  list_type: string | null;
  pharmacy_name: string | null;
  customer_validated: boolean | null;
  captured_at: string | null;
  imported_from_ireports360_at: string | null;
};

export function emptyTeamVisitDay(): TeamVisitDay {
  return { am: 0, pm: 0, pharmacies: 0, times: [], waiting: 0 };
}

/** "Oct 28, 11:16 AM" → "11:16 AM". */
export function cairoTimeOnly(iso: string | null | undefined): string | null {
  const full = cairoMonthDayTime12h(iso);
  if (!full || full === "-") return null;
  const at = full.lastIndexOf(", ");
  return at >= 0 ? full.slice(at + 2) : full;
}

function listOf(listType: unknown): "AM" | "PM" | "Pharmacy" {
  const bucket = visitCountBucketForListType(listType);
  if (bucket === "AM") return "AM";
  if (bucket === "Pharmacies") return "Pharmacy";
  return "PM";
}

/**
 * One day's rows folded into the figures the page prints. Pure, so the rules are pinned without a database:
 * validated AM and PM counted apart, pharmacies as DISTINCT names (the team calendar's rule, so the two agree),
 * an unvalidated customer counted only as waiting, and a copied visit's time printed as none.
 */
export function foldTeamVisitDay(rows: ReadonlyArray<VisitRow>, customerNames: ReadonlyMap<string, string> = new Map()): TeamVisitDay {
  const day = emptyTeamVisitDay();
  const pharmacies = new Set<string>();
  for (const row of rows) {
    const copied = Boolean(row.imported_from_ireports360_at);
    const list = listOf(row.list_type);
    const customer = (list === "Pharmacy" ? row.pharmacy_name?.trim() : null) || (row.customer_id ? customerNames.get(row.customer_id) : null) || row.pharmacy_name?.trim() || null;
    day.times.push({ at: copied ? null : row.captured_at, customer, list, savedAt: copied ? null : cairoTimeOnly(row.captured_at), waiting: row.customer_validated !== true });
    if (row.customer_validated !== true) {
      day.waiting += 1;
      continue;
    }
    const bucket = visitCountBucketForListType(row.list_type);
    if (bucket === "AM") day.am += 1;
    else if (bucket === "PM") day.pm += 1;
    for (const name of pharmacyNamesOnVisit(row.list_type, String(row.pharmacy_name ?? ""))) {
      const key = pharmacyNameKey(name);
      if (key) pharmacies.add(key);
    }
  }
  day.pharmacies = pharmacies.size;
  day.times.sort((left, right) => (left.at ?? "9999").localeCompare(right.at ?? "9999"));
  return day;
}

/** The total of the reps' visits for one day — AM · PM · Pharmacies still three figures apart, no times. */
export function sumTeamVisitDays(days: readonly TeamVisitDay[]): TeamVisitDay {
  const total = emptyTeamVisitDay();
  for (const day of days) addDay(total, day);
  return total;
}

function addDay(into: TeamVisitDay, from: TeamVisitDay): void {
  into.am += from.am;
  into.pm += from.pm;
  into.pharmacies += from.pharmacies;
  into.waiting += from.waiting;
}

/** The nearest district manager seat above a rep seat — null for a seat no district holds. */
export function districtSeatOf(viewer: Pick<PhoenixCrmViewer, "org">, seat: OrgSeat): OrgSeat | null {
  for (const ancestorId of [...seat.path].reverse()) {
    if (ancestorId === seat.seatId) continue;
    const ancestor = viewer.org.seats.get(ancestorId);
    if (ancestor && DISTRICT_TIERS.has(ancestor.tier) && !ancestor.isOtherPseudoDm) return ancestor;
  }
  return null;
}

async function readVisitRows(seatIds: string[], worlds: boolean[], from: string, to: string): Promise<VisitRow[]> {
  if (seatIds.length === 0) return [];
  return readSeatGroups(seatIds, 150, (part) =>
    fetchAllRowsKeyset<VisitRow>(
      () =>
        getSupabaseAdmin()
          // Named columns, every one read off the live view — and NO location column (see the file header).
          .from("phoenix_crm_countable_visits_with_history")
          .select("id, seat_id, customer_id, visit_date, list_type, pharmacy_name, customer_validated, captured_at, imported_from_ireports360_at")
          .in("is_test", worlds)
          .gte("visit_date", from)
          .lte("visit_date", to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
}

/** The names of the customers the visits went to, by id. A failed read throws: the page says so, never a blank name. */
async function readCustomerNames(customerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (customerIds.length === 0) return names;
  const rows = await readSeatGroups(customerIds, 100, async (part) => {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", part);
    if (error) throw new Error(`Could not read the customers' names: ${error.message}`);
    return (data ?? []) as Array<{ id: string; name: string | null }>;
  });
  for (const row of rows) if (row.name?.trim()) names.set(String(row.id), row.name.trim());
  return names;
}

export async function loadTeamVisitsReport(viewer: PhoenixCrmViewer): Promise<TeamVisitsReport> {
  if (!readsRegionalTeamReports(viewer)) throw forbiddenError("This report is for the Regional Sales Manager.");
  const today = viewer.visitDay;
  const yesterday = addDaysIso(today, -1);
  const seats = regionalTeamRepSeats(viewer);
  const worlds = regionalReportWorlds(viewer);

  const rows = await readVisitRows(
    seats.map((seat) => seat.seatId),
    worlds,
    yesterday,
    today,
  );
  const customerNames = await readCustomerNames([...new Set(rows.flatMap((row) => (row.customer_id ? [String(row.customer_id)] : [])))]);
  const bySeatDay = new Map<string, VisitRow[]>();
  for (const row of rows) {
    const key = `${row.seat_id ?? ""}|${String(row.visit_date ?? "").slice(0, 10)}`;
    const list = bySeatDay.get(key) ?? [];
    list.push(row);
    bySeatDay.set(key, list);
  }

  // Grouped by region and district manager (owner, 2026-11-09) — `groupByRegionAndManager`.
  const groups = groupByRegionAndManager(seats, (seat) => seat, (seat) => districtSeatOf(viewer, seat));

  const managerHrIds = [...new Set(groups.flatMap((group) => (group.district?.occupantHrId ? [group.district.occupantHrId] : [])))];
  const ownRows = managerHrIds.length
    ? (await Promise.all(worlds.map((isTest) => loadManagerOwnVisitRows({ end: today, isTest, managerHrIds, start: yesterday })))).flat()
    : [];
  const names = await loadPeopleNames([...managerHrIds, ...seats.flatMap((seat) => seatOccupants(seat))]);

  const totals = { today: emptyTeamVisitDay(), yesterday: emptyTeamVisitDay() };
  const districts: TeamVisitDistrict[] = [];
  for (const group of groups) {
    const district = group.district;
    const managerHrId = district?.occupantHrId ?? null;
    const reps = group.items
      .map((seat): TeamVisitRep => {
        const people = seatOccupants(seat);
        const day = (on: string) => foldTeamVisitDay(bySeatDay.get(`${seat.seatId}|${on}`) ?? [], customerNames);
        const rep: TeamVisitRep = {
          person: people.length ? people.map((hrId) => nameOf(names, hrId)).join(" · ") : "Seat is vacant",
          seatId: seat.seatId,
          territory: territoryName(seat),
          today: day(today),
          vacant: people.length === 0,
          yesterday: day(yesterday),
        };
        addDay(totals.yesterday, rep.yesterday);
        addDay(totals.today, rep.today);
        return rep;
      })
      .sort((left, right) => left.territory.localeCompare(right.territory) || left.person.localeCompare(right.person));

    let managerOwn: TeamVisitDistrict["managerOwn"] = null;
    if (managerHrId) {
      const mine = ownRows.filter((visit) => personKey(visit.managerHrId) === personKey(managerHrId) && visit.source === "own");
      const ownDay = (on: string): TeamVisitDay => {
        const day = emptyTeamVisitDay();
        for (const visit of mine.filter((row) => row.date === on)) {
          if (visit.bucket === "AM") day.am += 1;
          else if (visit.bucket === "PM") day.pm += 1;
          else day.pharmacies += 1;
          day.times.push({
            at: visit.loggedAt,
            customer: visit.customerName?.trim() || null,
            list: visit.bucket === "AM" ? "AM" : visit.bucket === "PM" ? "PM" : "Pharmacy",
            savedAt: cairoTimeOnly(visit.loggedAt),
            waiting: false,
          });
        }
        day.times.sort((left, right) => (left.at ?? "9999").localeCompare(right.at ?? "9999"));
        return day;
      };
      managerOwn = { today: ownDay(today), yesterday: ownDay(yesterday) };
    }

    districts.push({
      districtName: district ? territoryName(district) : "No district manager",
      regionName: group.regionName,
      vacantSeats: group.items.filter((seat) => seatOccupants(seat).length === 0).length,
      managerHrId,
      managerName: district ? (managerHrId ? nameOf(names, managerHrId) : "Seat is vacant") : "No district manager",
      managerOwn,
      repsTotal: { today: sumTeamVisitDays(reps.map((rep) => rep.today)), yesterday: sumTeamVisitDays(reps.map((rep) => rep.yesterday)) },
      reps,
    });
  }
  return { districts, today, totals, yesterday };
}
