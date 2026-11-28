/**
 * Phoenix CRM — the Far-visit week report (owner, 28 Nov 2026): every rep in the reader's scope, his week day by day,
 * green where it was clean and red where a visit was refused for where it was logged, with the names, the full
 * detail of each refusal, the map behind it, and the same detail as an Excel file.
 *
 * WHO READS IT — `canReadFarVisitWeekReport`: the Super Admin and the SFE Manager across the company, and a District
 * Manager (acting or not) or National Sales Manager across his own scope (`scopeTerritories`): the readers of every
 * far-visit count (`readsPlaceVsActual`, the owner's ruling of 2026-10-02 — never the CEO, never an RSM). A rep is never a reader:
 * this is location evidence about named people, and Golden Rule #1 keeps every such board off his screens. A manager
 * who also holds a territory as its rep never sees his own seat here (`isLocationBlind`).
 *
 * WHAT IT COUNTS, from three tables and nothing else:
 *   - the visits logged (`phoenix_crm_visits`, the rep's own entries — a copied iReports360 visit is skipped);
 *   - the visits refused at the door for being far (`phoenix_crm_refused_readings`, reason `far_from_place`), one line
 *     per customer per day however many times he pressed save, and ALWAYS rejected: a far try is refused the moment
 *     save is pressed and never accepted (owner, 28 Nov 2026); a visit to that customer that met the rule later the
 *     same day is a separate, accepted visit, named beside it (`loggedLater`);
 *   - the far visits held for the SFE (`phoenix_crm_far_visit_holds`): refused is rejected, sfe_pending is waiting,
 *     approved counts as an ordinary visit.
 * Test entries never appear. Managers read the DISTANCE and nothing about the reading behind it (owner, 2026-10-02).
 */
