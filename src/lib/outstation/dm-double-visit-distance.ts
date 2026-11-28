/**
 * A District Manager's trip is priced from his home to the FIRST double visit he made on it (owner,
 * 2026-11-23: "the expense is calculated from his home location to the first location of this
 * double visit"). Nothing changes for him: he still captures at the start and at the end of the
 * trip. The distance from home to where he captured stays on the claim beside the priced one, and
 * Expense Approvals shows both.
 *
 * His four picks, 23 Nov 2026:
 *   - The visits that count: a double or a chain visit on which he is the manager (the first
 *     manager, `manager_hr_id`), saved on a trip day. The first by the time it was saved, among the
 *     ones that carry a position (a visit with none has no location to measure to).
 *   - No such visit on the trip: it stays priced on the distance he captured, and goes to Your call
 *     with "No double visit on this trip".
 *   - New claims and the claims still waiting. A decided claim never moves.
 *   - The distance shown beside it is home → the capture point: what the claim was priced on before.
 *
 * What moves: a car trip's fuel (km × 2 × the role's fuel rate) and a no-ticket trip's fixed train
 * fare (to the station nearest the visit). A train, bus or other trip pays its ticket, so only the
 * two distances are recorded. The allowance, meeting and other costs never move, and neither does
 * the eligibility the capture earned: a first double visit under the minimum distance is flagged
 * for the approver, never refused here.
 *
 * Never over a hand edit: once the system priced a claim, a later edit of its distance or travel
 * cost by someone else is left as it is (`editedSincePriced`).
 *
 * Pure. The visits, the road distance and the claim are read by `dm-double-visit-distance-server.ts`;
 * every rule here is pinned without a database (tests/dm-double-visit-distance.test.ts).
 */

import { resolveNoTicketFare, noTicketFareRecord } from "@/lib/outstation/train-fare";
import { tripKmText } from "@/lib/outstation/trip-km";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";
import type { OutstationNoTicketFare } from "@/lib/outstation/types";

/** The visit kinds on which a manager rides with a rep. A single visit is his own. */
export const DOUBLE_VISIT_KINDS: ReadonlySet<string> = new Set(["double", "chain"]);

/** The claim statuses that are still undecided — the only ones this ever writes (the shared list). */
export const WAITING_STATUSES = OUTSTATION_UNDECIDED_STATUSES;

/** One Phoenix CRM visit, as the server reads it. */
export type DoubleVisitRow = {
  capturedAt: string | null;
  id: string;
  kind: string | null;
  lat: number | null;
  lon: number | null;
  managerHrId: string | null;
  repHrId: string | null;
  visitDate: string | null;
};

export type FirstDoubleVisit = {
  capturedAt: string;
  id: string;
  kind: string;
  lat: number;
  lon: number;
  repHrId: string | null;
  visitDate: string;
};

/**
 * What the claim keeps in `distance_basis`, and what the desk reads back.
 *
 *   first_double_visit  priced to the first double visit.
 *   no_double_visit     no double visit on the trip (yet): priced on the capture.
 *   unmeasured          a first double visit, but its road distance could not be measured: priced on the capture.
 */
export type DistanceBasisKind = "first_double_visit" | "no_double_visit" | "unmeasured";

/** Why the money was left as captured although a first double visit was measured. */
export type DistanceHeld = "stops" | "fare_unavailable" | "typed_amounts";

