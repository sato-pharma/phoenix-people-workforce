/**
 * Phoenix CRM — who sits where, and who may see, review or join what, with no I/O.
 *
 * The organogram (au_v_org_tree) is the authority: one row per seat with its path from the CEO down
 * to the seat itself. A territory is a REP seat.
 *
 *   - Scope runs downward only (owner rule): a manager reads the territories under the manager seats
 *     they hold, never a sibling's and never their own manager's.
 *   - The reviewer of a territory (grade and drop requests, weekly plans) is the nearest occupied
 *     manager seat above it. A vacant district passes to the regional or national manager above.
 *     Two exceptions, both grounded 2026-09-16: a seat held by the territory's own rep is skipped
 *     (an acting district manager also holds a rep seat under their own acting seat, and never reviews
 *     their own territory), and the CEO is never a reviewer (the CEO is not a district).
 *   - A visit's people come from the same chain: a double visit is the rep with a manager of the
 *     territory, a chain visit adds anyone else of that chain or of the line's product side.
 */

import { hrIdForStorage } from "@/lib/hr-id";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type OrgSeat = {
  seatId: string;
  parentSeatId: string | null;
  tier: string;
  /** Seat ids from the CEO down to this seat, the seat itself last. */
  path: string[];
  /** Upper case, as stored; null for a vacant seat. */
  occupantHrId: string | null;
  lineCode: string | null;
  lineName: string | null;
  /**
   * The area's code — the key `au.monthly_targets` and the closing are stored under (the daily
   * forecast reads a territory's targets by it). OPTIONAL so every seat a test builds by hand keeps
   * compiling; the organogram read in server/org.ts always fills it.
   */
  areaCode?: string | null;
  areaName: string | null;
  /**
   * The region's code, shared by every line (CA Cairo, GZ Giza, AB Alex-BHR …) — the Training Manager
   * picks a region first (2026-10-24). OPTIONAL so every seat a test builds by hand keeps compiling;
   * the organogram read in server/org.ts always fills it.
   */
  regionCode?: string | null;
  regionName: string | null;
  seatLabel: string | null;
  /**
   * The per-line sales-only "Others" bucket (`au.seats.is_other_pseudo_dm`) — it holds no reps and
   * is NOT a team, so anything counting teams or rep seats must drop it. OPTIONAL so every seat a
   * test builds by hand keeps compiling; the organogram read in server/org.ts always fills it.
   */
  isOtherPseudoDm?: boolean | null;
  /**
   * EVERY person on the seat, upper case, in organogram order — `buildOrgIndex` fills it. The view
   * returns one row per occupant, so a handover seat (the rep serving notice and the new hire) has two;
   * `occupantHrId` stays the one the row-per-seat readers have always used (the LAST row). OPTIONAL so
   * every seat a test builds by hand keeps compiling — read it through `seatOccupants`.
   */
  occupants?: string[];
};

export type OrgIndex = {
  seats: ReadonlyMap<string, OrgSeat>;
  seatsByOccupant: ReadonlyMap<string, OrgSeat[]>;
  /** One entry per territory SEAT, however many people sit on it — read `occupants` for the people. */
  territories: OrgSeat[];
  /**
   * One entry per occupied territory seat × PERSON: a handover seat appears twice, once per occupant,
   * each carrying that person as `occupantHrId`. Anything that counts or scores PEOPLE reads this, never
   * `territories` — which would see only one of the two.
   */
  territoryHolders: OrgSeat[];
};

export const TERRITORY_TIER = "REP";
const MANAGER_TIERS = new Set(["DM", "ACTING_DM", "RSM", "NSM"]);

export function isManagerTier(tier: string): boolean {
  return MANAGER_TIERS.has(tier);
}

export function personKey(hrId: string | null | undefined): string | null {
  const key = hrIdForStorage(String(hrId ?? "").trim() || null);
  return key ? key.toUpperCase() : null;
}

/** Everyone on a seat — `occupants` when the index built it, else the one occupant, else nobody. */
export function seatOccupants(seat: OrgSeat): string[] {
  if (seat.occupants) return seat.occupants;
  return seat.occupantHrId ? [seat.occupantHrId] : [];
}

/**
 * One entry per PERSON on a territory seat: the seat itself when it has one occupant or none, a copy per
 * occupant (each carrying that person as `occupantHrId`) when a handover has put two on it. For a caller
 * that walks `territories` but counts or lists people.
 */