import { buildCaseMap, type CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import {
  FAR_VISIT_WEEK_POINT_LABELS,
  farVisitWeek,
  farVisitWeekStanding,
  type FarVisitWeek,
  type FarVisitWeekCellCounts,
  type FarVisitWeekKind,
  type FarVisitWeekStanding,
} from "@/lib/phoenix-crm/far-visit-week-rules";
import { distanceMeters, isUsableFix } from "@/lib/phoenix-crm/geo";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { isLocationBlind, readsPlaceVsActual, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;
type Point = { lat: number; lon: number };

/**
 * Who opens the report: whoever reads a far-visit count at all (`readsPlaceVsActual`), the Super Admin, the SFE
 * Manager and a District Manager (acting or not) or National Sales Manager seat. 🔴 Never `readsTeamReports`: the
 * owner took the CEO and the Regional Sales Manager off every far-visit count on 2026-10-02. A rep is never a reader.
 */
export function canReadFarVisitWeekReport(viewer: PhoenixCrmViewer): boolean {
  return readsPlaceVsActual(viewer);
}

/** The territories the report covers for this reader: his scope, never a seat he holds as its rep. */
export function farVisitWeekSeats(viewer: PhoenixCrmViewer): OrgSeat[] {
  if (!canReadFarVisitWeekReport(viewer)) throw forbiddenError("The far-visit week is for managers.");
  return viewer.scopeTerritories.filter((seat) => !seat.isOtherPseudoDm && !isLocationBlind(viewer, seat));
}

export type FarVisitWeekCell = FarVisitWeekCellCounts & { date: string; standing: FarVisitWeekStanding };

export type FarVisitWeekRow = {
  seatId: string;
  repName: string;
  territory: string;
  regionName: string | null;
  cells: FarVisitWeekCell[];
  totals: FarVisitWeekCellCounts;
  cleanDays: number;
};

export type FarVisitWeekItem = {
  kind: FarVisitWeekKind;
  seatId: string;
  date: string;
  /** When it happened (ISO): the last refused try, or when the visit was held. */
  at: string | null;
  repName: string;
  territory: string;
  customerId: string;
  customerName: string;
  /** Metres from the customer's place, as the check measured it. */
  distanceMeters: number | null;
  /** The far line it was measured against. */
  farMeters: number | null;
  /** How many times save was pressed (a door refusal), or the stuck rep's tries (a hold). */
  tries: number;
  /** A door refusal whose customer the rep then visited from the right place the same day (an accepted visit apart). */
  loggedLater: boolean;
  spot: Point | null;
  visitId: string | null;
  placeId: string | null;
};

export type FarVisitWeekReport = {
  week: FarVisitWeek;
  rows: FarVisitWeekRow[];
  items: FarVisitWeekItem[];
  totals: FarVisitWeekCellCounts & { reps: number; repsWithRejections: number };
};

const EMPTY_COUNTS = (): FarVisitWeekCellCounts => ({ visits: 0, doorRejected: 0, sfeRejected: 0, waiting: 0 });

function pointOf(lat: unknown, lon: unknown): Point | null {
  const a = numberOrNull(lat);
  const b = numberOrNull(lon);
  return a !== null && b !== null && isUsableFix(a, b) ? { lat: a, lon: b } : null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function loadCustomerNames(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const supabase = getSupabaseAdmin();
  for (const part of chunks([...new Set(ids)], 100)) {
    const { data, error } = await supabase.from("phoenix_crm_customers").select("id, name").in("id", part);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) out.set(String(row.id), String(row.name ?? "").trim() || "Customer");
  }
  return out;
}

/**
 * The week for every territory in the reader's scope. A company reader is read without a seat filter and narrowed
 * here (a list of every seat id would ride in the URL of each request); a manager's seats are asked by id.
 */
export async function loadFarVisitWeekReport(viewer: PhoenixCrmViewer, rawWeek: string | null | undefined): Promise<FarVisitWeekReport> {
  const seats = farVisitWeekSeats(viewer);
  const week = farVisitWeek(rawWeek, viewer.cairoToday);
  const seatIds = seats.map((seat) => seat.seatId);
  const inScope = new Set(seatIds);
  const companyWide = viewer.isSuperAdmin || viewer.isSfeManager;
  if (seats.length === 0) {
    return { week, rows: [], items: [], totals: { ...EMPTY_COUNTS(), reps: 0, repsWithRejections: 0 } };
  }
  const supabase = getSupabaseAdmin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder, narrowed by seat for a manager only.
  const bySeat = (query: any): any => (companyWide ? query : query.in("seat_id", seatIds));

  const [visits, refusals, holds] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        bySeat(
          supabase
            .from("phoenix_crm_visits")
            .select("id, seat_id, customer_id, visit_date")
            .gte("visit_date", week.start)
            .lte("visit_date", week.end)
            .eq("is_test", false)
            .is("imported_from_ireports360_at", null),
        ),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        bySeat(
          supabase
            .from("phoenix_crm_refused_readings")
            .select("id, seat_id, rep_hr_id, customer_id, visit_date, refused_at, lat, lon, distance_meters, max_accuracy_meters, place_id")
            .eq("reason", "far_from_place")
            .eq("is_test", false)
            .gte("visit_date", week.start)
            .lte("visit_date", week.end),
        ),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        bySeat(
          supabase
            .from("phoenix_crm_far_visit_holds")
            .select("visit_id, seat_id, rep_hr_id, customer_id, place_id, visit_date, status, held_at, distance_meters, far_meters, tries, spot_lat, spot_lon")
            .in("status", ["refused", "sfe_pending"])
            .eq("is_test", false)
            .gte("visit_date", week.start)
            .lte("visit_date", week.end),
        ),
      { cursorColumn: "visit_id", cursorOf: (row) => String(row.visit_id) },
    ),
  ]);

  const counts = new Map<string, FarVisitWeekCellCounts>();
  const cellOf = (seatId: string, date: string): FarVisitWeekCellCounts => {
    const key = `${seatId}|${date}`;
    let cell = counts.get(key);
    if (!cell) {
      cell = EMPTY_COUNTS();
      counts.set(key, cell);
    }
    return cell;
  };
  const logged = new Set<string>();
  for (const row of visits) {
    const seatId = String(row.seat_id);
    if (!inScope.has(seatId)) continue;
    const date = String(row.visit_date);
    cellOf(seatId, date).visits += 1;
    logged.add(`${seatId}|${date}|${String(row.customer_id)}`);
  }

  const seatById = new Map(seats.map((seat) => [seat.seatId, seat]));
  const rawItems: Array<Omit<FarVisitWeekItem, "repName" | "territory" | "customerName"> & { repHrId: string | null }> = [];

  // One door line per customer per day: the latest try's spot, the nearest distance, every try counted.
  const doorGroups = new Map<string, Row[]>();
  for (const row of refusals) {
    const seatId = String(row.seat_id);
    if (!inScope.has(seatId) || !row.customer_id) continue;
    const key = `${seatId}|${String(row.visit_date)}|${String(row.customer_id)}`;
    doorGroups.set(key, [...(doorGroups.get(key) ?? []), row]);
  }
  for (const [key, group] of doorGroups) {
    const [seatId, date, customerId] = key.split("|");
    const latest = [...group].sort((a, b) => String(b.refused_at).localeCompare(String(a.refused_at)))[0];
    const distances = group.map((row) => numberOrNull(row.distance_meters)).filter((value): value is number => value !== null);
    // 🔴 A far try is refused the moment save is pressed and is never accepted (owner, 28 Nov 2026: "It is rejected
    // at once, never accepted. The accepted is the one meeting our criteria"). So it is ALWAYS a rejection; a visit
    // to the same customer that met the rule later that day is a separate, accepted visit, named beside it.
    const loggedLater = logged.has(key);
    cellOf(seatId, date).doorRejected += 1;
    rawItems.push({
      kind: "door",
      seatId,
      date,
      at: latest.refused_at ? String(latest.refused_at) : null,
      repHrId: latest.rep_hr_id ? String(latest.rep_hr_id) : null,
      customerId,
      distanceMeters: distances.length > 0 ? Math.min(...distances) : null,
      farMeters: numberOrNull(latest.max_accuracy_meters),
      tries: group.length,
      loggedLater,
      spot: pointOf(latest.lat, latest.lon),
      visitId: null,
      placeId: latest.place_id ? String(latest.place_id) : null,
    });
  }

  for (const row of holds) {
    const seatId = String(row.seat_id);
    if (!inScope.has(seatId)) continue;
    const date = String(row.visit_date);
    const kind: FarVisitWeekKind = row.status === "refused" ? "sfe" : "waiting";
    if (kind === "sfe") cellOf(seatId, date).sfeRejected += 1;
    else cellOf(seatId, date).waiting += 1;
    rawItems.push({
      kind,
      seatId,
      date,
      at: row.held_at ? String(row.held_at) : null,
      repHrId: row.rep_hr_id ? String(row.rep_hr_id) : null,
      customerId: String(row.customer_id),
      distanceMeters: numberOrNull(row.distance_meters),
      farMeters: numberOrNull(row.far_meters),
      tries: numberOrNull(row.tries) ?? 1,
      loggedLater: false,
      spot: pointOf(row.spot_lat, row.spot_lon),
      visitId: String(row.visit_id),
      placeId: row.place_id ? String(row.place_id) : null,
    });
  }

  const people = await loadPeopleNames([...seats.map((seat) => seat.occupantHrId), ...rawItems.map((item) => item.repHrId)]);
  const customers = await loadCustomerNames(rawItems.map((item) => item.customerId));
  const repNameOfSeat = (seat: OrgSeat): string => (seat.occupantHrId ? nameOf(people, personKey(seat.occupantHrId)) : "Vacant territory");

  const rows: FarVisitWeekRow[] = seats.map((seat) => {
    const totals = EMPTY_COUNTS();
    let cleanDays = 0;
    const cells = week.days.map((date) => {
      const cell = counts.get(`${seat.seatId}|${date}`) ?? EMPTY_COUNTS();
      totals.visits += cell.visits;
      totals.doorRejected += cell.doorRejected;
      totals.sfeRejected += cell.sfeRejected;
      totals.waiting += cell.waiting;
      const standing = farVisitWeekStanding(cell);
      if (standing === "clean") cleanDays += 1;
      return { ...cell, date, standing };
    });
    return { seatId: seat.seatId, repName: repNameOfSeat(seat), territory: territoryName(seat), regionName: seat.regionName, cells, totals, cleanDays };
  });
  // The reps with something to look at first, most rejected at the top; then everyone else by name.
  rows.sort((a, b) => {
    const rejected = b.totals.doorRejected + b.totals.sfeRejected - (a.totals.doorRejected + a.totals.sfeRejected);
    if (rejected !== 0) return rejected;
    if (b.totals.waiting !== a.totals.waiting) return b.totals.waiting - a.totals.waiting;
    return a.repName.localeCompare(b.repName);
  });

  const items: FarVisitWeekItem[] = rawItems
    .map(({ repHrId, ...item }) => {
      const seat = seatById.get(item.seatId);
      return {
        ...item,
        repName: repHrId ? nameOf(people, personKey(repHrId)) : seat ? repNameOfSeat(seat) : "Unknown person",
        territory: seat ? territoryName(seat) : item.seatId,
        customerName: customers.get(item.customerId) ?? "Customer",
      };
    })
    .sort((a, b) => a.repName.localeCompare(b.repName) || a.date.localeCompare(b.date) || String(a.at).localeCompare(String(b.at)));

  const totals = rows.reduce(
    (sum, row) => ({
      visits: sum.visits + row.totals.visits,
      doorRejected: sum.doorRejected + row.totals.doorRejected,
      sfeRejected: sum.sfeRejected + row.totals.sfeRejected,
      waiting: sum.waiting + row.totals.waiting,
      reps: sum.reps + 1,
      repsWithRejections: sum.repsWithRejections + (row.totals.doorRejected + row.totals.sfeRejected > 0 ? 1 : 0),
    }),
    { ...EMPTY_COUNTS(), reps: 0, repsWithRejections: 0 },
  );
  return { week, rows, items, totals };
}

