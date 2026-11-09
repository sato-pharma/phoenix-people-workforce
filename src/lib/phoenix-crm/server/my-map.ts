/**
 * Phoenix CRM — My map's reader (owner, 2026-10-27: "put a pin on the map for every validated customer, and for
 * the district manager for his team validations").
 *
 * It is a READER: it writes nothing. It reads the active places of the active customers on the territories the
 * viewer reads, this month's countable visits and — for a rep and a district manager — today's approved plan,
 * and hands them to `my-map-rules.ts`, which makes the pins. The full page and the landing card read the same
 * facts the same way, so the card's counts are the page's counts.
 *
 * 🔴 WHOSE TERRITORIES: the viewer's own (`ownTerritories`) and every one he reads (`scopeTerritories`) at the
 * rep tier, less any under the per-line "Others" seat, which holds no reps. Visit report's `readableSeats` is
 * NOT reused: it drops a seat the viewer is blind on, and a rep is blind on his own — his map would be empty.
 * Nothing about where a phone was is read here, so that rule has nothing to guard.
 *
 * 🔴 SLIM READS, EVERY ONE PAGED. Three tables by `seat_id` through `selectByIds` (chunks of ids, each walked by
 * keyset), so a seat with more than 1,000 rows comes back whole. The customer list's own reader is not used: it
 * reads one seat at a time and carries the photos, the timings and the readings this map must never hold.
 *
 * 🔴 IT NEVER THROWS. A source that could not be read logs and answers `unavailable: true`; the screen says so
 * in words and never draws an empty map as if the territory had nobody on it.
 */

import { unstable_cache } from "next/cache";