export function seatPeople(seat: OrgSeat): OrgSeat[] {
  const occupants = seatOccupants(seat);
  if (occupants.length <= 1) return [seat];
  return occupants.map((occupantHrId) => ({ ...seat, occupantHrId }));
}

export function buildOrgIndex(seats: ReadonlyArray<OrgSeat>): OrgIndex {
  // au_v_org_tree has ONE ROW PER OCCUPANT: a handover seat arrives as two rows with the same seat id.
  // Collapsing them on the seat id kept only the last, and the other person vanished from every
  // territory read (2026-10-26: Hana Abdelaziz, serving notice, behind Aya Mamdouh on one Pedia seat).
  const occupantsOf = new Map<string, string[]>();
  for (const seat of seats) {
    const person = personKey(seat.occupantHrId);
    if (!person) continue;
    const list = occupantsOf.get(seat.seatId) ?? [];
    if (!list.includes(person)) list.push(person);
    occupantsOf.set(seat.seatId, list);
  }
  const byId = new Map<string, OrgSeat>();
  const byOccupant = new Map<string, OrgSeat[]>();
  const holders = new Map<string, OrgSeat>();
  for (const seat of seats) {
    const occupants = occupantsOf.get(seat.seatId) ?? [];
    const normalized: OrgSeat = { ...seat, occupantHrId: personKey(seat.occupantHrId), occupants };
    byId.set(normalized.seatId, normalized);
    if (normalized.occupantHrId) {
      const held = byOccupant.get(normalized.occupantHrId) ?? [];
      if (!held.some((existing) => existing.seatId === normalized.seatId)) held.push(normalized);
      byOccupant.set(normalized.occupantHrId, held);
      if (normalized.tier === TERRITORY_TIER) holders.set(`${normalized.seatId}|${normalized.occupantHrId}`, normalized);
    }
  }
  const territories = [...byId.values()]
    .filter((seat) => seat.tier === TERRITORY_TIER)
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
  const territoryHolders = [...holders.values()].sort(
    (left, right) => left.seatId.localeCompare(right.seatId) || (left.occupantHrId ?? "").localeCompare(right.occupantHrId ?? ""),
  );
  return { seats: byId, seatsByOccupant: byOccupant, territories, territoryHolders };
}

/** The territories (REP seats) a person holds. */
export function ownTerritories(index: OrgIndex, hrId: string | null | undefined): OrgSeat[] {
  const key = personKey(hrId);
  if (!key) return [];
  return (index.seatsByOccupant.get(key) ?? []).filter((seat) => seat.tier === TERRITORY_TIER);
}

/** The manager seats (district, acting district, regional, national) a person holds. */
export function heldManagerSeats(index: OrgIndex, hrId: string | null | undefined): OrgSeat[] {
  const key = personKey(hrId);
  if (!key) return [];
  return (index.seatsByOccupant.get(key) ?? []).filter((seat) => isManagerTier(seat.tier));
}

/** Territories under any of the given seats (never the seats themselves, never above them). */
export function territoriesBelow(index: OrgIndex, seatIds: ReadonlyArray<string>): OrgSeat[] {
  if (seatIds.length === 0) return [];
  const roots = new Set(seatIds);
  return index.territories.filter((seat) => seat.path.some((ancestor) => ancestor !== seat.seatId && roots.has(ancestor)));
}

export type ScopeBasis = "all" | "tree";

/**
 * The territories a person reads. "all" is the company view (Super Admin, CEO, SFE Manager); "tree" is
 * everyone else: their own territories and the ones under the manager seats they hold.
 */
export function territoriesInScope(index: OrgIndex, hrId: string | null | undefined, basis: ScopeBasis): OrgSeat[] {
  if (basis === "all") return index.territories;
  const seen = new Map<string, OrgSeat>();
  for (const seat of ownTerritories(index, hrId)) seen.set(seat.seatId, seat);
  const managed = heldManagerSeats(index, hrId).map((seat) => seat.seatId);
  for (const seat of territoriesBelow(index, managed)) seen.set(seat.seatId, seat);
  return [...seen.values()].sort((left, right) => left.seatId.localeCompare(right.seatId));
}

export type ChainMember = { hrId: string; seat: OrgSeat; position: number };

/**
 * The occupied manager seats above a territory, nearest first. Skips seats held by the territory's own
 * rep and never reaches the CEO. A person on two seats of the chain appears once, at the nearest.
 */
