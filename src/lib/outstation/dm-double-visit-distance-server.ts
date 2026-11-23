/**
 * Prices a waiting District Manager claim from his home to the first double visit of the trip —
 * the reads and the one guarded write behind `dm-double-visit-distance.ts` (owner, 2026-11-23).
 *
 * Runs in three places, all through `priceClaimOnFirstDoubleVisit`:
 *   - right after he submits (service.ts), so the claim lands already priced when the visit is in;
 *   - every morning for every waiting District Manager claim (the 07:02 Cairo departure-photo job),
 *     because a rep often saves the double visit after the manager filed the claim;
 *   - `scripts/price-dm-claims-on-double-visit.ts`, once, for the claims already waiting.
 *
 * 🔴 It writes ONLY a claim that is still waiting (`submitted`, `needs_review`) and that no payroll
 *    row carries, and only while the claim is the version it read (`updated_at`): an approver who
 *    has it open is told it moved and reads it again. A decided claim never moves.
 *
 * A road distance is measured once per visit: a later run that finds the same first visit from the
 * same home reuses the kilometres it stored, so the morning job costs no route call for a claim
 * whose visit did not change.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { googleDirectionsRoute } from "@/lib/google-maps/server";
import { logError } from "@/lib/observability/log";
import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import {
  type DistanceBasis,
  type DistanceClaim,
  type DistancePlan,
  type DoubleVisitRow,
  type FirstDoubleVisit,
  isDistrictManagerRole,
  isTripExpense,
  pickFirstDoubleVisit,
  planDistanceReprice,
  readDistanceBasis,
  WAITING_STATUSES,
} from "@/lib/outstation/dm-double-visit-distance";
import { getActivePolicyForRole } from "@/lib/outstation/service";
import { readNoTicketFare } from "@/lib/outstation/train-fare";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { personKey } from "@/lib/phoenix-crm/scope";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const CLAIM_COLUMNS = [
  "id", "status", "updated_at", "employee_hr_id", "employee_role", "expense_type", "transportation_type",
  "trip_start_date", "trip_end_date", "residence_latitude", "residence_longitude",
  "distance_from_residence_km", "minimum_required_distance_km", "fuel_amount", "ticket_amount", "report_travel_cost",
  "expected_total_amount", "claimed_total_amount", "no_ticket_fare", "journey_stops", "distance_basis",
].join(", ");

export type DoubleVisitPriceOutcome =
  | { requestId: number; result: "not_applicable" | "not_waiting" | "on_payroll" | "edited_since_priced" | "unchanged" | "changed_meanwhile" }
  | {
      basis: DistanceBasis;
      claimedAfter: number;
      claimedBefore: number;
      moneyMoved: boolean;
      requestId: number;
      /** `would_write` = a report-only run (`write: false`): what it would set, nothing written. */
      result: "written" | "would_write";
      travelAfter: number;
      travelBefore: number;
    };

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

const money = (value: unknown) => num(value) ?? 0;

function homeOf(row: Row): { lat: number; lon: number } | null {
  const lat = num(row.residence_latitude);
  const lon = num(row.residence_longitude);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** The stored claim as the pure planner reads it. */
export function distanceClaimOfRow(row: Row): DistanceClaim {
  const fuelAmount = money(row.fuel_amount);
  const ticketAmount = money(row.ticket_amount);
  const travel = num(row.report_travel_cost);
  return {
    claimedTotal: money(row.claimed_total_amount),
    distanceKm: num(row.distance_from_residence_km),
    existing: readDistanceBasis(row.distance_basis),
    expectedTotal: money(row.expected_total_amount),
    fuelAmount,
    hasStops: Array.isArray(row.journey_stops) && row.journey_stops.length > 0,
    home: homeOf(row),
    minimumKm: num(row.minimum_required_distance_km),
    noTicketFare: readNoTicketFare(row.no_ticket_fare),
    ticketAmount,
    transport: String(row.transportation_type ?? ""),
    travelCost: travel ?? Math.round((fuelAmount + ticketAmount) * 100) / 100,
  };
}

/** Every double or chain visit he saved as the manager between the two Cairo days. */
async function readManagerDoubleVisits(managerHrId: string, start: string, end: string): Promise<DoubleVisitRow[]> {
  const rows = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, kind, manager_hr_id, rep_hr_id, captured_at, visit_date, lat, lon")
        .eq("is_test", false)
        .is("imported_from_ireports360_at", null)
        .is("archived_at", null)
        .in("kind", ["double", "chain"])
        .eq("manager_hr_id", managerHrId)
        .gte("visit_date", start)
        .lte("visit_date", end),
    "id",
  );
  return rows.map((row) => ({
    capturedAt: row.captured_at ? String(row.captured_at) : null,
    id: String(row.id),
    kind: row.kind ? String(row.kind) : null,
    lat: num(row.lat),
    lon: num(row.lon),
    managerHrId: row.manager_hr_id ? String(row.manager_hr_id) : null,
    repHrId: row.rep_hr_id ? String(row.rep_hr_id) : null,
    visitDate: row.visit_date ? String(row.visit_date) : null,
  }));
}

/** Road km from home to the visit — reused from the stored basis when it is the same visit from the same home. */
async function roadKmToVisit(input: {
  existing: DistanceBasis | null;
  home: { lat: number; lon: number } | null;
  requestId: number;
  visit: FirstDoubleVisit;
}): Promise<number | null> {
  const stored = input.existing?.visit;
  if (stored && stored.id === input.visit.id && stored.km !== null) return stored.km;
  if (!input.home) return null;
  try {
    const route = await googleDirectionsRoute(
      { lat: input.home.lat, lng: input.home.lon },
      { lat: input.visit.lat, lng: input.visit.lon },
    );
    return route.distanceMeters == null ? null : Math.round((route.distanceMeters / 1000) * 100) / 100;
  } catch (error) {
    logError("The road distance to a first double visit could not be measured", {
      error,
      labels: { event: "outstation_dm_double_visit_route_failed", requestId: String(input.requestId) },
    });
    return null;
  }
}

