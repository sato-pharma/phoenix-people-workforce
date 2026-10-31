/**
 * Phoenix CRM — My map's rules, with no I/O (owner, 2026-10-27: "put a pin on the map for every validated
 * customer … give a color for the AM pins and for the PM pins").
 *
 * The server reads the facts (`server/my-map.ts`); this turns them into the pins, the customers and the counts
 * the screen and the landing card draw, so the rules are tested without a database.
 *
 * 🔴 A PIN IS AN ACTIVE PLACE OF AN ACTIVE CUSTOMER, AND NOTHING ELSE. `phoenix_crm_customers_active_is_validated`
 * makes "active" and "validated" one statement, so a customer still pending is never drawn, and a place that was
 * retired is not either. A customer with two places has two pins and is ONE customer in every count.
 *
 * 🔴 THE POINT IS THE PLACE'S OWN CHOSEN POINT (`places.lat/lon`), AND NOTHING ABOUT HOW IT WAS MEASURED TRAVELS.
 * No reading, accuracy, distance or source of the point is in any shape here (Golden Rule #1): a field the
 * browser receives is a field the reader was shown. `MY_MAP_PIN_KEYS` and `MY_MAP_CUSTOMER_KEYS` are the whole
 * allow-list, and `tests/phoenix-crm-my-map.test.ts` holds the shapes to them.
 *
 * 🔴 THE LAYER IS THE SESSION THE PLACE IS SEATED IN, THEN THE CUSTOMER'S LIST. A seated customer is planned in
 * his seating's session (`plan-rules.ts`), so the map draws him where he is worked. A pharmacy is always a
 * pharmacy, whatever its place says.
 *
 * 🔴 AM, PM AND PHARMACIES ARE THREE FIGURES, NEVER ONE SUM. Every count here is kept per list, and coverage is
 * measured against each list's own grade numbers.
 *
 * 🔴 A TEST ACCOUNT'S MAP IS THE REAL TEAM'S, WITH ITS OWN TEST CUSTOMERS IN THEIR PLACE (owner's report,
 * 2026-10-27: the DM test account's card read "No validated customer"). Its test world is a stale copy of the
 * real lists with no places — 13 test customers against 267 real on that team, none pinned — so it reads both
 * worlds, the way every report does for a test account (`docs/test-accounts.md`), and `mergeTestWorld` keeps each
 * customer ONCE: a pinned test customer stands in for its real twin, a placeless copy gives way to it.
 */

import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { coverageTier, gradeTarget, type CoverageTier } from "@/lib/phoenix-crm/coverage";
import { isUsableFix } from "@/lib/phoenix-crm/geo";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

export type MyMapLayer = PhoenixCrmListType;

export const MY_MAP_LAYERS: readonly MyMapLayer[] = ["AM", "PM", "Pharmacy"];

export const MY_MAP_LAYER_LABEL: Record<MyMapLayer, string> = { AM: "AM", PM: "PM", Pharmacy: "Pharmacies" };

/** Flat colours, one per list: amber, indigo, teal. */
export const MY_MAP_LAYER_COLOUR: Record<MyMapLayer, string> = { AM: "#d97706", PM: "#3730a3", Pharmacy: "#0f766e" };

/** "Colour by this month's visits": grey not visited, amber behind its grade, green on it. */
export const MY_MAP_TIER_COLOUR: Record<CoverageTier, string> = { 0: "#94a3b8", 1: "#d97706", 2: "#15803d" };

/**
 * Names in Arabic order, the same on the server and on every phone (owner, 2026-10-31: "make all names arabic").
 *
 * A bare `localeCompare` sorts by the ENGINE'S own language. Node (en-US) puts the English-written names first
 * and orders أحمد / احمد and مستشفى / مستشفي one way; a phone set to Arabic orders them the other. The screen's
 * list is drawn on the server and again on hydrate, so one row apart is React #418 (System Audit,
 * "/employee-portals/my-map", 28 Oct 2026). 24,008 of the 25,060 customer names are written in Arabic, so these
 * rules are also the order a reader expects.
 */
const ARABIC_NAME_ORDER = new Intl.Collator("ar");

export function compareMyMapNames(left: string, right: string): number {
  return ARABIC_NAME_ORDER.compare(left, right);
}

/** What each tier says. A pharmacy has no grade number, so for it a visit is simply a visit. */
export function myMapTierLabel(tier: CoverageTier, listType: PhoenixCrmListType): string {
  if (tier === 0) return "Not visited this month";
  if (listType === "Pharmacy") return "Visited this month";
  return tier === 1 ? "Behind its grade" : "On its grade";
}