export function managerChain(index: OrgIndex, territorySeatId: string): ChainMember[] {
  const territory = index.seats.get(territorySeatId);
  if (!territory) return [];
  const chain: ChainMember[] = [];
  const seen = new Set<string>();
  const ancestors = territory.path.filter((seatId) => seatId !== territory.seatId).reverse();
  for (const ancestorId of ancestors) {
    const seat = index.seats.get(ancestorId);
    if (!seat || !isManagerTier(seat.tier) || !seat.occupantHrId) continue;
    if (seatOccupants(territory).includes(seat.occupantHrId)) continue;
    if (seen.has(seat.occupantHrId)) continue;
    seen.add(seat.occupantHrId);
    chain.push({ hrId: seat.occupantHrId, seat, position: chain.length });
  }
  return chain;
}

/** Who decides a territory's requests and approves its plans. Null when the whole chain is vacant. */
export function territoryReviewer(index: OrgIndex, territorySeatId: string): ChainMember | null {
  return managerChain(index, territorySeatId)[0] ?? null;
}

export function isTerritoryReviewer(index: OrgIndex, territorySeatId: string, hrId: string | null | undefined): boolean {
  const key = personKey(hrId);
  return Boolean(key && territoryReviewer(index, territorySeatId)?.hrId === key);
}

/**
 * The managers a person's manager report covers: themself when they hold a manager seat, and every
 * manager under their seats. "all" lists every manager of the company, never the CEO. Never upward: a
 * manager above one of the person's own seats stays out even when they also sit on a seat below it.
 */
export function managersInScope(index: OrgIndex, hrId: string | null | undefined, basis: ScopeBasis): ChainMember[] {
  const managerSeats = [...index.seats.values()].filter((seat) => isManagerTier(seat.tier) && seat.occupantHrId);
  let chosen: OrgSeat[];
  if (basis === "all") {
    chosen = managerSeats;
  } else {
    const held = heldManagerSeats(index, hrId);
    const roots = new Set(held.map((seat) => seat.seatId));
    const above = new Set(held.flatMap((seat) => managerChain(index, seat.seatId).map((member) => member.hrId)));
    chosen = managerSeats.filter(
      (seat) =>
        !above.has(seat.occupantHrId as string) &&
        (roots.has(seat.seatId) || seat.path.some((ancestor) => ancestor !== seat.seatId && roots.has(ancestor))),
    );
  }
  const seen = new Set<string>();
  const members: ChainMember[] = [];
  for (const seat of chosen.sort((left, right) => left.path.length - right.path.length || left.seatId.localeCompare(right.seatId))) {
    const person = seat.occupantHrId as string;
    if (seen.has(person)) continue;
    seen.add(person);
    members.push({ hrId: person, seat, position: members.length });
  }
  return members;
}

/**
 * The territories under one of the viewer's managers — the reports' "Manager" filter (owner, 2026-10-20: "when
 * filter by manager u find no manager"). The line and territory filters could only ever reach a rep; this one
 * reaches every manager the viewer reads, by the seats that manager holds.
 *
 * Null when the person is NOT one of the viewer's managers (`managersInScope`), so a filter is never wider than
 * its viewer and never reaches upward. The answer can still name territories outside the viewer's scope when the
 * manager also sits somewhere else — the caller always narrows its own territories with it, never the reverse.
 */
export function territoriesUnderManager(
  index: OrgIndex,
  viewerHrId: string | null | undefined,
  basis: ScopeBasis,
  managerHrId: string | null | undefined,
): Set<string> | null {
  const key = personKey(managerHrId);
  if (!key || !managersInScope(index, viewerHrId, basis).some((member) => member.hrId === key)) return null;
  const held = heldManagerSeats(index, key).map((seat) => seat.seatId);
  return new Set(territoriesBelow(index, held).map((seat) => seat.seatId));
}

/** The most people one visit carries besides the rep — `phoenix_crm_set_visit_companions` refuses more. */
export const MOST_ON_A_VISIT = 12;

/** One person on a visit besides the rep: the management line, or the product side (product, group product, training). */
export type ParticipantCompanion = { hrId: string; side: "manager" | "product" };

export type VisitParticipants = {
  repHrId: string | null;
  managerHrId: string | null;
  seniorHrId: string | null;
  /** The first product-side person who came along: on a `product_manager` visit, or on a `chain`. On no other kind. */
  productManagerHrId: string | null;
  /**
   * EVERYONE besides the rep (owner, 2026-10-27: "Everything is applicable") — the fixed places above
   * and everyone past them, managers nearest first, then the product side. What the save writes to
   * `phoenix_crm_visit_companions`. Empty on a single visit and on a manager's own visit.
   */
  companions: ParticipantCompanion[];
};

