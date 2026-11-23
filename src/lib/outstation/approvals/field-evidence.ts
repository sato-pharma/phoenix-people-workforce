/**
 * Field work and route for EVERY waiting claim, in one batch of Phoenix CRM reads.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The reviewer's own reader
 * (`crm-trip-evidence-reader.ts`) reads one trip richly — plans, ride-alongs, nights, warnings —
 * and costs a dozen queries per trip. The queue needs far less for each of its 64 trips: was each
 * trip day worked, and were the visits at the claimed destination. So this reads once for all of
 * them and feeds the SAME pure reading (`buildCrmTripEvidence`) the reviewer shows, so the row and
 * the reviewer can never disagree about a day.
 *
 * A trip day is worked when the person has a Phoenix CRM visit that day in ANY role — the rep who
 * saved it, the manager, senior or product manager on it, or a later companion — or one of his own
 * single visits as a manager, or a recorded meeting (trip-day-meetings.ts, owner 2026-11-07).
 * Copied iReports360 history and archived copies are skipped: this reader judges.
 *
 * 🔴 A source that could not be read is NEVER "nothing there". If visits, a manager's own visits,
 *    the activities or the team starts fail, no trip gets a reading and the checks answer
 *    "could not check" — a claim is not filed as idle because a query timed out.
 *
 * Read-only; nothing here moves money.
 */

import { CRM_DESTINATION_RADIUS_KM, buildCrmTripEvidence, type CrmPoint } from "@/lib/outstation/crm-trip-evidence";
import type { FieldWorkReading } from "@/lib/outstation/approvals/checks";
import { logError } from "@/lib/observability/log";
import { daysBeforePhoenixCrm } from "@/lib/phoenix-crm/live-team-rules";
import { heldManagerSeats, ownTerritories, personKey } from "@/lib/phoenix-crm/scope";
import { loadTeamCountedWindows } from "@/lib/phoenix-crm/server/live-teams";
import { loadManagerOwnVisitRows, loadManagerVisitFixes } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { managerOwnVisitUuid } from "@/lib/phoenix-crm/server/manager-visit-details";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

export type FieldEvidenceTrip = {
  claimedKm: number | null;
  /** Cairo trip days, in order. */
  dates: string[];
  destination: CrmPoint | null;
  home: CrmPoint | null;
  hrId: string | null;
  isCar: boolean;
  requestId: number;
};

export type FieldEvidence = {
  byRequest: Map<number, FieldWorkReading>;
  /** What could not be read, in words the page prints. */
  unavailable: string[];
};

/** The day activities that are a recorded meeting — Meeting and Group meeting, nothing wider. */
export const MEETING_ACTIVITY_KEYS: ReadonlySet<string> = new Set(["meeting", "group_meeting"]);

const VISIT_COLUMNS = "id, visit_date, lat, lon, place_id, rep_hr_id, manager_hr_id, senior_hr_id, product_manager_hr_id";
const ROLE_COLUMNS = ["rep_hr_id", "manager_hr_id", "senior_hr_id", "product_manager_hr_id"] as const;
const CHUNK = 100;

function chunk<T>(values: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

/** A position, or null — nothing, half a pair and the old 0,0 marker are all "no position". */
export function pointOf(lat: unknown, lon: unknown): CrmPoint | null {
  const la = num(lat);
  const lo = num(lon);
  if (la === null || lo === null || (la === 0 && lo === 0)) return null;
  return { lat: la, lon: lo };
}

type PersonVisit = { date: string; id: string; placeId: string | null; point: CrmPoint | null };

/**
 * What the batch reads hold for one person and one day, before it becomes a reading. Pure, and
 * exported for the test: who a visit row belongs to is the rule most likely to drift.
 */
export function visitPeople(row: Row): string[] {
  const people = new Set<string>();
  for (const column of ROLE_COLUMNS) {
    const key = personKey(typeof row[column] === "string" ? (row[column] as string) : null);
    if (key) people.add(key);
  }
  const companions = Array.isArray(row.companion) ? (row.companion as Row[]) : row.companion ? [row.companion as Row] : [];
  for (const companion of companions) {
    const key = personKey(typeof companion.hr_id === "string" ? companion.hr_id : null);
    if (key) people.add(key);
  }
  return [...people];
}

async function readVisits(people: string[], start: string, end: string): Promise<Row[]> {
  const base = (columns: string) =>
    getSupabaseAdmin()
      .from("phoenix_crm_visits")
      .select(columns)
      .eq("is_test", false)
      .is("imported_from_ireports360_at", null)
      .is("archived_at", null)
      .gte("visit_date", start)
      .lte("visit_date", end);
  const reads: Array<Promise<Row[]>> = [];
  for (const part of chunk(people, CHUNK)) {
    for (const column of ROLE_COLUMNS) reads.push(fetchAllRows<Row>(() => base(VISIT_COLUMNS).in(column, part), "id"));
    // A third or later companion on a chain stands in none of the four columns, only here.
    reads.push(
      fetchAllRows<Row>(
        () => base(`${VISIT_COLUMNS}, companion:phoenix_crm_visit_companions!inner(hr_id)`).in("companion.hr_id", part),
        "id",
      ),
    );
  }
  return (await Promise.all(reads)).flat();
}

async function readMeetings(people: string[], start: string, end: string): Promise<Row[]> {
  const reads = chunk(people, CHUNK).map((part) =>
    fetchAllRows<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_activities")
          .select("id, rep_hr_id, activity_date, activity_type")
          .eq("is_test", false)
          .in("rep_hr_id", part)
          .gte("activity_date", start)
          .lte("activity_date", end),
      "id",
    ),
  );
  return (await Promise.all(reads)).flat();
}