import { MY_MAP_SNAPSHOT_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { logWarning } from "@/lib/observability/log";
import { cairoDayOfInstant } from "@/lib/phoenix-crm/daily-plan-report";
import { brickLabels, evenSample } from "@/lib/phoenix-crm/my-map-geometry";
import {
  aliasPlanned,
  buildMyMapPins,
  countMyMap,
  mergeTestWorld,
  type MyMapCustomerFact,
  type MyMapManager,
  type MyMapScope,
  type MyMapSeatFact,
  type MyMapSnapshot,
  type MyMapView,
  type MyMapWorldFacts,
} from "@/lib/phoenix-crm/my-map-rules";
import {
  heldManagerSeats,
  isManagerTier,
  managersInScope,
  personKey,
  seatOccupants,
  territoriesBelow,
  territoryName,
  TERRITORY_TIER,
  type OrgSeat,
} from "@/lib/phoenix-crm/scope";
import { canReadMyMap, readWorldFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { dedupeIds, selectByIds } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { plannedCustomersOn } from "@/lib/phoenix-crm/server/visits";
import type { PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { addDays } from "@/lib/phoenix-crm/visit-report-compute";

type Row = Record<string, unknown>;

/** The most points the landing card draws, and the bricks it names. */
const SNAPSHOT_POINTS = 600;
const SNAPSHOT_BRICKS = 8;

/** Who this viewer is on the map: the whole company, a chain of managers, a district, or his own territory. */
export function myMapScopeOf(viewer: PhoenixCrmViewer): MyMapScope {
  if (viewer.basis === "all") return "company";
  const held = viewer.managerSeats.filter((seat) => isManagerTier(seat.tier) && !seat.isOtherPseudoDm);
  if (held.some((seat) => seat.tier === "RSM" || seat.tier === "NSM")) return "manager";
  return held.length > 0 ? "district" : "rep";
}

/** The territories on his map, each once, by name. */
function mapSeats(viewer: PhoenixCrmViewer): OrgSeat[] {
  const byId = new Map<string, OrgSeat>();
  for (const seat of [...viewer.ownTerritories, ...viewer.scopeTerritories]) {
    if (seat.tier !== TERRITORY_TIER || byId.has(seat.seatId)) continue;
    if (seat.path.some((seatId) => viewer.org.seats.get(seatId)?.isOtherPseudoDm)) continue;
    byId.set(seat.seatId, seat);
  }
  return [...byId.values()].sort((left, right) => territoryName(left).localeCompare(territoryName(right)) || left.seatId.localeCompare(right.seatId));
}

/** The facts the map draws, and — for a test account — which copy of a customer stands for the other. */
type MapFacts = MyMapWorldFacts & { alias: Map<string, string> };

function customerFact(row: Row): MyMapCustomerFact {
  const validatedAt = typeof row.validated_at === "string" ? row.validated_at : null;
  return {
    id: String(row.id),
    seatId: String(row.seat_id),
    listType: row.list_type,
    name: row.name,
    speciality: row.speciality,
    grade: row.grade,
    validatedOn: validatedAt ? cairoDayOfInstant(validatedAt) : null,
  };
}

const CUSTOMER_COLUMNS = "id, seat_id, name, list_type, speciality, grade, validated_at";

/** One world's places, customers and this month's countable visits of these territories, every page of each. */
async function readWorldFacts(seatIds: ReadonlyArray<string>, isTest: boolean, visitDay: string): Promise<MyMapWorldFacts> {
  const monthStart = `${visitDay.slice(0, 7)}-01`;
  const [placeRows, customerRows, visitRows] = await Promise.all([
    selectByIds<Row>("phoenix_crm_places", "id, seat_id, customer_id, lat, lon, session, label, brick_name", "seat_id", seatIds, (query) =>
      query.eq("status", "active").eq("is_test", isTest),
    ),
    selectByIds<Row>("phoenix_crm_customers", CUSTOMER_COLUMNS, "seat_id", seatIds, (query) => query.eq("status", "active").eq("is_test", isTest)),
    selectByIds<Row>("phoenix_crm_countable_visits_with_history", "id, customer_id, visit_date", "seat_id", seatIds, (query) =>
      query.eq("is_test", isTest).gte("visit_date", monthStart).lte("visit_date", visitDay),
    ),
  ]);
  const customers = customerRows.map(customerFact);
  // A place on one of these territories whose customer is listed on another is still his place: the customer is
  // read by id. Usually nobody, so usually no read.
  const known = new Set(customers.map((customer) => customer.id));
  const missing = dedupeIds(placeRows.map((row) => String(row.customer_id))).filter((customerId) => !known.has(customerId));
  if (missing.length > 0) {
    const extra = await selectByIds<Row>("phoenix_crm_customers", CUSTOMER_COLUMNS, "id", missing, (query) => query.eq("status", "active").eq("is_test", isTest));
    customers.push(...extra.map(customerFact));
  }
  return {
    places: placeRows.map((row) => ({
      id: String(row.id),
      seatId: String(row.seat_id),
      customerId: String(row.customer_id),
      lat: row.lat,
      lon: row.lon,
      session: row.session,
      label: row.label,
      brick: row.brick_name,
    })),
    customers,
    visits: visitRows.map((row) => ({ customerId: String(row.customer_id), visitDate: String(row.visit_date) })),
  };
}

/**
 * The facts the map draws. A real viewer reads the real world. A test account reads the real world AND its own,
 * the way every report does for one (`docs/test-accounts.md`), and keeps each customer once (`mergeTestWorld`):
 * its test world is a copy of the real lists with no places, and read alone it drew an empty map.
 */
async function readMapFacts(seatIds: ReadonlyArray<string>, isTest: boolean, visitDay: string): Promise<MapFacts> {
  if (!isTest) return { ...(await readWorldFacts(seatIds, false, visitDay)), alias: new Map() };
  const [real, test] = await Promise.all([readWorldFacts(seatIds, false, visitDay), readWorldFacts(seatIds, true, visitDay)]);
  return mergeTestWorld(real, test);
}

type PlanRead = { planned: Set<string> | null; planRead: boolean; planNote: string | null };

/** Today's APPROVED plan of these territories — the stops he has been cleared to work, and nobody else. */
async function readTodaysPlan(seats: ReadonlyArray<OrgSeat>, ownSeatIds: ReadonlySet<string>, isTest: boolean, visitDay: string): Promise<PlanRead> {
  const answers = await Promise.all(
    seats.map((seat) =>
      plannedCustomersOn(seat.seatId, isTest, visitDay)
        .then((answer) => ({ seatId: seat.seatId, answer }))
        .catch((error: unknown) => {
          logWarning("Phoenix CRM My map could not read a territory's plan for today", { error, labels: { event: "phoenix_crm_my_map_plan_unreadable" } });
          return { seatId: seat.seatId, answer: null };
        }),
    ),
  );
  const planned = new Set<string>();
  for (const { answer } of answers) if (answer?.status === "approved") for (const customerId of answer.customerIds) planned.add(customerId);
  const own = answers.find((entry) => ownSeatIds.has(entry.seatId));
  let planNote: string | null = null;
  if (own?.answer && own.answer.status !== "approved") {
    planNote =
      own.answer.status === null
        ? "There is no plan for today, so no stop is marked. Today's stops are marked once a plan for today is approved."
        : "Today's plan is not approved yet, so no stop is marked. They are marked the moment it is.";
  }
  return { planned, planRead: answers.every((entry) => entry.answer !== null), planNote };
}

/** The managers a regional or national manager — or the company — can filter by, each with his territories. */
function mapManagers(viewer: PhoenixCrmViewer, seats: ReadonlyArray<OrgSeat>): Array<Omit<MyMapManager, "name"> & { hrId: string }> {
  const readable = new Map(seats.map((seat, index) => [seat.seatId, index]));
  const self = personKey(viewer.hrId);
  const seen = new Set<string>();
  const out: Array<Omit<MyMapManager, "name"> & { hrId: string }> = [];
  for (const member of managersInScope(viewer.org, viewer.hrId, viewer.basis)) {
    if (member.seat.isOtherPseudoDm || member.hrId === self || seen.has(member.hrId)) continue;
    const held = heldManagerSeats(viewer.org, member.hrId)
      .filter((seat) => !seat.isOtherPseudoDm)
      .map((seat) => seat.seatId);
    const territories = [
      ...new Set(
        territoriesBelow(viewer.org, held)
          .map((seat) => readable.get(seat.seatId))
          .filter((index): index is number => index !== undefined),
      ),
    ].sort((left, right) => left - right);
    if (territories.length === 0) continue;
    seen.add(member.hrId);
    out.push({ hrId: member.hrId, title: [seatTierTitle(member.seat.tier), member.seat.lineName].filter(Boolean).join(" · "), territories });
  }
  return out;
}

function emptyView(scope: MyMapScope, visitDay: string, unavailable: boolean): MyMapView {
  return {
    unavailable,
    scope,
    visitDay,
    pins: [],
    customers: [],
    territories: [],
    managers: [],
    planRead: false,
    planNote: null,
    plannedWithoutPin: 0,
    unplaced: 0,
    withoutPin: { AM: 0, PM: 0, Pharmacy: 0 },
  };
}

/** The full page: every pin on his territories, their customers, and the filters a manager picks from. */
export async function loadMyMap(viewer: PhoenixCrmViewer): Promise<MyMapView> {
  const scope = myMapScopeOf(viewer);
  if (!canReadMyMap(viewer)) return emptyView(scope, viewer.visitDay, false);
  try {
    const seats = mapSeats(viewer);
    if (seats.length === 0) return emptyView(scope, viewer.visitDay, false);
    const isTest = readWorldFor(viewer, null);
    const ownSeatIds = new Set(viewer.ownTerritories.map((seat) => seat.seatId));
    const managerEntries = scope === "manager" || scope === "company" ? mapManagers(viewer, seats) : [];
    const [facts, plan, names] = await Promise.all([
      readMapFacts(
        seats.map((seat) => seat.seatId),
        isTest,
        viewer.visitDay,
      ),
      scope === "rep" || scope === "district"
        ? readTodaysPlan(seats, ownSeatIds, isTest, viewer.visitDay)
        : Promise.resolve<PlanRead>({ planned: null, planRead: false, planNote: null }),
      loadPeopleNames([...seats.flatMap(seatOccupants), ...managerEntries.map((entry) => entry.hrId)]),
    ]);
    const seatFacts: MyMapSeatFact[] = seats.map((seat) => {
      const people = seatOccupants(seat).map((hrId) => nameOf(names, hrId, "Unnamed rep"));
      return { seatId: seat.seatId, name: territoryName(seat), people: people.length > 0 ? people.join(" + ") : "Vacant", line: seat.lineName };
    });
    const built = buildMyMapPins({
      seats: seatFacts,
      places: facts.places,
      customers: facts.customers,
      visits: facts.visits,
      planned: aliasPlanned(plan.planned, facts.alias),
      newSince: addDays(viewer.cairoToday, -6),
      gradeTargets: viewer.config.settings.gradeTargets,
    });
    const managers: MyMapManager[] = managerEntries
      .map((entry) => ({ name: nameOf(names, entry.hrId, "Unnamed manager"), title: entry.title, territories: entry.territories }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { unavailable: false, scope, visitDay: viewer.visitDay, ...built, managers, planRead: plan.planRead, planNote: plan.planNote };
  } catch (error) {
    logWarning("Phoenix CRM My map could not be read", { error, labels: { event: "phoenix_crm_my_map_unreadable" } });
    return emptyView(scope, viewer.visitDay, true);
  }
}

type SnapshotFacts = Omit<MyMapSnapshot, "scope" | "planRead" | "unavailable">;

/**
 * The landing card's figures, for one set of territories — a minute at most behind, and at once after a
 * validation (`invalidateMyMapSnapshotCache`). The key is every argument, so one viewer's card is never served
 * to another whose territories differ.
 */
const readSnapshot = unstable_cache(
  async (seatIdsKey: string, isTest: boolean, visitDay: string, newSince: string, targetsKey: string, plannedKey: string): Promise<SnapshotFacts> => {
    const seatIds = JSON.parse(seatIdsKey) as string[];
    const facts = await readMapFacts(seatIds, isTest, visitDay);
    const plannedIds = JSON.parse(plannedKey) as string[] | null;
    const built = buildMyMapPins({
      seats: seatIds.map((seatId) => ({ seatId, name: "", people: "", line: null })),
      places: facts.places,
      customers: facts.customers,
      visits: facts.visits,
      planned: aliasPlanned(plannedIds ? new Set(plannedIds) : null, facts.alias),
      newSince,
      gradeTargets: JSON.parse(targetsKey) as PhoenixCrmSettings["gradeTargets"],
    });
    const byPlace = [...built.pins].sort((left, right) => left.id.localeCompare(right.id));
    return {
      counts: countMyMap(built.pins, built.customers),
      points: evenSample(byPlace, SNAPSHOT_POINTS).map((pin) => ({ lat: pin.lat, lon: pin.lon, layer: pin.layer })),
      bricks: brickLabels(built.pins, SNAPSHOT_BRICKS).map((brick) => ({ name: brick.name, lat: brick.lat, lon: brick.lon })),
      unplaced: built.unplaced,
      withoutPin: built.withoutPin,
    };
  },
  ["phoenix-crm-my-map-snapshot"],
  { revalidate: 60, tags: [MY_MAP_SNAPSHOT_CACHE_TAG] },
);

/** The landing card: the counts, and a drawn sample of the pins. Null for a viewer with no map. */
export async function loadMyMapSnapshot(viewer: PhoenixCrmViewer): Promise<MyMapSnapshot | null> {
  if (!canReadMyMap(viewer)) return null;
  const scope = myMapScopeOf(viewer);
  const seats = mapSeats(viewer);
  if (seats.length === 0) return null;
  try {
    const isTest = readWorldFor(viewer, null);
    // Only a rep's card marks today's plan: one territory, one read. A manager's team plans are on the page.
    const plan =
      scope === "rep"
        ? await readTodaysPlan(seats, new Set(viewer.ownTerritories.map((seat) => seat.seatId)), isTest, viewer.visitDay)
        : { planned: null, planRead: false, planNote: null };
    const facts = await readSnapshot(
      JSON.stringify(seats.map((seat) => seat.seatId).sort()),
      isTest,
      viewer.visitDay,
      addDays(viewer.cairoToday, -6),
      JSON.stringify(viewer.config.settings.gradeTargets),
      JSON.stringify(plan.planned ? [...plan.planned].sort() : null),
    );
    return { unavailable: false, scope, planRead: plan.planRead, ...facts };
  } catch (error) {
    logWarning("Phoenix CRM My map's landing card could not be read", { error, labels: { event: "phoenix_crm_my_map_snapshot_unreadable" } });
    return {
      unavailable: true,
      scope,
      planRead: false,
      counts: countMyMap([], []),
      points: [],
      bricks: [],
      unplaced: 0,
      withoutPin: { AM: 0, PM: 0, Pharmacy: 0 },
    };
  }
}