export const COMPANIONS_UNREADABLE = "Choose who was on the visit. Reload the page.";
export const CHAIN_NEEDS_TWO = "A chain visit has the manager and at least one more person. Choose who else was on the visit.";
export const DOUBLE_HAS_ONE = "A double visit has one person with the rep. Choose Chain visit for more.";
export const CHOOSE_PRODUCT_SIDE = "Choose the product manager who was on the visit from your line's product managers.";
export const CHOOSE_SENIOR_ABOVE = "Choose the manager who was on the visit: a manager above the one you chose.";

/** The companions as the form sent them, each person once; null when one cannot be read. */
function readCompanions(raw: ReadonlyArray<{ hrId: string; side: string }> | undefined): ParticipantCompanion[] | null {
  const out: ParticipantCompanion[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    const key = personKey(entry?.hrId ?? null);
    if (!key || (entry.side !== "manager" && entry.side !== "product")) return null;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hrId: key, side: entry.side });
  }
  return out.length > MOST_ON_A_VISIT ? null : out;
}

export type ParticipantResult = { ok: true; value: VisitParticipants } | { ok: false; error: string };

/**
 * The people on a visit, checked against the territory's chain.
 *
 * `enteredAs` is "rep" when the person entering is the territory's rep (or the Super Admin trying the
 * module in test mode, who plays the rep), and "manager" when a manager of the territory enters it. A
 * manager's own entry puts them in the manager place whatever the phone sent.
 */