export type MyMapScope = "rep" | "district" | "manager" | "company";

export type MyMapPin = {
  /** The place. */
  id: string;
  lat: number;
  lon: number;
  layer: MyMapLayer;
  /** Index into `customers`. */
  customer: number;
  label: string | null;
  brick: string | null;
};

export type MyMapCustomer = {
  name: string;
  listType: PhoenixCrmListType;
  speciality: string | null;
  grade: PhoenixCrmGrade | null;
  /** Index into `territories`. */
  territory: number;
  /** The Cairo day he was validated. */
  validatedOn: string | null;
  /** Validated in the last seven days, today included. */
  isNew: boolean;
  visits: number;
  /** His grade's visits a month; null with no grade, and always for a pharmacy. */
  target: number | null;
  tier: CoverageTier;
  lastVisitOn: string | null;
  plannedToday: boolean;
  places: number;
};

export type MyMapTerritory = { name: string; people: string; line: string | null };

export type MyMapManager = { name: string; title: string; territories: number[] };

export type MyMapView = {
  /** A source could not be read: the screen says so in words, never as an empty map. */
  unavailable: boolean;
  scope: MyMapScope;
  visitDay: string;
  pins: MyMapPin[];
  customers: MyMapCustomer[];
  territories: MyMapTerritory[];
  managers: MyMapManager[];
  /** Whether today's approved plan was read for these territories at all. */
  planRead: boolean;
  /** Why no stop is marked today, for a rep whose own plan is not approved. */
  planNote: string | null;
  /** Planned for today but not validated yet, so without a pin. */
  plannedWithoutPin: number;
  /** Active places of active customers with no usable point — counted, never silently left out. */
  unplaced: number;
  /** Validated customers on these territories with no pin at all, by list — so an empty map never reads as nobody. */
  withoutPin: PerList;
};

/** The whole allow-list of a pin and of a customer. Nothing outside these reaches the browser. */
export const MY_MAP_PIN_KEYS = ["id", "lat", "lon", "layer", "customer", "label", "brick"] as const;
export const MY_MAP_CUSTOMER_KEYS = [
  "name",
  "listType",
  "speciality",
  "grade",
  "territory",
  "validatedOn",
  "isNew",
  "visits",
  "target",
  "tier",
  "lastVisitOn",
  "plannedToday",
  "places",
] as const;

export function readListType(value: unknown): PhoenixCrmListType {
  if (value === "AM") return "AM";
  if (value === "Pharmacy") return "Pharmacy";
  return "PM";
}

