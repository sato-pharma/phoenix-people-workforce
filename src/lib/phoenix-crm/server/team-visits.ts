import { forbiddenError } from "@/lib/http/api-errors";
import { logWarning } from "@/lib/observability/log";
import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { distanceMeters } from "@/lib/phoenix-crm/geo";
import { isEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { cairoMonthDayTime12h } from "@/lib/format/cairo-datetime";
import { pharmacyNameKey, pharmacyNamesOnVisit, visitCountBucketForListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { groupByRegionAndManager } from "@/lib/phoenix-crm/region-manager-groups";
import { personKey, seatOccupants, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { locationSight, readsAnyTeamReport, regionalReportWorlds, teamReportRepSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadSeatDayActivities, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { loadSeatsLeaveLabels } from "@/lib/phoenix-crm/server/leave-days";
import { districtManagerDayOn, loadDistrictManagerWeeks, mergeDistrictManagerWeeks, type DistrictManagerDay } from "@/lib/phoenix-crm/server/manager-dm-day";
import { loadManagerOwnVisitRows, loadManagerVisitFixes } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { managerOwnVisitUuid } from "@/lib/phoenix-crm/server/manager-visit-details";
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
 * 🔴 EACH VISIT'S DISTANCE FROM THE LIVE PHOTO, AND NOTHING ELSE ABOUT THE READING (owner, 2026-11-09: "beside
 * every customer write the distance in m the visit was logged vs validation live photo"). The metres between where
 * the visit was logged and the place's validated live photo — the photograph's own fix, never a dragged pin — and
 * only where `locationSight` answers "distance" or more for that seat (owner, 2026-10-02: every reader below the
 * Super Admin and the SFE Manager reads the distance, never the reading behind it). No flag, no far count, no
 * accuracy: the far-visit report stays off the Regional Sales Manager (`readsPlaceVsActual`). "Today" is the VISIT
 * day (`viewer.visitDay`, which runs to 02:00 Cairo) and yesterday is the day before it.
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
  /**
   * Planned, unplanned or entered for the person by the Super Admin — each wears its own colour (owner, 2026-11-09:
   * "give planned visit a color and unplanned a color and logged by admin another color"). Entered by admin wins.
   */
  origin: TeamVisitOrigin;
  /** Metres from where the visit was logged to the place's validated live photo; null with `distanceNote` saying why. */
  metres: number | null;
  /** "No location on the visit" · "No live photo for this place" — null when `metres` is printed or nothing is shown. */
  distanceNote: string | null;
};

export type TeamVisitOrigin = "planned" | "unplanned" | "admin";

export type TeamVisitDay = {
  am: number;
  pm: number;
  pharmacies: number;
  /** Visits saved to a customer nobody has validated yet — real work, counted in none of the three. */
  waiting: number;
  times: TeamVisitTime[];
  /**
   * What the day was instead of visits (owner, 2026-11-09: "if a day for dm or rep has admin work put it instead of
   * visits and if vacation put it"): approved leave ("On leave · Annual Vacation") and the day activity the person
   * recorded ("Admin work", "Training · half day"). Shown, never counted. Absent on a plain working day.
   */
  away?: string[];
};

export type TeamVisitRep = {
  seatId: string;
  /** "Seat is vacant" when nobody sits in it — then `vacant` is true and the seat is listed by territory alone. */
  person: string;
  /** A rep seat with nobody in it: never a rep, never "no visits saved"; the row wears a light colour of its own (owner, 2026-11-09). */
  vacant: boolean;
  /** `employees.hire_date` of whoever sits in the seat (`YYYY-MM-DD`), printed "Hired 1 Nov 2026" (owner, 2026-11-09). */
  hireDates: string[];
  territory: string;
  yesterday: TeamVisitDay;
  today: TeamVisitDay;
};

export type TeamVisitDistrict = {
  /** The organogram region — the group's heading names it with the manager (`regionManagerTitle`). */
  regionName: string;
  managerName: string;
  managerHrId: string | null;
  /** The district manager's `employees.hire_date`, `YYYY-MM-DD`; null when unknown or the seat is vacant. */
  managerHireDate: string | null;
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
  /**
   * Was the district manager's day double or single — double with whom, single where (owner, 2026-11-09: "show the
   * district manager this day was double or single, if double with who, if single where"). Read from his own sent or
   * draft week (`loadDistrictManagerWeeks`), never judged. Null for a vacant seat.
   */
  managerDay: { yesterday: TeamVisitManagerDay; today: TeamVisitManagerDay } | null;
  reps: TeamVisitRep[];
};

/** The district manager's day in words: one headline and one line per half. */
export type TeamVisitManagerDay = {
  /** "Double visit day" · "Single visit day" · "Admin day" · "Double and single" · "Single and admin" · "Nothing planned" · "Plan could not be read". */
  headline: string;
  /** "AM · Double with Momen Fathy · Smouha" · "PM · Single in Sidi Gaber". */
  halves: string[];
  /** His week's status when it is not sent yet ("Draft", "Not started"); null once sent. */
  unsent: string | null;
};

export type TeamVisitsReport = {
  yesterday: string;
  today: string;
  districts: TeamVisitDistrict[];
  totals: { yesterday: TeamVisitDay; today: TeamVisitDay };
  /** Approved leave could not be read — the screen says so instead of reading the day as worked. */
  leaveUnread?: boolean;
  /** The recorded day activities (Admin work, Training…) could not be read — said on the screen. */
  activitiesUnread?: boolean;
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
  lat?: number | null;
  lon?: number | null;
  place_id?: string | null;
  is_unplanned?: boolean | null;
  entered_by_hr_id?: string | null;
  rep_hr_id?: string | null;
  manager_hr_id?: string | null;
  senior_hr_id?: string | null;
};

/** A place's validated live photo, by the photograph's own fix. */
export type PhotoPoint = { lat: number; lon: number };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The metres from where a visit was logged to the validated live photo of its place, or why there are none. Pure.
 * `shown: false` (the seat is the viewer's own as its rep, Golden Rule #1) prints nothing at all.
 */
export function visitPhotoDistance(
  visit: { lat?: number | null; lon?: number | null },
  photo: PhotoPoint | null | undefined,
  shown = true,
): { metres: number | null; distanceNote: string | null } {
  if (!shown) return { distanceNote: null, metres: null };
  if (!finite(visit.lat) || !finite(visit.lon)) return { distanceNote: "No location on the visit", metres: null };
  if (!photo || !finite(photo.lat) || !finite(photo.lon)) return { distanceNote: "No live photo for this place", metres: null };
  return { distanceNote: null, metres: distanceMeters({ lat: visit.lat, lon: visit.lon }, photo) };
}

/** Planned, unplanned or entered for the rep by the Super Admin — `isEnteredForRep`, the missed-record rule. */
export function teamVisitOrigin(
  row: Pick<VisitRow, "is_unplanned" | "entered_by_hr_id" | "rep_hr_id" | "manager_hr_id" | "senior_hr_id">,
): TeamVisitOrigin {
  if (isEnteredForRep({ enteredBy: row.entered_by_hr_id, manager: row.manager_hr_id, rep: row.rep_hr_id, senior: row.senior_hr_id })) return "admin";
  return row.is_unplanned === true ? "unplanned" : "planned";
}

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
export function foldTeamVisitDay(
  rows: ReadonlyArray<VisitRow>,
  customerNames: ReadonlyMap<string, string> = new Map(),
  photos: ReadonlyMap<string, PhotoPoint> = new Map(),
  distanceShown = true,
): TeamVisitDay {
  const day = emptyTeamVisitDay();
  const pharmacies = new Set<string>();
  for (const row of rows) {
    const copied = Boolean(row.imported_from_ireports360_at);
    const list = listOf(row.list_type);
    const customer = (list === "Pharmacy" ? row.pharmacy_name?.trim() : null) || (row.customer_id ? customerNames.get(row.customer_id) : null) || row.pharmacy_name?.trim() || null;
    day.times.push({
      at: copied ? null : row.captured_at,
      customer,
      list,
      origin: teamVisitOrigin(row),
      savedAt: copied ? null : cairoTimeOnly(row.captured_at),
      waiting: row.customer_validated !== true,
      ...visitPhotoDistance(row, row.place_id ? photos.get(String(row.place_id)) : null, distanceShown),
    });
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

/**
 * The district manager's planned day in words (owner, 2026-11-09): double with whom, single where. A half with a
 * manager or product manager is a double too and names that person; Admin names its activity.
 */
export function teamVisitManagerDay(day: DistrictManagerDay | null, unread = false): TeamVisitManagerDay {
  if (unread) return { headline: "Plan could not be read", halves: [], unsent: null };
  if (!day || day.halves.length === 0) return { headline: "Nothing planned", halves: [], unsent: day && !day.sent ? day.statusLabel : null };
  const kinds = new Set(day.halves.map((half) => (half.kindLabel.startsWith("Double") ? "double" : half.kindLabel === "Single visit" ? "single" : "admin")));
  const parts = (["double", "single", "admin"] as const).filter((kind) => kinds.has(kind));
  const headline =
    parts.length === 1
      ? { admin: "Admin day", double: "Double visit day", single: "Single visit day" }[parts[0]]
      : parts.map((kind, index) => (index === 0 ? kind[0].toUpperCase() + kind.slice(1) : kind)).join(" and ");
  const halves = day.halves.map((half) => {
    const where = half.areaName ? ` · ${half.areaName}` : "";
    if (half.kindLabel === "Double visit") return `${half.half} · Double with ${half.repName ?? "no rep named"}${where}`;
    if (half.kindLabel.startsWith("Double")) return `${half.half} · ${half.kindLabel}${half.detail ? ` — ${half.detail}` : ""}${where}`;
    if (half.kindLabel === "Single visit") return `${half.half} · Single in ${half.areaName ?? "no area named"}`;
    return `${half.half} · Admin${half.detail ? ` — ${half.detail}` : ""}`;
  });
  return { headline, halves, unsent: day.sent ? null : day.statusLabel };
}

/**
 * Each person's `employees.hire_date`, by person key — display only. A failed read is logged and prints no date;
 * it never takes the visits down with it.
 */
async function readHireDates(hrIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(hrIds.filter(Boolean))];
  try {
    for (let index = 0; index < ids.length; index += 100) {
      const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, hire_date").in("hr_id", ids.slice(index, index + 100));
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ hr_id: string | null; hire_date: string | null }>) {
        const key = personKey(row.hr_id);
        if (key && row.hire_date) out.set(key, String(row.hire_date).slice(0, 10));
      }
    }
  } catch (error) {
    logWarning("Phoenix CRM could not read hire dates for Visits — Yesterday and Today", {
      labels: { event: "phoenix_crm_team_visits_hire_dates_unread" },
      error,
      context: { people: ids.length },
    });
  }
  return out;
}

/** The day's leave and recorded activity, in the words the square prints instead of visits (owner, 2026-11-09). */
export function teamVisitAway(leave: string | null | undefined, activity: Pick<DayActivityRow, "activityLabel" | "halfDay"> | null | undefined): string[] {
  const out: string[] = [];
  if (leave) out.push(`On leave · ${leave}`);
  if (activity) out.push(activity.halfDay ? `${activity.activityLabel} · half day` : activity.activityLabel);
  return out;
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
          // Named columns, every one read off the live view — the visit's own fix and place for the distance from the
          // live photo, and no flag, accuracy or stored verdict (see the file header).
          .from("phoenix_crm_countable_visits_with_history")
          .select(
            "id, seat_id, customer_id, visit_date, list_type, pharmacy_name, customer_validated, captured_at, imported_from_ireports360_at, lat, lon, place_id, is_unplanned, entered_by_hr_id, rep_hr_id, manager_hr_id, senior_hr_id",
          )
          .in("is_test", worlds)
          .gte("visit_date", from)
          .lte("visit_date", to)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );
}

/**
 * Each place's validated live photo, by place id — the photograph's own fix; a place seated in a shared venue with
 * no photo of its own takes the venue's. A failed read throws: the page says so, never a wrong distance.
 */
async function readPlacePhotos(placeIds: string[]): Promise<Map<string, PhotoPoint>> {
  const out = new Map<string, PhotoPoint>();
  const ids = [...new Set(placeIds)];
  if (ids.length === 0) return out;
  type PlaceRow = { id: string; photo_lat: number | null; photo_lon: number | null; shared_place_id: string | null };
  const places = await readSeatGroups(ids, 100, async (part) => {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_places").select("id, photo_lat, photo_lon, shared_place_id").in("id", part);
    if (error) throw new Error(`Could not read the places' live photos: ${error.message}`);
    return (data ?? []) as PlaceRow[];
  });
  const venueIds = [...new Set(places.flatMap((place) => (!finite(place.photo_lat) && place.shared_place_id ? [String(place.shared_place_id)] : [])))];
  const venues = new Map<string, PhotoPoint>();
  if (venueIds.length > 0) {
    const rows = await readSeatGroups(venueIds, 100, async (part) => {
      const { data, error } = await getSupabaseAdmin().from("phoenix_crm_shared_places").select("id, photo_lat, photo_lon").in("id", part);
      if (error) throw new Error(`Could not read the shared places' live photos: ${error.message}`);
      return (data ?? []) as Array<{ id: string; photo_lat: number | null; photo_lon: number | null }>;
    });
    for (const row of rows) if (finite(row.photo_lat) && finite(row.photo_lon)) venues.set(String(row.id), { lat: row.photo_lat, lon: row.photo_lon });
  }
  for (const place of places) {
    if (finite(place.photo_lat) && finite(place.photo_lon)) out.set(String(place.id), { lat: place.photo_lat, lon: place.photo_lon });
    else if (place.shared_place_id && venues.has(String(place.shared_place_id))) out.set(String(place.id), venues.get(String(place.shared_place_id))!);
  }
  return out;
}

/**
 * A district manager's own visits, measured the same way: the visit's own fix (`loadManagerVisitFixes`, the one
 * adapter) against the live photo of that customer's place. A visit to a customer on his own list has no validated place
 * and reads "No live photo for this place". A failed read throws: the page says so.
 */
async function readManagerVisitFixes(visitIds: string[]): Promise<Map<string, { lat: number | null; lon: number | null; photo: PhotoPoint | null }>> {
  const out = new Map<string, { lat: number | null; lon: number | null; photo: PhotoPoint | null }>();
  // 🔴 The screen's id for his own visit is `own:<uuid>` (`readOwnVisitDetails`), a LABEL and never a key: sent to the
  // uuid column as it is, the read failed and took the whole page and its Excel down (9-11 Nov 2026). The read asks by
  // the bare uuid; the map answers by the screen's id, which is what the caller looks up.
  const screenIdOf = new Map<string, string>();
  for (const id of visitIds) screenIdOf.set(managerOwnVisitUuid(id), id);
  const ids = [...screenIdOf.keys()];
  if (ids.length === 0) return out;
  const visits = await loadManagerVisitFixes(ids);
  const customerIds = [...new Set(visits.flatMap((visit) => (visit.customerId ? [visit.customerId] : [])))];
  const places = customerIds.length
    ? await readSeatGroups(customerIds, 100, async (part) => {
        const { data, error } = await getSupabaseAdmin().from("phoenix_crm_places").select("id, customer_id").in("customer_id", part).eq("status", "active");
        if (error) throw new Error(`Could not read the customers' places: ${error.message}`);
        return (data ?? []) as Array<{ id: string; customer_id: string }>;
      })
    : [];
  const photos = await readPlacePhotos(places.map((place) => String(place.id)));
  const photoOfCustomer = new Map<string, PhotoPoint>();
  for (const place of places) {
    const photo = photos.get(String(place.id));
    if (photo && !photoOfCustomer.has(String(place.customer_id))) photoOfCustomer.set(String(place.customer_id), photo);
  }
  for (const visit of visits) {
    out.set(screenIdOf.get(String(visit.id)) ?? String(visit.id), { lat: visit.lat, lon: visit.lon, photo: visit.customerId ? (photoOfCustomer.get(visit.customerId) ?? null) : null });
  }
  return out;
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
  if (!readsAnyTeamReport(viewer)) throw forbiddenError("This report is for a Regional Sales Manager, a District Manager or the Super Admin.");
  const today = viewer.visitDay;
  const yesterday = addDaysIso(today, -1);
  const seats = teamReportRepSeats(viewer);
  const worlds = regionalReportWorlds(viewer);

  const rows = await readVisitRows(
    seats.map((seat) => seat.seatId),
    worlds,
    yesterday,
    today,
  );
  const [customerNames, photos] = await Promise.all([
    readCustomerNames([...new Set(rows.flatMap((row) => (row.customer_id ? [String(row.customer_id)] : [])))]),
    readPlacePhotos(rows.flatMap((row) => (row.place_id ? [String(row.place_id)] : []))),
  ]);
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
  const managerFixes = await readManagerVisitFixes(ownRows.filter((visit) => visit.source === "own").map((visit) => visit.id));
  const [names, hireDates] = await Promise.all([
    loadPeopleNames([...managerHrIds, ...seats.flatMap((seat) => seatOccupants(seat))]),
    readHireDates([...managerHrIds, ...seats.flatMap((seat) => seatOccupants(seat))]),
  ]);
  const hireDateOf = (hrId: string | null | undefined) => hireDates.get(personKey(hrId) ?? "") ?? null;

  // Each district manager's own week for yesterday and today — two weeks when a Saturday falls between them. A read
  // that fails is said on his row ("Plan could not be read"), never shown as nothing planned.
  const dmSeatIds = groups.flatMap((group) => (group.district?.occupantHrId ? [group.district.seatId] : []));
  const weekStarts = [...new Set([fieldWeekStart(yesterday), fieldWeekStart(today)])];
  let dmWeeksUnread = false;
  const dmWeeks = new Map<string, Awaited<ReturnType<typeof loadDistrictManagerWeeks>>>();
  if (dmSeatIds.length > 0) {
    try {
      for (const weekStart of weekStarts) {
        const parts = await Promise.all(
          worlds.map((isTest) => loadDistrictManagerWeeks({ cairoToday: viewer.cairoToday, dmSeatIds, isTest, org: viewer.org, weekStart })),
        );
        dmWeeks.set(weekStart, mergeDistrictManagerWeeks(parts));
      }
    } catch (error) {
      dmWeeksUnread = true;
      logWarning("Phoenix CRM could not read the district managers' own weeks for Visits — Yesterday and Today", {
        labels: { event: "phoenix_crm_team_visits_dm_day_unread" },
        error,
        context: { weekStarts },
      });
    }
  }
  const seatLookup = (seatId: string) => viewer.org.seats.get(seatId);

  // Leave and recorded day activities for every rep and district manager seat, both days — printed in the square
  // instead of visits (owner, 2026-11-09). Each read that fails is said on the screen, never read as a worked day.
  const dmSeats = groups.flatMap((group) => (group.district ? [group.district] : []));
  const range = { from: yesterday, to: today };
  const leave = await loadSeatsLeaveLabels([...seats, ...dmSeats], range);
  let activitiesUnread = false;
  const activities = new Map<string, DayActivityRow>();
  try {
    for (const isTest of worlds) {
      const found = await loadSeatDayActivities([...seats, ...dmSeats].map((seat) => seat.seatId), isTest, range);
      for (const [key, row] of found) if (!activities.has(key)) activities.set(key, row);
    }
  } catch (error) {
    activitiesUnread = true;
    logWarning("Phoenix CRM could not read the day activities for Visits — Yesterday and Today", {
      labels: { event: "phoenix_crm_team_visits_activities_unread" },
      error,
      context: { seats: seats.length + dmSeats.length },
    });
  }
  const awayOn = (seatId: string, on: string) => teamVisitAway(leave.days.get(seatId)?.get(on), activities.get(`${seatId}|${on}`));
  const managerDayOn = (dmSeatId: string, on: string): TeamVisitManagerDay => {
    if (dmWeeksUnread) return teamVisitManagerDay(null, true);
    const week = (dmWeeks.get(fieldWeekStart(on)) ?? []).find((row) => row.dmSeatId === dmSeatId);
    return teamVisitManagerDay(week ? districtManagerDayOn(week, on, seatLookup) : null);
  };

  const totals = { today: emptyTeamVisitDay(), yesterday: emptyTeamVisitDay() };
  const districts: TeamVisitDistrict[] = [];
  for (const group of groups) {
    const district = group.district;
    const managerHrId = district?.occupantHrId ?? null;
    const reps = group.items
      .map((seat): TeamVisitRep => {
        const people = seatOccupants(seat);
        const shown = locationSight(viewer, seat) !== "none";
        const day = (on: string): TeamVisitDay => ({
          ...foldTeamVisitDay(bySeatDay.get(`${seat.seatId}|${on}`) ?? [], customerNames, photos, shown),
          away: awayOn(seat.seatId, on),
        });
        const rep: TeamVisitRep = {
          person: people.length ? people.map((hrId) => nameOf(names, hrId)).join(" · ") : "Seat is vacant",
          seatId: seat.seatId,
          vacant: people.length === 0,
          hireDates: people.flatMap((hrId) => hireDateOf(hrId) ?? []),
          territory: territoryName(seat),
          today: day(today),
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
            origin: visit.enteredByAdmin ? "admin" : visit.planned ? "planned" : "unplanned",
            savedAt: cairoTimeOnly(visit.loggedAt),
            waiting: false,
            ...visitPhotoDistance(managerFixes.get(visit.id) ?? {}, managerFixes.get(visit.id)?.photo, !district || locationSight(viewer, district) !== "none"),
          });
        }
        day.times.sort((left, right) => (left.at ?? "9999").localeCompare(right.at ?? "9999"));
        if (district) day.away = awayOn(district.seatId, on);
        return day;
      };
      managerOwn = { today: ownDay(today), yesterday: ownDay(yesterday) };
    }

    districts.push({
      districtName: district ? territoryName(district) : "No district manager",
      regionName: group.regionName,
      vacantSeats: group.items.filter((seat) => seatOccupants(seat).length === 0).length,
      managerHrId,
      managerHireDate: managerHrId ? hireDateOf(managerHrId) : null,
      managerName: district ? (managerHrId ? nameOf(names, managerHrId) : "Seat is vacant") : "No district manager",
      managerOwn,
      managerDay: district && managerHrId ? { today: managerDayOn(district.seatId, today), yesterday: managerDayOn(district.seatId, yesterday) } : null,
      repsTotal: { today: sumTeamVisitDays(reps.map((rep) => rep.today)), yesterday: sumTeamVisitDays(reps.map((rep) => rep.yesterday)) },
      reps,
    });
  }
  return { activitiesUnread, districts, leaveUnread: leave.unread, today, totals, yesterday };
}