export function resolveVisitParticipants(input: {
  index: OrgIndex;
  territorySeatId: string;
  actorHrId: string;
  enteredAs: "rep" | "manager";
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  productManagerHrId?: string | null;
  /**
   * The product managers of the territory's LINE, resolved by the caller
   * (visit-ask-rules.ts `productManagersOfLine`, the same list the rep's ask offers).
   *
   * 🔴 IT HAS TO BE PASSED IN: a product manager holds NO SEAT in the organogram, so `index` — which is
   * the organogram — cannot answer who he is, and there is no chain to check him against. An empty
   * list therefore refuses the kind rather than letting any hr id through.
   */
  productManagers?: ReadonlyArray<{ hrId: string }>;
  /**
   * Everyone else who came (visit-company.ts `companyToStorage`), each with their side. The fixed places
   * above may be in it or not; every person is checked here exactly as the fixed places are.
   */
  companions?: ReadonlyArray<{ hrId: string; side: string }>;
}): ParticipantResult {
  const territory = input.index.seats.get(input.territorySeatId);
  if (!territory) return { ok: false, error: "This territory is no longer in the organogram. Reload the page." };
  const actor = personKey(input.actorHrId);
  if (!actor) return { ok: false, error: "Your HR record could not be read. Sign in again." };
  const chain = managerChain(input.index, input.territorySeatId);
  const member = (hrId: string | null) => {
    const key = personKey(hrId);
    return key ? chain.find((entry) => entry.hrId === key) ?? null : null;
  };

  const extras = readCompanions(input.companions);
  if (!extras) return { ok: false, error: COMPANIONS_UNREADABLE };
  const extraProduct = extras.filter((entry) => entry.side === "product").map((entry) => entry.hrId);
  const extraManagers = extras.filter((entry) => entry.side === "manager").map((entry) => entry.hrId);
  /** One of the line's product side — a product manager holds no seat, so only the caller's own list can say. */
  const productOffered = (key: string | null) => key !== null && (input.productManagers ?? []).some((entry) => personKey(entry.hrId) === key);
  /** The product side who came: the fixed place first, then the rest, each once. */
  const productSide = [...new Set([personKey(input.productManagerHrId ?? null), ...extraProduct].filter((key): key is string => key !== null))];

  let rep: string | null;
  let manager: ChainMember | null;
  if (input.enteredAs === "rep") {
    rep = actor;
    if (input.kind === "single") return { ok: true, value: { repHrId: rep, managerHrId: null, seniorHrId: null, productManagerHrId: null, companions: [] } };
    if (input.kind === "product_manager") {
      // The product side alone, however many came (2026-10-27) — a manager among them makes it a chain.
      const picked = personKey(input.productManagerHrId ?? null);
      if (!picked || extraManagers.length > 0 || productSide.some((key) => !productOffered(key) || key === rep)) {
        return { ok: false, error: CHOOSE_PRODUCT_SIDE };
      }
      return {
        ok: true,
        value: { repHrId: rep, managerHrId: null, seniorHrId: null, productManagerHrId: picked, companions: productSide.map((hrId) => ({ hrId, side: "product" as const })) },
      };
    }
    manager = member(input.managerHrId);
    if (!manager || manager.hrId === rep) {
      return { ok: false, error: "Choose the manager who was on the visit from your territory's managers." };
    }
  } else {
    manager = chain.find((entry) => entry.hrId === actor) ?? null;
    if (!manager) return { ok: false, error: "You are not a manager of this territory." };
    if (input.kind === "single") return { ok: true, value: { repHrId: null, managerHrId: actor, seniorHrId: null, productManagerHrId: null, companions: [] } };
    // A visit with a product manager is the REP's — he is the one the product manager went out with,
    // and a manager entering it would record a visit nobody present entered.
    if (input.kind === "product_manager") {
      return { ok: false, error: "A visit with a product manager is entered by the territory's rep." };
    }
    rep = territory.occupantHrId;
    if (!rep || rep === actor) {
      return { ok: false, error: "This territory has no rep, so the visit can only be entered as your own single visit." };
    }
  }

  const nearest = manager;
  if (input.kind === "double") {
    // A stale product-manager pick in his fixed place is dropped, as it always was; a second person in
    // the list is a form that meant Chain, and is refused rather than trimmed.
    if (extraProduct.length > 0 || extraManagers.some((key) => key !== nearest.hrId)) return { ok: false, error: DOUBLE_HAS_ONE };
    return { ok: true, value: { repHrId: rep, managerHrId: manager.hrId, seniorHrId: null, productManagerHrId: null, companions: [{ hrId: manager.hrId, side: "manager" }] } };
  }

  // A chain is the rep, a manager and AT LEAST one more (owner, 2026-10-27: "Everything is applicable")
  // — the managers above him, the line's product side, or both; never a product-side person entered by
  // a manager (that visit is the rep's). A product-side person holds no seat, so, exactly as on a
  // `product_manager` visit, only the caller's own list of the line's can say he is one of them.
  if (productSide.length > 0) {
    if (input.enteredAs !== "rep") return { ok: false, error: "A visit with a product manager is entered by the territory's rep." };
    if (productSide.some((key) => !productOffered(key) || key === rep)) return { ok: false, error: CHOOSE_PRODUCT_SIDE };
  }
  // Every other manager who came is one of the territory's chain, never the rep and never twice.
  const others: ChainMember[] = [];
  for (const key of extraManagers) {
    if (key === nearest.hrId) continue;
    const found = member(key);
    if (!found || found.hrId === rep) return { ok: false, error: "Choose the manager who was on the visit from your territory's managers." };
    others.push(found);
  }
  // The senior place: the one sent, or else the nearest other manager who came. It sits ABOVE the manager.
  const sentSenior = personKey(input.seniorHrId);
  const senior = sentSenior !== null ? member(sentSenior) : ([...others].sort((left, right) => left.position - right.position)[0] ?? null);
  if (sentSenior !== null || senior !== null) {
    if (!senior || senior.position <= nearest.position || senior.hrId === rep) return { ok: false, error: CHOOSE_SENIOR_ABOVE };
  }
  const managers = [nearest, ...(senior ? [senior] : []), ...others.filter((entry) => entry.hrId !== senior?.hrId).sort((left, right) => left.position - right.position)];
  const companions: ParticipantCompanion[] = [
    ...managers.map((entry) => ({ hrId: entry.hrId, side: "manager" as const })),
    ...productSide.map((hrId) => ({ hrId, side: "product" as const })),
  ];
  if (companions.length < 2) return { ok: false, error: senior === null && sentSenior === null && productSide.length === 0 ? CHOOSE_SENIOR_ABOVE : CHAIN_NEEDS_TWO };
  if (companions.length > MOST_ON_A_VISIT) return { ok: false, error: COMPANIONS_UNREADABLE };
  return {
    ok: true,
    value: { repHrId: rep, managerHrId: nearest.hrId, seniorHrId: senior?.hrId ?? null, productManagerHrId: productSide[0] ?? null, companions },
  };
}

/** "Alex East · Anti Infective" — how a territory is named on screen (never its seat code). */
export function territoryName(seat: Pick<OrgSeat, "areaName" | "regionName" | "lineName" | "seatLabel" | "seatId">): string {
  const place = seat.areaName ?? seat.regionName ?? seat.seatLabel ?? "Territory";
  return seat.lineName ? `${place} · ${seat.lineName}` : place;
}