async function onAPayrollRow(requestId: number): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expenses")
    .select("id")
    .eq("trip_id", `OUTSTATION-${requestId}`)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * Prices one claim on its first double visit, when the rule applies to it. Never throws for a claim
 * it leaves alone; a failed read or write throws, and the caller logs it.
 */
export async function priceClaimOnFirstDoubleVisit(
  requestId: number,
  options: { now?: Date; write?: boolean } = {},
): Promise<DoubleVisitPriceOutcome> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select(CLAIM_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data ?? null) as Row | null;
  if (!row || !isDistrictManagerRole(String(row.employee_role ?? "")) || !isTripExpense(String(row.expense_type ?? ""))) {
    return { requestId, result: "not_applicable" };
  }
  if (!(WAITING_STATUSES as ReadonlyArray<string>).includes(String(row.status ?? ""))) return { requestId, result: "not_waiting" };
  if (await onAPayrollRow(requestId)) return { requestId, result: "on_payroll" };

  const manager = personKey(String(row.employee_hr_id ?? ""));
  const start = cairoDateOnly(String(row.trip_start_date ?? "") || null);
  const end = cairoDateOnly(String(row.trip_end_date ?? "") || null) ?? start;
  if (!manager || !start || !end) return { requestId, result: "not_applicable" };

  const claim = distanceClaimOfRow(row);
  const visit = pickFirstDoubleVisit(await readManagerDoubleVisits(manager, start, end), { end, managerKey: manager, start });
  const visitKm = visit ? await roadKmToVisit({ existing: claim.existing, home: claim.home, requestId, visit }) : null;
  const repName = visit?.repHrId ? nameOf(await loadPeopleNames([visit.repHrId]), visit.repHrId, "") || null : null;

  const plan: DistancePlan = planDistanceReprice({
    claim,
    fuelRatePerKm: (await getActivePolicyForRole(String(row.employee_role ?? "District Manager"))).fuelRatePerKm,
    now: (options.now ?? new Date()).toISOString(),
    repName,
    visit,
    visitKm,
  });
  if (plan.action === "skip") return { requestId, result: plan.reason };
  const outcome = {
    basis: plan.write.distance_basis,
    claimedAfter: plan.write.claimed_total_amount,
    claimedBefore: claim.claimedTotal,
    moneyMoved: plan.moneyMoved,
    requestId,
    travelAfter: plan.travelAfter,
    travelBefore: plan.travelBefore,
  };
  if (options.write === false) return { ...outcome, result: "would_write" };

  const stamp = (options.now ?? new Date()).toISOString();
  const { data: written, error: writeError } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({ ...plan.write, updated_at: stamp })
    .eq("id", requestId)
    .in("status", [...WAITING_STATUSES])
    .eq("updated_at", String(row.updated_at))
    .select("id")
    .maybeSingle();
  if (writeError) throw new Error(writeError.message);
  if (!written) return { requestId, result: "changed_meanwhile" };

  await writeRequiredAuditLog({
    actorLoginId: "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: {
      basis: plan.write.distance_basis.basis,
      capturedKm: plan.write.distance_basis.capturedKm,
      claimedTotal: plan.write.claimed_total_amount,
      pricedKm: plan.write.distance_basis.pricedKm,
      source: "dm_first_double_visit_pricing",
      travelCost: plan.travelAfter,
      visitId: plan.write.distance_basis.visit?.id ?? null,
    },
    oldValues: {
      basis: claim.existing?.basis ?? null,
      claimedTotal: claim.claimedTotal,
      distanceKm: claim.distanceKm,
      travelCost: plan.travelBefore,
    },
    summary: `District Manager claim ${requestId} priced on ${plan.write.distance_basis.basis.replace(/_/g, " ")}.`,
  });

  return { ...outcome, result: "written" };
}

/** The ids of every waiting District Manager trip claim, oldest first. */
export async function waitingDistrictManagerClaimIds(): Promise<number[]> {
  const rows = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from("outstation_expense_requests")
        .select("id, employee_role, expense_type")
        .in("status", [...WAITING_STATUSES])
        .ilike("employee_role", "district manager"),
    "id",
  );
  return rows
    .filter((row) => isDistrictManagerRole(String(row.employee_role ?? "")) && isTripExpense(String(row.expense_type ?? "")))
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((left, right) => left - right);
}

export type DoubleVisitRunSummary = {
  failed: number;
  moneyMoved: number;
  read: number;
  written: number;
};

/** The morning run: every waiting District Manager claim, one at a time; one failure never stops the rest. */
export async function priceWaitingDistrictManagerClaims(options: { now?: Date } = {}): Promise<DoubleVisitRunSummary> {
  const ids = await waitingDistrictManagerClaimIds();
  const summary: DoubleVisitRunSummary = { failed: 0, moneyMoved: 0, read: ids.length, written: 0 };
  for (const id of ids) {
    try {
      const outcome = await priceClaimOnFirstDoubleVisit(id, options);
      if (outcome.result === "written") {
        summary.written += 1;
        if (outcome.moneyMoved) summary.moneyMoved += 1;
      }
    } catch (error) {
      summary.failed += 1;
      logError("A District Manager claim could not be priced on its first double visit", {
        error,
        labels: { event: "outstation_dm_double_visit_price_failed", requestId: String(id) },
      });
    }
  }
  return summary;
}
