/**
 * Phoenix CRM — one doctor on the three lines' lists (owner, 2026-11-12: "Between all the three lines …
 * if it is one place in the three or one customer, then and it is validated, make in the three lines
 * validation"; then "You will compare only in the Phoenix validated customers"; then, of the two things
 * that follows from it, "Both").
 *
 * The same doctor sits on the CNS, Anti Infective and Pedia lists of one area, one row per line. When one
 * line has validated him in Phoenix, the other lines' rows are the same person at the same door:
 *
 *   1. A WAITING ROW JOINS — a row of his still waiting on another line takes the validated line's place(s),
 *      as copies (`point_source = 'line_twin'`), and is validated from them. No photo of its own: a copy is
 *      never evidence, never a signboard, never a Place checks row.
 *   2. VALIDATED TWINS SHARE ONE POINT — where two or three lines validated him separately and their points
 *      agree (within `AGREE_METERS`), the photo and pin places move onto the best of them, so every line's
 *      visits are measured from one door. Points further apart are two clinics and are left alone.
 *
 * Pure and screen-free: the server, the ops script and the test share ONE rule. Account:
 * docs/phoenix-crm-line-twins.md.
 *
 * 🔴 THE SOURCE IS ALWAYS A PHOENIX VALIDATION — an active customer with `validated_at` and a place of his
 * own. An old-CRM contact match is never a source (the owner's own correction), and a row validated only
 * through copies is never a source, so a copy never breeds a copy.
 *
 * 🔴 ACCURATE BEFORE COMPLETE — two rows are one doctor only on the same list (AM or PM, never a pharmacy),
 * in the same area, on DIFFERENT lines, with the same name of at least three words and no known speciality
 * against it. Anything doubtful is skipped and counted, never guessed.
 */