export type FarVisitWeekDayItem = FarVisitWeekItem & { map: CaseMap | null; points: Array<{ index: number; label: string; lat: number; lon: number }> };

const DAY_MAP_SIZE = { width: 256, height: 256, padding: 32 };

/**
 * One rep's day, opened from its cell: every line of that day with its map — 1 where he was when he pressed save (a
 * held visit: where it was submitted), 2 the customer's saved place, 3 where the place's photo was captured. The
 * place drawn is the customer's active place nearest to where he was, as the SFE's own map draws it.
 */
export async function loadFarVisitWeekDay(viewer: PhoenixCrmViewer, report: FarVisitWeekReport, seatId: string, date: string): Promise<FarVisitWeekDayItem[]> {
  if (!farVisitWeekSeats(viewer).some((seat) => seat.seatId === seatId)) throw notFoundError("That territory is not in your report.");
  const lines = report.items.filter((item) => item.seatId === seatId && item.date === date);
  if (lines.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const visitIds = lines.map((item) => item.visitId).filter((id): id is string => id !== null);
  const customerIds = [...new Set(lines.map((item) => item.customerId))];
  const placeColumns = "id, customer_id, lat, lon, pin_lat, pin_lon, photo_lat, photo_lon";
  const [visits, places] = await Promise.all([
    visitIds.length > 0
      ? supabase.from("phoenix_crm_visits").select("id, lat, lon").in("id", visitIds).is("imported_from_ireports360_at", null)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("phoenix_crm_places").select(placeColumns).in("customer_id", customerIds).eq("status", "active").is("retired_at", null),
  ]);
  throwIfError(visits.error);
  throwIfError(places.error);
  const visitSpot = new Map(((visits.data ?? []) as Row[]).map((row) => [String(row.id), pointOf(row.lat, row.lon)]));
  const placesByCustomer = new Map<string, Row[]>();
  for (const row of (places.data ?? []) as Row[]) {
    const key = String(row.customer_id);
    placesByCustomer.set(key, [...(placesByCustomer.get(key) ?? []), row]);
  }
  const pinOf = (place: Row): Point | null => pointOf(place.pin_lat, place.pin_lon) ?? pointOf(place.lat, place.lon);
  return lines.map((item) => {
    const where = (item.visitId ? visitSpot.get(item.visitId) : null) ?? item.spot;
    const candidates = placesByCustomer.get(item.customerId) ?? [];
    let place = candidates.find((candidate) => String(candidate.id) === item.placeId) ?? candidates[0];
    if (where && candidates.length > 1) {
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const near = [pinOf(candidate), pointOf(candidate.photo_lat, candidate.photo_lon)]
          .filter((point): point is Point => point !== null)
          .map((point) => distanceMeters(where, point));
        const metres = near.length > 0 ? Math.min(...near) : Number.POSITIVE_INFINITY;
        if (metres < best) {
          best = metres;
          place = candidate;
        }
      }
    }
    const pin = place ? pinOf(place) : null;
    const photo = place ? pointOf(place.photo_lat, place.photo_lon) : null;
    const labelled: Array<{ label: string; lat: number; lon: number }> = [];
    if (where) labelled.push({ label: FAR_VISIT_WEEK_POINT_LABELS.submitted, ...where });
    if (pin) labelled.push({ label: FAR_VISIT_WEEK_POINT_LABELS.place, ...pin });
    if (photo) labelled.push({ label: FAR_VISIT_WEEK_POINT_LABELS.photo, ...photo });
    const map = where && labelled.length > 1 ? buildCaseMap(labelled.map((point) => ({ ...point, accuracyMeters: null })), DAY_MAP_SIZE) : null;
    return { ...item, map, points: labelled.map((point, index) => ({ index: index + 1, ...point })) };
  });
}