async function readPlacePins(placeIds: string[]): Promise<Map<string, CrmPoint>> {
  const pins = new Map<string, CrmPoint>();
  for (const part of chunk(placeIds, CHUNK)) {
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_places").select("id, lat, lon, pin_lat, pin_lon").in("id", part);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[]) {
      const point = pointOf(row.pin_lat, row.pin_lon) ?? pointOf(row.lat, row.lon);
      if (point) pins.set(String(row.id), point);
    }
  }
  return pins;
}

export async function loadFieldEvidence(trips: ReadonlyArray<FieldEvidenceTrip>): Promise<FieldEvidence> {
  const byRequest = new Map<number, FieldWorkReading>();
  const dated = trips.filter((trip) => trip.dates.length > 0 && personKey(trip.hrId));
  if (dated.length === 0) return { byRequest, unavailable: [] };

  const people = [...new Set(dated.map((trip) => personKey(trip.hrId) as string))];
  const start = dated.reduce((min, trip) => (trip.dates[0] < min ? trip.dates[0] : min), dated[0].dates[0]);
  const end = dated.reduce((max, trip) => {
    const last = trip.dates[trip.dates.length - 1];
    return last > max ? last : max;
  }, dated[0].dates[0]);

  let visitRows: Row[];
  let meetingRows: Row[];
  let ownVisits: Awaited<ReturnType<typeof loadManagerOwnVisitRows>>;
  let org: Awaited<ReturnType<typeof loadPhoenixCrmOrg>>;
  let windows: Awaited<ReturnType<typeof loadTeamCountedWindows>>;
  try {
    [visitRows, meetingRows, ownVisits, org, windows] = await Promise.all([
      readVisits(people, start, end),
      readMeetings(people, start, end),
      loadManagerOwnVisitRows({ end, managerHrIds: people, start }),
      loadPhoenixCrmOrg(),
      loadTeamCountedWindows(),
    ]);
  } catch (error) {
    // Named on the page AND recorded: a swallowed failure cannot be found afterwards.
    logError("Phoenix CRM field work could not be read for the expense desk", {
      labels: { event: "expense_desk_evidence_failed", source: "Phoenix CRM field work" },
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { byRequest, unavailable: ["Phoenix CRM field work"] };
  }

  // Positions are a softer loss: without them the route answers "could not check", and the day is
  // still worked or idle.
  const unavailable: string[] = [];
  let ownFixes = new Map<string, CrmPoint>();
  let pins = new Map<string, CrmPoint>();
  try {
    const placeIds = [
      ...new Set(
        visitRows
          .filter((row) => !pointOf(row.lat, row.lon) && typeof row.place_id === "string")
          .map((row) => String(row.place_id)),
      ),
    ];
    // 🔴 A manager's own visit wears `own:<uuid>` (a screen LABEL, never a key). Sent to the uuid column
    // as it is, the database refused the read, so no manager's own visit and no place pin carried a
    // position and the page said "visit positions could not be read" on every load (found on the live
    // desk, 23 Nov 2026; that day's 64 answers happened not to change). The read asks by the bare
    // uuid; the map is keyed by it too.
    const [fixes, readPins] = await Promise.all([
      loadManagerVisitFixes(ownVisits.map((visit) => managerOwnVisitUuid(visit.id))),
      readPlacePins(placeIds),
    ]);
    ownFixes = new Map(
      fixes.flatMap((fix) => {
        const point = pointOf(fix.lat, fix.lon);
        return point ? [[fix.id, point] as [string, CrmPoint]] : [];
      }),
    );
    pins = readPins;
  } catch (error) {
    logError("Visit positions could not be read for the expense desk", {
      labels: { event: "expense_desk_evidence_failed", source: "visit positions" },
      error: error instanceof Error ? error : new Error(String(error)),
    });
    unavailable.push("visit positions");
  }

  const visitsByPerson = new Map<string, Map<string, PersonVisit>>();
  const add = (person: string, visit: PersonVisit) => {
    const mine = visitsByPerson.get(person) ?? new Map<string, PersonVisit>();
    if (!mine.has(visit.id)) mine.set(visit.id, visit);
    visitsByPerson.set(person, mine);
  };
  for (const row of visitRows) {
    const placeId = typeof row.place_id === "string" ? row.place_id : null;
    const visit: PersonVisit = {
      date: String(row.visit_date ?? "").slice(0, 10),
      id: `v:${String(row.id)}`,
      placeId,
      point: pointOf(row.lat, row.lon) ?? (placeId ? (pins.get(placeId) ?? null) : null),
    };
    for (const person of visitPeople(row)) add(person, visit);
  }
  for (const visit of ownVisits) {
    const person = personKey(visit.managerHrId);
    if (person) add(person, { date: visit.date, id: `m:${visit.id}`, placeId: null, point: ownFixes.get(managerOwnVisitUuid(visit.id)) ?? null });
  }

  const meetings = new Map<string, number>();
  for (const row of meetingRows) {
    if (!MEETING_ACTIVITY_KEYS.has(String(row.activity_type ?? ""))) continue;
    const person = personKey(typeof row.rep_hr_id === "string" ? row.rep_hr_id : null);
    if (!person) continue;
    const key = `${person}|${String(row.activity_date ?? "").slice(0, 10)}`;
    meetings.set(key, (meetings.get(key) ?? 0) + 1);
  }

  // The teams whose start says whether a day was counted from Phoenix CRM: the district over each
  // territory he holds, each manager seat he holds, and every started team below one.
  const teamsOf = (person: string): Set<string> => {
    const held = heldManagerSeats(org, person).map((seat) => seat.seatId);
    const teams = new Set<string>([
      ...ownTerritories(org, person).map((seat) => seat.parentSeatId).filter((id): id is string => Boolean(id)),
      ...held,
    ]);
    for (const window of windows) {
      if (held.some((seatId) => org.seats.get(window.teamSeatId)?.path.includes(seatId))) teams.add(window.teamSeatId);
    }
    return teams;
  };
  const teamCache = new Map<string, Set<string>>();

  for (const trip of dated) {
    const person = personKey(trip.hrId) as string;
    const teams = teamCache.get(person) ?? teamsOf(person);
    teamCache.set(person, teams);
    const mine = [...(visitsByPerson.get(person)?.values() ?? [])];
    const reading = buildCrmTripEvidence({
      beforePhoenix: daysBeforePhoenixCrm(windows, teams, trip.dates),
      claimedKm: trip.claimedKm,
      days: trip.dates.map((date) => ({
        activitiesLogged: [],
        date,
        dayStart: null,
        managerPlan: null,
        plan: null,
        rideAlongsPlanned: [],
        sharedCar: [],
        visits: mine
          .filter((visit) => visit.date === date)
          .map((visit) => ({
            area: null,
            brick: null,
            customer: null,
            locationFlag: null,
            place: null,
            point: visit.point,
            region: null,
            savedAt: null,
            unplanned: false,
          })),
      })),
      destination: trip.destination,
      home: trip.home,
      isCar: trip.isCar,
      warnings: [],
    });
    byRequest.set(trip.requestId, {
      days: reading.days.map((day) => ({
        atDestination: day.visits.some((visit) => visit.kmFromDestination !== null && visit.kmFromDestination <= CRM_DESTINATION_RADIUS_KM),
        beforePhoenix: day.beforePhoenix,
        date: day.date,
        meetings: meetings.get(`${person}|${day.date}`) ?? 0,
        positioned: day.visits.some((visit) => visit.point !== null),
        visits: day.visits.length,
      })),
      homeDays: reading.homeDays,
      km: reading.km,
    });
  }

  return { byRequest, unavailable };
}