import { AGREE_METERS, sameName, specialityFamily } from "@/lib/phoenix-crm/customer-match-groups";
import { distanceMeters } from "@/lib/phoenix-crm/geo";
import { validationNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { personNameWords } from "@/lib/phoenix-crm/signboard-rules";

export { AGREE_METERS as LINE_TWIN_AGREE_METERS };

/** A name shorter than this is never matched across lines: "محمد احمد" is far too many doctors. */
export const LINE_TWIN_MIN_NAME_WORDS = 3;
/** A customer holds at most five places; a copy never takes him past it. */
export const LINE_TWIN_MAX_PLACES = 5;
/** A place already this close to the point it would move to is left where it is. */
export const LINE_TWIN_SAME_POINT_METERS = 1;
/** The `point_source` of a copied place. */
export const LINE_TWIN_POINT_SOURCE = "line_twin";

/** The written reason every merge move carries (the database wants 10–500 characters). */
export const LINE_TWIN_MOVE_REASON =
  "The same doctor is validated on another line within 150 m — moved onto that line's point so every line measures its visits from one door.";

/** One row of one seat's list, as the comparison reads it. */
export type TwinCustomer = {
  id: string;
  seatId: string;
  /** The seat's line (cns, anti_infective, pedia). */
  lineCode: string | null;
  /** The seat's area code — the same code on all three lines. */
  areaCode: string | null;
  isTest: boolean;
  listType: string;
  name: string;
  speciality: string | null;
  status: string;
  validatedAt: string | null;
  validatedByHrId: string | null;
  /** A validation of his waits for the Super Admin. */
  pendingReview: boolean;
  /** A request to drop him waits. */
  pendingDrop: boolean;
  /** A full name waits for the Super Admin's word. */
  fullNameHeld: boolean;
};

/** One active place, as the comparison reads it. */
export type TwinPlace = {
  id: string;
  customerId: string;
  seatId: string;
  pointSource: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  capturedAt: string;
};

export type LineTwinInput = { customers: ReadonlyArray<TwinCustomer>; places: ReadonlyArray<TwinPlace> };

// ── Who is the same doctor ───────────────────────────────────────────────────────────────────────

/** The name folded and counted the signboard reader's way: each compound one word. */
export function twinNameWords(name: string): string[] {
  return personNameWords(name).map((word) => word.word);
}

function isDoctorList(listType: string): boolean {
  return listType === "AM" || listType === "PM";
}

/** Two rows on two lines' lists that are one doctor. `left`/`right` words are `twinNameWords`. */
export function areLineTwins(left: TwinCustomer, right: TwinCustomer, leftWords: ReadonlyArray<string>, rightWords: ReadonlyArray<string>): boolean {
  if (left.id === right.id || left.isTest !== right.isTest || left.seatId === right.seatId) return false;
  if (!left.lineCode || !right.lineCode || left.lineCode === right.lineCode) return false;
  if (!left.areaCode || left.areaCode !== right.areaCode) return false;
  if (left.listType !== right.listType || !isDoctorList(left.listType)) return false;
  if (Math.min(leftWords.length, rightWords.length) < LINE_TWIN_MIN_NAME_WORDS) return false;
  if (!sameName(leftWords, rightWords)) return false;
  const leftFamily = specialityFamily(left.speciality);
  const rightFamily = specialityFamily(right.speciality);
  return leftFamily === null || rightFamily === null || leftFamily === rightFamily;
}

/** A place of his own — a copy from another line never counts as one. */
export function isOwnPlace(place: Pick<TwinPlace, "pointSource">): boolean {
  return place.pointSource !== LINE_TWIN_POINT_SOURCE;
}

/** Why a waiting row cannot take another line's validation; null when it can. */
export type WaitingRefusal = "not_waiting" | "in_review" | "drop_requested" | "needs_full_name" | "full_name_held";

export function waitingRefusal(customer: TwinCustomer, activePlaces: number): WaitingRefusal | null {
  if (customer.status !== "pending" || customer.validatedAt !== null || activePlaces > 0) return "not_waiting";
  if (customer.pendingReview) return "in_review";
  if (customer.pendingDrop) return "drop_requested";
  if (customer.fullNameHeld) return "full_name_held";
  if (validationNeedsFullName({ listType: customer.listType, name: customer.name })) return "needs_full_name";
  return null;
}

/** Why a waiting row with a validated twin was left alone. */
export type LineTwinSkipReason = WaitingRefusal | "two_on_one_line" | "two_doctors" | "twice_on_this_list";

export const LINE_TWIN_SKIP_TEXT: Record<LineTwinSkipReason, string> = {
  not_waiting: "Not waiting",
  in_review: "This row's own validation waits for the Super Admin",
  drop_requested: "A request to drop this customer waits",
  full_name_held: "The full name waits for the Super Admin",
  needs_full_name: "A clinic doctor still needs all three names",
  two_on_one_line: "Two validated doctors of this name on one line",
  two_doctors: "Two different validated doctors match this name",
  twice_on_this_list: "On this list twice",
};

// ── Which point wins ─────────────────────────────────────────────────────────────────────────────

/** A point someone chose on purpose beats a reading; a photograph beats a pin. */
const ANCHOR_RANK: Record<string, number> = { moved: 0, shared_place: 1, trusted: 2, photo: 3, pin: 4 };

function anchorRank(place: TwinPlace): number {
  return ANCHOR_RANK[place.pointSource] ?? 9;
}

function agreeingCount(place: TwinPlace, among: ReadonlyArray<TwinPlace>): number {
  return among.filter((other) => distanceMeters(place, other) <= AGREE_METERS).length;
}

/** The better anchor first: chosen > photo > pin, then most agreeing, then sharpest, then earliest. */
export function compareAnchors(left: TwinPlace, right: TwinPlace, among: ReadonlyArray<TwinPlace>): number {
  const sharp = (place: TwinPlace) => (place.accuracyMeters === null ? Number.POSITIVE_INFINITY : place.accuracyMeters);
  return (
    anchorRank(left) - anchorRank(right) ||
    agreeingCount(right, among) - agreeingCount(left, among) ||
    sharp(left) - sharp(right) ||
    left.capturedAt.localeCompare(right.capturedAt) ||
    left.id.localeCompare(right.id)
  );
}

// ── The shared index ─────────────────────────────────────────────────────────────────────────────

type Indexed = {
  customers: TwinCustomer[];
  words: Map<string, string[]>;
  ownPlaces: Map<string, TwinPlace[]>;
  activePlaces: Map<string, number>;
  buckets: Map<string, TwinCustomer[]>;
};

function bucketKey(customer: TwinCustomer, words: ReadonlyArray<string>): string | null {
  if (!isDoctorList(customer.listType) || !customer.areaCode || words.length < LINE_TWIN_MIN_NAME_WORDS) return null;
  return `${customer.isTest ? "t" : "r"}|${customer.listType}|${customer.areaCode}|${words[0]} ${words[1]}`;
}

function indexInput(input: LineTwinInput): Indexed {
  const byId = new Map<string, TwinCustomer>();
  for (const customer of input.customers) if (!byId.has(customer.id)) byId.set(customer.id, customer);
  const customers = [...byId.values()];
  const known = new Set(customers.map((customer) => customer.id));
  const words = new Map(customers.map((customer) => [customer.id, twinNameWords(customer.name)]));
  const ownPlaces = new Map<string, TwinPlace[]>();
  const activePlaces = new Map<string, number>();
  const placeSeen = new Set<string>();
  for (const place of input.places) {
    if (placeSeen.has(place.id) || !known.has(place.customerId)) continue;
    placeSeen.add(place.id);
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    activePlaces.set(place.customerId, (activePlaces.get(place.customerId) ?? 0) + 1);
    if (!isOwnPlace(place)) continue;
    const held = ownPlaces.get(place.customerId);
    if (held) held.push(place);
    else ownPlaces.set(place.customerId, [place]);
  }
  const buckets = new Map<string, TwinCustomer[]>();
  for (const customer of customers) {
    const key = bucketKey(customer, words.get(customer.id) ?? []);
    if (!key) continue;
    const held = buckets.get(key);
    if (held) held.push(customer);
    else buckets.set(key, [customer]);
  }
  return { customers, words, ownPlaces, activePlaces, buckets };
}

/** A Phoenix validation another line may take: active, validated, with a place of his own. */
function isSource(index: Indexed, customer: TwinCustomer): boolean {
  return customer.status === "active" && customer.validatedAt !== null && (index.ownPlaces.get(customer.id)?.length ?? 0) > 0;
}

function twinsOf(index: Indexed, customer: TwinCustomer): TwinCustomer[] {
  const words = index.words.get(customer.id) ?? [];
  const key = bucketKey(customer, words);
  if (!key) return [];
  return (index.buckets.get(key) ?? []).filter((other) => areLineTwins(customer, other, words, index.words.get(other.id) ?? []));
}

// ── 2. Validated twins share one point ───────────────────────────────────────────────────────────

export type LineTwinMove = {
  placeId: string;
  customerId: string;
  seatId: string;
  isTest: boolean;
  fromPointSource: string;
  anchorPlaceId: string;
  anchorCustomerId: string;
  anchorSeatId: string;
  /** Whole metres from where the place sits now to the anchor. */
  distanceMeters: number;
};

/**
 * Places of validated twins that agree (within `AGREE_METERS`) move onto the best of them. Only a photo or
 * a pin moves — a point somebody chose (moved, shared place, trusted) is never overridden — and only onto a
 * DIRECT twin's anchor on another line, never along a chain.
 */
export function planLineTwinMerges(input: LineTwinInput): LineTwinMove[] {
  const index = indexInput(input);
  const customerById = new Map(index.customers.map((customer) => [customer.id, customer]));
  const moves: LineTwinMove[] = [];
  const moved = new Set<string>();
  const handled = new Set<string>();

  for (const customer of index.customers) {
    if (handled.has(customer.id) || !isSource(index, customer)) continue;
    // The component: every validated row reachable through a twin of a twin.
    const component: TwinCustomer[] = [];
    const queue = [customer];
    handled.add(customer.id);
    while (queue.length > 0) {
      const next = queue.shift() as TwinCustomer;
      component.push(next);
      for (const twin of twinsOf(index, next)) {
        if (handled.has(twin.id) || !isSource(index, twin)) continue;
        handled.add(twin.id);
        queue.push(twin);
      }
    }
    if (component.length < 2) continue;

    const places = component.flatMap((member) => index.ownPlaces.get(member.id) ?? []);
    // Points that agree, joined pairwise; each cluster is judged on its own.
    const parent = places.map((_, at) => at);
    const find = (at: number): number => (parent[at] === at ? at : (parent[at] = find(parent[at])));
    for (let a = 0; a < places.length; a += 1) {
      for (let b = a + 1; b < places.length; b += 1) {
        if (places[a].customerId !== places[b].customerId && distanceMeters(places[a], places[b]) <= AGREE_METERS) parent[find(a)] = find(b);
      }
    }
    const clusters = new Map<number, TwinPlace[]>();
    places.forEach((place, at) => {
      const root = find(at);
      const held = clusters.get(root);
      if (held) held.push(place);
      else clusters.set(root, [place]);
    });

    for (const cluster of clusters.values()) {
      if (new Set(cluster.map((place) => place.customerId)).size < 2) continue;
      const anchor = [...cluster].sort((left, right) => compareAnchors(left, right, cluster))[0];
      const anchorCustomer = customerById.get(anchor.customerId) as TwinCustomer;
      for (const place of cluster) {
        if (place.id === anchor.id || place.customerId === anchor.customerId || moved.has(place.id)) continue;
        if (place.pointSource !== "photo" && place.pointSource !== "pin") continue;
        const owner = customerById.get(place.customerId) as TwinCustomer;
        if (!areLineTwins(owner, anchorCustomer, index.words.get(owner.id) ?? [], index.words.get(anchorCustomer.id) ?? [])) continue;
        const gap = distanceMeters(place, anchor);
        if (gap <= LINE_TWIN_SAME_POINT_METERS || gap > AGREE_METERS) continue;
        moved.add(place.id);
        moves.push({
          placeId: place.id,
          customerId: place.customerId,
          seatId: place.seatId,
          isTest: owner.isTest,
          fromPointSource: place.pointSource,
          anchorPlaceId: anchor.id,
          anchorCustomerId: anchor.customerId,
          anchorSeatId: anchor.seatId,
          distanceMeters: Math.round(gap),
        });
      }
    }
  }
  return moves.sort((left, right) => left.seatId.localeCompare(right.seatId) || left.placeId.localeCompare(right.placeId));
}

// ── 1. A waiting row joins ───────────────────────────────────────────────────────────────────────

export type LineTwinShare = {
  customerId: string;
  seatId: string;
  isTest: boolean;
  lineCode: string | null;
  name: string;
  /** The validated rows it is taken from, earliest validation first. */
  sourceCustomerIds: string[];
  /** The places copied, the best point first, never two within `AGREE_METERS`, at most five. */
  sourcePlaceIds: string[];
  /** Whose validation it is: the earliest source's validator. */
  validatedByHrId: string | null;
};

export type LineTwinSkip = {
  customerId: string;
  seatId: string;
  name: string;
  reason: LineTwinSkipReason;
};

export type LineTwinSharePlan = { shares: LineTwinShare[]; skipped: LineTwinSkip[] };

export function planLineTwinShares(input: LineTwinInput): LineTwinSharePlan {
  const index = indexInput(input);
  const shares: LineTwinShare[] = [];
  const skipped: LineTwinSkip[] = [];

  // Every waiting row that has at least one validated twin, with those twins.
  const candidates: Array<{ customer: TwinCustomer; sources: TwinCustomer[] }> = [];
  for (const customer of index.customers) {
    if (customer.status !== "pending") continue;
    const sources = twinsOf(index, customer).filter((twin) => isSource(index, twin));
    if (sources.length > 0) candidates.push({ customer, sources });
  }

  // One validated doctor matched by two waiting rows on ONE seat: that seat holds him twice — nobody guesses which.
  const perSeatSource = new Map<string, number>();
  for (const { customer, sources } of candidates) {
    for (const source of sources) {
      const key = `${customer.seatId}|${source.id}`;
      perSeatSource.set(key, (perSeatSource.get(key) ?? 0) + 1);
    }
  }

  for (const { customer, sources } of candidates) {
    const base = { customerId: customer.id, seatId: customer.seatId, name: customer.name };
    const refusal = waitingRefusal(customer, index.activePlaces.get(customer.id) ?? 0);
    if (refusal) {
      if (refusal !== "not_waiting") skipped.push({ ...base, reason: refusal });
      continue;
    }
    const lines = new Map<string, number>();
    for (const source of sources) lines.set(source.lineCode ?? "", (lines.get(source.lineCode ?? "") ?? 0) + 1);
    if ([...lines.values()].some((count) => count > 1)) {
      skipped.push({ ...base, reason: "two_on_one_line" });
      continue;
    }
    // Two lines' validations taken together must be one doctor too: "احمد صبري مشعل" opens both
    // "احمد صبري مشعل حسن" and "احمد صبري مشعل علي", who are two men.
    const oneDoctor = sources.every((left, at) =>
      sources.slice(at + 1).every((right) => areLineTwins(left, right, index.words.get(left.id) ?? [], index.words.get(right.id) ?? [])),
    );
    if (!oneDoctor) {
      skipped.push({ ...base, reason: "two_doctors" });
      continue;
    }
    if (sources.some((source) => (perSeatSource.get(`${customer.seatId}|${source.id}`) ?? 0) > 1)) {
      skipped.push({ ...base, reason: "twice_on_this_list" });
      continue;
    }

    const pool = sources.flatMap((source) => index.ownPlaces.get(source.id) ?? []);
    const ordered = [...pool].sort((left, right) => compareAnchors(left, right, pool));
    const kept: TwinPlace[] = [];
    for (const place of ordered) {
      if (kept.length >= LINE_TWIN_MAX_PLACES) break;
      if (kept.some((other) => distanceMeters(place, other) <= AGREE_METERS)) continue;
      kept.push(place);
    }
    if (kept.length === 0) continue;
    const bySource = [...sources].sort((left, right) => String(left.validatedAt).localeCompare(String(right.validatedAt)) || left.id.localeCompare(right.id));
    shares.push({
      customerId: customer.id,
      seatId: customer.seatId,
      isTest: customer.isTest,
      lineCode: customer.lineCode,
      name: customer.name,
      sourceCustomerIds: bySource.map((source) => source.id),
      sourcePlaceIds: kept.map((place) => place.id),
      validatedByHrId: bySource[0].validatedByHrId,
    });
  }

  const order = (left: { seatId: string; customerId: string }, right: { seatId: string; customerId: string }) =>
    left.seatId.localeCompare(right.seatId) || left.customerId.localeCompare(right.customerId);
  return { shares: shares.sort(order), skipped: skipped.sort(order) };
}

/** Counts for the script's report and the doc. */
export function lineTwinSummary(moves: ReadonlyArray<LineTwinMove>, plan: LineTwinSharePlan): Record<string, number> {
  const summary: Record<string, number> = {
    placesMoved: moves.length,
    customersMoved: new Set(moves.map((move) => move.customerId)).size,
    rowsValidated: plan.shares.length,
    placesCopied: plan.shares.reduce((total, share) => total + share.sourcePlaceIds.length, 0),
    skipped: plan.skipped.length,
  };
  for (const skip of plan.skipped) summary[`skipped_${skip.reason}`] = (summary[`skipped_${skip.reason}`] ?? 0) + 1;
  return summary;
}