export type DistanceBasis = {
  basis: DistanceBasisKind;
  /** Road km from home to where he captured: what the claim was priced on before this rule. */
  capturedKm: number | null;
  /** Why the money stayed as captured; null when it follows the basis. */
  held: DistanceHeld | null;
  /** The role's minimum distance for a trip when it was priced. */
  minimumKm: number | null;
  /** When the system last priced it. */
  pricedAt: string;
  /** Road km the travel is priced on now: the visit's on `first_double_visit`, else the captured. */
  pricedKm: number | null;
  /** What the system left on the claim, so a later hand edit can be told apart from its own write. */
  written: { distanceKm: number | null; travelCost: number };
  /** The first double visit; null on `no_double_visit`. */
  visit: (FirstDoubleVisit & { km: number | null; repName: string | null }) | null;
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A position, or null — nothing, half a pair and the old 0,0 marker are all "no position". */
function usable(lat: number | null, lon: number | null): { lat: number; lon: number } | null {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** True for a claim filed under the District Manager role (defined in the client-safe rules module). */
export { isDistrictManagerRole } from "@/lib/outstation/dm-expense-rules";

/** A trip claim: a meeting or another cost has no journey to price. */
export function isTripExpense(expenseType: string | null | undefined): boolean {
  const key = String(expenseType ?? "").trim().toLowerCase();
  return key !== "meeting" && key !== "other";
}

/**
 * The first double or chain visit he made as the manager between the two trip days (Cairo days,
 * inclusive), by the time it was saved; the id breaks a tie so the pick never depends on order.
 */
export function pickFirstDoubleVisit(
  rows: ReadonlyArray<DoubleVisitRow>,
  input: { end: string; managerKey: string; start: string },
): FirstDoubleVisit | null {
  const key = input.managerKey.trim().toUpperCase();
  let best: FirstDoubleVisit | null = null;
  for (const row of rows) {
    if (!DOUBLE_VISIT_KINDS.has(String(row.kind ?? "").trim().toLowerCase())) continue;
    if (String(row.managerHrId ?? "").trim().toUpperCase() !== key) continue;
    const day = String(row.visitDate ?? "").slice(0, 10);
    if (!day || day < input.start || day > input.end) continue;
    const at = String(row.capturedAt ?? "");
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    const point = usable(finite(row.lat), finite(row.lon));
    if (!point) continue;
    const candidate: FirstDoubleVisit = {
      capturedAt: at,
      id: String(row.id),
      kind: String(row.kind).trim().toLowerCase(),
      lat: point.lat,
      lon: point.lon,
      repHrId: row.repHrId ? String(row.repHrId) : null,
      visitDate: day,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const bestMs = Date.parse(best.capturedAt);
    if (atMs < bestMs || (atMs === bestMs && candidate.id < best.id)) best = candidate;
  }
  return best;
}

/** Reads a stored `distance_basis` back; anything malformed reads as none. */
export function readDistanceBasis(value: unknown): DistanceBasis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const basis = row.basis;
  if (basis !== "first_double_visit" && basis !== "no_double_visit" && basis !== "unmeasured") return null;
  const written = row.written && typeof row.written === "object" ? (row.written as Record<string, unknown>) : {};
  const visitRow = row.visit && typeof row.visit === "object" ? (row.visit as Record<string, unknown>) : null;
  const visitLat = finite(visitRow?.lat);
  const visitLon = finite(visitRow?.lon);
  const visit =
    visitRow && visitLat !== null && visitLon !== null && typeof visitRow.id === "string"
      ? {
          capturedAt: String(visitRow.capturedAt ?? ""),
          id: visitRow.id,
          kind: String(visitRow.kind ?? "double"),
          km: finite(visitRow.km),
          lat: visitLat,
          lon: visitLon,
          repHrId: typeof visitRow.repHrId === "string" ? visitRow.repHrId : null,
          repName: typeof visitRow.repName === "string" && visitRow.repName.trim() ? visitRow.repName : null,
          visitDate: String(visitRow.visitDate ?? "").slice(0, 10),
        }
      : null;
  const held = row.held === "stops" || row.held === "fare_unavailable" || row.held === "typed_amounts" ? row.held : null;
  return {
    basis,
    capturedKm: finite(row.capturedKm),
    held,
    minimumKm: finite(row.minimumKm),
    pricedAt: String(row.pricedAt ?? ""),
    pricedKm: finite(row.pricedKm),
    visit,
    written: { distanceKm: finite(written.distanceKm), travelCost: finite(written.travelCost) ?? 0 },
  };
}

/** The claim as the planner reads it — the stored columns, already parsed. */
export type DistanceClaim = {
  claimedTotal: number;
  /** `distance_from_residence_km` as it stands. */
  distanceKm: number | null;
  existing: DistanceBasis | null;
  expectedTotal: number;
  fuelAmount: number;
  hasStops: boolean;
  home: { lat: number; lon: number } | null;
  minimumKm: number | null;
  noTicketFare: OutstationNoTicketFare | null;
  /** `report_travel_cost`, or fuel + ticket when it was never set. */
  travelCost: number;
  ticketAmount: number;
  transport: string;
};

/** The columns a write sets. Money is in EGP, rounded to the piastre like the submit path. */
export type DistanceWrite = {
  claimed_total_amount: number;
  distance_basis: DistanceBasis;
  distance_from_residence_km?: number;
  distance_km?: number;
  expected_total_amount: number;
  fuel_amount?: number;
  go_ticket_amount?: number;
  no_ticket_fare?: OutstationNoTicketFare;
  report_travel_cost: number;
  return_ticket_amount?: number;
  ticket_amount?: number;
};

export type DistancePlan =
  | { action: "skip"; reason: "edited_since_priced" | "unchanged" }
  | { action: "write"; moneyMoved: boolean; travelAfter: number; travelBefore: number; write: DistanceWrite };

/**
 * True when someone else changed the claim's distance or travel cost after the system priced it —
 * an approver's or HR's edit, which this never prices over.
 */
export function editedSincePriced(claim: Pick<DistanceClaim, "distanceKm" | "existing" | "travelCost">): boolean {
  const written = claim.existing?.written;
  if (!written) return false;
  const kmMoved =
    written.distanceKm === null ? claim.distanceKm !== null : claim.distanceKm === null || Math.abs(claim.distanceKm - written.distanceKm) > 0.01;
  return kmMoved || Math.abs(claim.travelCost - written.travelCost) > 0.01;
}

/**
 * What the claim is priced on, and the columns to write. `visitKm` is the road distance from home
 * to the first double visit — null when no route could be measured.
 */
export function planDistanceReprice(input: {
  claim: DistanceClaim;
  fuelRatePerKm: number;
  now: string;
  repName: string | null;
  visit: FirstDoubleVisit | null;
  visitKm: number | null;
}): DistancePlan {
  const { claim } = input;
  if (editedSincePriced(claim)) return { action: "skip", reason: "edited_since_priced" };

  // Home → capture point, kept from the first pricing: a car claim's own distance is the visit's after it.
  const capturedKm = claim.existing ? claim.existing.capturedKm : claim.distanceKm;
  const transport = claim.transport.trim().toLowerCase();
  const visitKm = input.visitKm === null ? null : round2(input.visitKm);
  const basisKind: DistanceBasisKind = !input.visit ? "no_double_visit" : visitKm === null ? "unmeasured" : "first_double_visit";

  // The travel the claim would carry: on the visit when there is one to price on, else as captured.
  let travelAfter = claim.travelCost;
  let held: DistanceHeld | null = null;
  const money: Partial<DistanceWrite> = {};
  let distanceAfter: number | null = claim.distanceKm;

  // Typed amounts: the stored travel or claim is not the system's own sum, so a re-price would
  // overwrite a figure somebody chose. Never seen on a waiting District Manager claim (23 Nov 2026).
  const systemTravel = Math.abs(claim.travelCost - round2(claim.fuelAmount + claim.ticketAmount)) <= 0.01;
  const systemClaim = Math.abs(claim.claimedTotal - claim.expectedTotal) <= 0.01;

  if (basisKind === "first_double_visit" && input.visit && visitKm !== null) {
    if (claim.hasStops) {
      held = "stops";
    } else if (!systemTravel || !systemClaim) {
      held = "typed_amounts";
    } else if (transport === "car") {
      const fuel = round2(visitKm * 2 * input.fuelRatePerKm);
      money.fuel_amount = fuel;
      travelAfter = round2(fuel + claim.ticketAmount);
      distanceAfter = visitKm;
      money.distance_from_residence_km = visitKm;
      money.distance_km = visitKm;
    } else if (transport === "no_ticket") {
      const fare = resolveNoTicketFare({
        destination: { latitude: input.visit.lat, longitude: input.visit.lon },
        home: claim.home ? { latitude: claim.home.lat, longitude: claim.home.lon } : null,
      });
      if (fare.status !== "priced") {
        held = "fare_unavailable";
      } else {
        const record = noTicketFareRecord(fare);
        money.no_ticket_fare = record;
        money.go_ticket_amount = record.oneWayFare;
        money.return_ticket_amount = record.oneWayFare;
        money.ticket_amount = round2(record.totalFare);
        travelAfter = round2(claim.fuelAmount + record.totalFare);
      }
    }
  }

  // No double visit, or it could not be measured: back to the capture, if an earlier run had moved it.
  if (basisKind !== "first_double_visit" && claim.existing?.basis === "first_double_visit" && claim.existing.held === null) {
    if (transport === "car" && capturedKm !== null) {
      const fuel = round2(capturedKm * 2 * input.fuelRatePerKm);
      money.fuel_amount = fuel;
      travelAfter = round2(fuel + claim.ticketAmount);
      distanceAfter = capturedKm;
      money.distance_from_residence_km = capturedKm;
      money.distance_km = capturedKm;
    }
    // A no-ticket fare moved to the visit cannot be rebuilt from the capture here; it stays, and the
    // desk says why it is his call. Never seen: a saved visit is not deleted from Phoenix CRM.
  }

  const travelBefore = claim.travelCost;
  const delta = round2(travelAfter - travelBefore);
  const expectedAfter = round2(claim.expectedTotal + delta);
  const claimedAfter = systemClaim ? expectedAfter : claim.claimedTotal;

  const basis: DistanceBasis = {
    basis: basisKind,
    capturedKm,
    held,
    minimumKm: claim.minimumKm,
    pricedAt: input.now,
    pricedKm: basisKind === "first_double_visit" ? visitKm : capturedKm,
    visit: input.visit ? { ...input.visit, km: visitKm, repName: input.repName } : null,
    written: { distanceKm: distanceAfter, travelCost: travelAfter },
  };

  // Nothing new to say: the same visit, the same figures. The time of the run is not news.
  const same =
    claim.existing &&
    claim.existing.basis === basis.basis &&
    claim.existing.held === basis.held &&
    (claim.existing.visit?.id ?? null) === (basis.visit?.id ?? null) &&
    (claim.existing.visit?.km ?? null) === (basis.visit?.km ?? null) &&
    claim.existing.pricedKm === basis.pricedKm &&
    Math.abs(delta) <= 0.01;
  if (same) return { action: "skip", reason: "unchanged" };

  return {
    action: "write",
    moneyMoved: Math.abs(delta) > 0.01,
    travelAfter,
    travelBefore,
    write: {
      ...money,
      claimed_total_amount: claimedAfter,
      distance_basis: basis,
      expected_total_amount: expectedAfter,
      report_travel_cost: travelAfter,
    },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""}`.trim() : "a trip day";
}

// Whole km, except a distance under the minimum that rounding would carry up to it (`trip-km.ts`).
const kmText = (km: number | null, minimumKm: number | null = null) => tripKmText(km, minimumKm);

/** "with Ahmed Ali on 18 Nov" — names only, never a code. */
export function distanceVisitWords(visit: NonNullable<DistanceBasis["visit"]>): string {
  return visitWords(visit);
}

function visitWords(visit: NonNullable<DistanceBasis["visit"]>): string {
  return `${visit.repName ? `with ${visit.repName} ` : ""}on ${shortDay(visit.visitDate)}`;
}

/**
 * The desk's one sentence on a District Manager trip's distance, and whether it passed. Null when
 * the rule never saw the claim (decided before it, or not a trip).
 */
export function distanceBasisVerdict(input: {
  basis: DistanceBasis | null;
  waiting: boolean;
}): { answer: "pass" | "fail" | "unknown"; sentence: string } | null {
  const { basis } = input;
  if (!basis) {
    return input.waiting
      ? { answer: "unknown", sentence: "Not priced on the first double visit yet; the next morning run prices it." }
      : null;
  }
  const captured = kmText(basis.capturedKm, basis.minimumKm);
  if (basis.basis === "no_double_visit") {
    return { answer: "unknown", sentence: `No double visit on this trip. Priced on the ${captured} from home to the capture point.` };
  }
  const visit = basis.visit;
  if (basis.basis === "unmeasured" || !visit) {
    return {
      answer: "unknown",
      sentence: `The road distance to the first double visit${visit ? ` (${visitWords(visit)})` : ""} could not be measured, so it stays priced on the ${captured} from home to the capture point.`,
    };
  }
  const toVisit = kmText(visit.km, basis.minimumKm);
  if (basis.held === "stops") {
    return { answer: "unknown", sentence: `This trip has added stops, so it stays priced on its captured route: ${captured} captured, ${toVisit} to the first double visit.` };
  }
  if (basis.held === "fare_unavailable") {
    return { answer: "unknown", sentence: `No train fare reaches the first double visit (${visitWords(visit)}), so the fare stays as captured.` };
  }
  if (basis.held === "typed_amounts") {
    return { answer: "unknown", sentence: `The travel cost was typed, not priced, so it was not moved to the ${toVisit} to the first double visit.` };
  }
  if (basis.minimumKm !== null && visit.km !== null && visit.km < basis.minimumKm) {
    return {
      answer: "fail",
      sentence: `The first double visit (${visitWords(visit)}) is ${toVisit} from home, under the ${kmText(basis.minimumKm)} minimum for a trip.`,
    };
  }
  return { answer: "pass", sentence: `Priced on the ${toVisit} from home to the first double visit, ${visitWords(visit)}; the capture point is ${captured} from home.` };
}