export function readGrade(value: unknown): PhoenixCrmGrade | null {
  const grade = String(value ?? "").trim().toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : null;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

/** The layer a place's pin is drawn in. */
export function mapLayerOf(listType: PhoenixCrmListType, session: unknown): MyMapLayer {
  if (listType === "Pharmacy") return "Pharmacy";
  return session === "AM" || session === "PM" ? session : listType;
}

export type MyMapSeatFact = { seatId: string; name: string; people: string; line: string | null };
export type MyMapPlaceFact = { id: string; seatId: string; customerId: string; lat: unknown; lon: unknown; session: unknown; label: unknown; brick: unknown };
export type MyMapCustomerFact = {
  id: string;
  /** The territory he is listed on. */
  seatId: string;
  listType: unknown;
  name: unknown;
  speciality: unknown;
  grade: unknown;
  validatedOn: string | null;
};
export type MyMapVisitFact = { customerId: string; visitDate: string };

/** One world's facts: the real one, or a test account's own. */
export type MyMapWorldFacts = { places: MyMapPlaceFact[]; customers: MyMapCustomerFact[]; visits: MyMapVisitFact[] };

/**
 * The same customer in the other world: his territory, his list and his name folded the way the database's own
 * duplicate guard folds it (`phoenix_crm_fold_name`'s twin). A name that folds to nothing has no twin.
 */
function twinKey(customer: MyMapCustomerFact): string | null {
  const name = normalizeContactName(typeof customer.name === "string" ? customer.name : null);
  return name.length > 0 ? `${customer.seatId}|${readListType(customer.listType)}|${name}` : null;
}

/**
 * A test account's map: the real team's customers beside its own test ones, each customer ONCE.
 *
 * - A test customer with a place of his own stands in for his real twin — the test pin is the one drawn.
 * - A test customer with no place gives way to his real twin, whose pins are drawn.
 * - A test customer with no twin is drawn as he is.
 *
 * `alias` maps the id that gave way to the id kept, so a visit, or a stop in today's plan, on either copy lands
 * on the one customer shown.
 */
export function mergeTestWorld(real: MyMapWorldFacts, test: MyMapWorldFacts): MyMapWorldFacts & { alias: Map<string, string> } {
  const placed = new Set(test.places.map((place) => place.customerId));
  const realByKey = new Map<string, MyMapCustomerFact>();
  for (const customer of real.customers) {
    const key = twinKey(customer);
    if (key !== null && !realByKey.has(key)) realByKey.set(key, customer);
  }
  const alias = new Map<string, string>();
  const dropped = new Set<string>();
  const claimed = new Set<string>();
  for (const customer of test.customers) {
    const key = twinKey(customer);
    const twin = key === null ? undefined : realByKey.get(key);
    if (!twin || claimed.has(twin.id)) continue;
    claimed.add(twin.id);
    if (placed.has(customer.id)) {
      alias.set(twin.id, customer.id);
      dropped.add(twin.id);
    } else {
      alias.set(customer.id, twin.id);
      dropped.add(customer.id);
    }
  }
  const kept = (customerId: string) => !dropped.has(customerId);
  return {
    places: [...real.places, ...test.places].filter((place) => kept(place.customerId)),
    customers: [...real.customers, ...test.customers].filter((customer) => kept(customer.id)),
    visits: [...real.visits, ...test.visits].map((visit) => ({ customerId: alias.get(visit.customerId) ?? visit.customerId, visitDate: visit.visitDate })),
    alias,
  };
}

/** Today's planned customers, each as the copy the map shows. */
export function aliasPlanned(planned: ReadonlySet<string> | null, alias: ReadonlyMap<string, string>): Set<string> | null {
  return planned ? new Set([...planned].map((customerId) => alias.get(customerId) ?? customerId)) : null;
}

function roundDegrees(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The pins, customers and territories, from the facts the server read.
 *
 * `customers` holds ACTIVE customers only, so a place whose customer is not in it — pending, dropped, or the
 * other world's — is not a pin. A place on a seat outside `seats` is not one either.
 */
export function buildMyMapPins(input: {
  seats: ReadonlyArray<MyMapSeatFact>;
  places: ReadonlyArray<MyMapPlaceFact>;
  customers: ReadonlyArray<MyMapCustomerFact>;
  visits: ReadonlyArray<MyMapVisitFact>;
  /** Today's approved plan's customers; null when the plan was not read. */
  planned: ReadonlySet<string> | null;
  /** The first Cairo day that counts as this week's: validated on it or after is new. */
  newSince: string;
  gradeTargets: PhoenixCrmSettings["gradeTargets"];
}): Pick<MyMapView, "pins" | "customers" | "territories" | "unplaced" | "plannedWithoutPin" | "withoutPin"> {
  const seatIndex = new Map(input.seats.map((seat, index) => [seat.seatId, index]));
  const facts = new Map(input.customers.map((customer) => [customer.id, customer]));

  const visitsOf = new Map<string, { count: number; last: string }>();
  for (const visit of input.visits) {
    const entry = visitsOf.get(visit.customerId);
    if (entry) {
      entry.count += 1;
      if (visit.visitDate > entry.last) entry.last = visit.visitDate;
    } else {
      visitsOf.set(visit.customerId, { count: 1, last: visit.visitDate });
    }
  }

  const usable = input.places
    .filter((place) => facts.has(place.customerId) && seatIndex.has(place.seatId))
    .sort(
      (left, right) =>
        (seatIndex.get(left.seatId) ?? 0) - (seatIndex.get(right.seatId) ?? 0) ||
        compareMyMapNames(String(facts.get(left.customerId)?.name ?? ""), String(facts.get(right.customerId)?.name ?? "")) ||
        left.id.localeCompare(right.id),
    );

  const customers: MyMapCustomer[] = [];
  const customerIndex = new Map<string, number>();
  const pins: MyMapPin[] = [];
  let unplaced = 0;
  for (const place of usable) {
    if (!isUsableFix(place.lat, place.lon)) {
      unplaced += 1;
      continue;
    }
    const fact = facts.get(place.customerId) as MyMapCustomerFact;
    let index = customerIndex.get(fact.id);
    if (index === undefined) {
      const listType = readListType(fact.listType);
      const grade = readGrade(fact.grade);
      const target = listType === "Pharmacy" ? null : gradeTarget({ gradeTargets: input.gradeTargets }, listType, grade);
      const seen = visitsOf.get(fact.id);
      const visits = seen?.count ?? 0;
      index = customers.length;
      customerIndex.set(fact.id, index);
      customers.push({
        name: textOrNull(fact.name) ?? "Customer",
        listType,
        speciality: textOrNull(fact.speciality),
        grade: listType === "Pharmacy" ? null : grade,
        territory: seatIndex.get(place.seatId) as number,
        validatedOn: fact.validatedOn,
        isNew: fact.validatedOn !== null && fact.validatedOn >= input.newSince,
        visits,
        target,
        tier: coverageTier(visits, target),
        lastVisitOn: seen?.last ?? null,
        plannedToday: input.planned?.has(fact.id) ?? false,
        places: 0,
      });
    }
    customers[index].places += 1;
    const listType = customers[index].listType;
    pins.push({
      id: place.id,
      lat: roundDegrees(Number(place.lat)),
      lon: roundDegrees(Number(place.lon)),
      layer: mapLayerOf(listType, place.session),
      customer: index,
      label: textOrNull(place.label),
      brick: textOrNull(place.brick),
    });
  }

  let plannedWithoutPin = 0;
  for (const customerId of input.planned ?? []) if (!customerIndex.has(customerId)) plannedWithoutPin += 1;

  // A validated customer of these territories whose every place is retired, or has no usable point.
  const withoutPin = perList();
  for (const fact of facts.values()) if (!customerIndex.has(fact.id) && seatIndex.has(fact.seatId)) withoutPin[readListType(fact.listType)] += 1;

  return {
    pins,
    customers,
    territories: input.seats.map((seat) => ({ name: seat.name, people: seat.people, line: seat.line })),
    unplaced,
    plannedWithoutPin,
    withoutPin,
  };
}

export type PerList = Record<MyMapLayer, number>;

export type MyMapCounts = {
  /** Pins, by the layer they are drawn in. */
  places: PerList;
  /** Customers, by their own list. */
  customers: PerList;
  newThisWeek: PerList;
  notVisited: PerList;
  /** Behind their grade — AM and PM only; a pharmacy has no grade number. */
  behind: PerList;
  onGrade: PerList;
  plannedToday: PerList;
};

function perList(): PerList {
  return { AM: 0, PM: 0, Pharmacy: 0 };
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "12 AM · 80 PM · 1 pharmacy" — the lists side by side, never added into one figure; "None" when all are 0. */
export function myMapPerListText(counts: PerList): string {
  const parts = [
    counts.AM > 0 ? `${COUNT.format(counts.AM)} AM` : null,
    counts.PM > 0 ? `${COUNT.format(counts.PM)} PM` : null,
    counts.Pharmacy > 0 ? `${COUNT.format(counts.Pharmacy)} ${counts.Pharmacy === 1 ? "pharmacy" : "pharmacies"}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "None";
}

/** The counts of the pins shown, and of the customers they belong to — each counted once, per list. */
export function countMyMap(pins: ReadonlyArray<MyMapPin>, customers: ReadonlyArray<MyMapCustomer>): MyMapCounts {
  const counts: MyMapCounts = {
    places: perList(),
    customers: perList(),
    newThisWeek: perList(),
    notVisited: perList(),
    behind: perList(),
    onGrade: perList(),
    plannedToday: perList(),
  };
  const counted = new Set<number>();
  for (const pin of pins) {
    counts.places[pin.layer] += 1;
    if (counted.has(pin.customer)) continue;
    counted.add(pin.customer);
    const customer = customers[pin.customer];
    if (!customer) continue;
    const list = customer.listType;
    counts.customers[list] += 1;
    if (customer.isNew) counts.newThisWeek[list] += 1;
    if (customer.plannedToday) counts.plannedToday[list] += 1;
    if (customer.tier === 0) counts.notVisited[list] += 1;
    else if (customer.tier === 1) counts.behind[list] += 1;
    else counts.onGrade[list] += 1;
  }
  return counts;
}

/** What the landing card draws: the counts, and an even sample of the pins with the busiest bricks named. */
export type MyMapSnapshot = {
  unavailable: boolean;
  scope: MyMapScope;
  counts: MyMapCounts;
  planRead: boolean;
  points: Array<{ lat: number; lon: number; layer: MyMapLayer }>;
  bricks: Array<{ name: string; lat: number; lon: number }>;
  unplaced: number;
  withoutPin: PerList;
};
