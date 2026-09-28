import { googleDirectionsRoute, isGoogleMapsServerKeyConfigured } from "@/lib/google-maps/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  isUnresolvedResidenceCoordinate,
  mapsNotConfiguredFailure,
  noDrivingRouteFailure,
  unresolvedResidenceFailure,
  type DistanceFailure,
} from "@/lib/outstation/distance-failure";
import { isOutstationExpenseInPayroll } from "@/lib/outstation/expense-gate";
import {
  getLinkedOutstationPayrollExpense,
  getOutstationRequestById,
  getResidenceLocationForEmployee,
} from "@/lib/outstation/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Fill in a missing travel distance WITHOUT touching a single amount.
 *
 * Why this exists as its own path rather than a flag on the admin edit. `updateManagerExpenseAsAdmin`
 * recomputes the whole money picture from the distance it is given — `fuelAmount` is
 * `distanceKm * 2 * policy.fuelRatePerKm`, and ticket, travel cost, allowance and eligibility all
 * re-derive from there. That is correct for an ADMIN EDITING a claim and wrong for filling in a
 * measurement that was never taken: the owner's rule is that the system flags an expense and never
 * decides one, so recovering a lost number must not move the money attached to it.
 *
 * What went missing. `nullableNumber` in service.ts read a NULL residence coordinate as 0 until
 * 2026-09-28 (`Number(null)` is 0), so the submit-time "residence is missing" guard never fired and
 * the route lookup ran from (0, 0) — the Gulf of Guinea, which Google refuses outright. Nine claims
 * were frozen that way; eight of them (AI-0013, EGP 5,277) still carry `distance_km IS NULL` and
 * render as "Route lookup failed", so an approver has no number to judge them by. The source is
 * fixed; those rows are not, and the only control that would recompute them is the amount modal.
 *
 * The destination is the CAPTURED coordinate, not a place lookup. None of the stranded rows carries
 * a `to_place_id`, and every one carries a browser GPS fix accurate to 10-21 m — where the traveller
 * actually stood is better evidence of where the trip went than a re-geocoded label would be, and it
 * costs no Places call.
 *
 * 🔴 The no-amounts guarantee is ENFORCED, not promised. `buildDistanceOnlyPayload` is pure and
 * `assertNoMoneyColumns` throws before the write if the payload ever grows a forbidden key, so a
 * later edit that adds one fails loudly in production instead of quietly repricing a claim.
 * Pinned by tests/outstation-distance-backfill.test.ts.
 */

/** Columns this path may write. Anything else is a bug, including a second distance-ish field. */
export const DISTANCE_ONLY_COLUMNS = [
  "distance_km",
  "distance_from_residence_km",
  "duration_minutes",
  "route_polyline",
  "route_error",
  "updated_at",
] as const;

/**
 * Every column that carries money, or that prices one. `eligibility_*` and `approval_*` are in here
 * deliberately: they are not currency, but they are the verdict an approver acts on, and a backfill
 * that silently upgraded "needs review" to "eligible" would be the system deciding a claim.
 */
export const MONEY_COLUMNS = [
  "allowance_amount",
  "allowance_breakdown_json",
  "approval_reason",
  "approval_recommendation",
  "claimed_total_amount",
  "eligibility_reason",
  "eligibility_status",
  "expected_total_amount",
  "fuel_amount",
  "go_ticket_amount",
  "meeting_amount",
  "other_amount",
  "overnight_days",
  "report_meeting_amount",
  "report_other_amount",
  "report_travel_cost",
  "return_ticket_amount",
  "same_day_trip",
  "status",
  "ticket_amount",
] as const;

export type DistanceOnlyPayload = {
  distance_from_residence_km: number;
  distance_km: number;
  duration_minutes: number | null;
  route_error: null;
  route_polyline: string | null;
  updated_at: string;
};

export type DistanceBackfillOutcome =
  | { ok: true; distanceKm: number; durationMinutes: number | null; requestId: number }
  | { ok: false; failure: DistanceFailure; requestId: number };

function minutesFromSeconds(value: number | null | undefined) {
  return value != null ? Number((value / 60).toFixed(1)) : null;
}

/** Pure: the exact row patch, so a test can read it without a database or a Google key. */
export function buildDistanceOnlyPayload(params: {
  distanceMeters: number;
  durationInTrafficSeconds?: number | null;
  durationSeconds?: number | null;
  now: string;
  polyline?: string | null;
}): DistanceOnlyPayload {
  const distanceKm = Number((params.distanceMeters / 1000).toFixed(2));
  return {
    // Both columns hold the same measurement and always have; writing one and not the other is how
    // a row ends up rendering a distance on one surface and "Route lookup failed" on another.
    distance_from_residence_km: distanceKm,
    distance_km: distanceKm,
    duration_minutes:
      minutesFromSeconds(params.durationInTrafficSeconds) ?? minutesFromSeconds(params.durationSeconds),
    // The lookup just succeeded, so a stale failure note must not survive it.
    route_error: null,
    route_polyline: params.polyline ?? null,
    updated_at: params.now,
  };
}

/** Throws rather than writing, if the patch ever reaches beyond distance. */
export function assertNoMoneyColumns(payload: Record<string, unknown>) {
  const forbidden = Object.keys(payload).filter((key) =>
    (MONEY_COLUMNS as readonly string[]).includes(key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Distance backfill tried to write ${forbidden.join(", ")}. This path fills a measurement and `
        + "must never reprice a claim — put the change in updateManagerExpenseAsAdmin instead.",
    );
  }
  const unexpected = Object.keys(payload).filter(
    (key) => !(DISTANCE_ONLY_COLUMNS as readonly string[]).includes(key),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Distance backfill tried to write ${unexpected.join(", ")}, which is not a distance column.`,
    );
  }
}

/**
 * Recompute one request's residence -> destination distance and store ONLY that.
 *
 * Refuses, rather than guessing, when: the request is gone, it is already in a payroll run, it has
 * no captured coordinate to measure to, the employee's residence is still unresolved, Maps is not
 * configured, or Google has no driving route. A refusal returns the same `DistanceFailure` shape the
 * live calculator uses, so an admin reads one vocabulary across both.
 */
export async function recalculateOutstationDistanceOnly(
  requestId: number,
  access: AccessContext,
): Promise<DistanceBackfillOutcome> {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");

  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error(
      "This outstation expense is already in a payroll run. Its distance is left as it was paid.",
    );
  }

  if (!isGoogleMapsServerKeyConfigured()) {
    return { failure: mapsNotConfiguredFailure(), ok: false, requestId };
  }

  const destinationLat = existing.capturedLatitude;
  const destinationLng = existing.capturedLongitude;
  if (
    destinationLat == null
    || destinationLng == null
    || !Number.isFinite(destinationLat)
    || !Number.isFinite(destinationLng)
  ) {
    return {
      failure: {
        error: "route_not_found",
        message:
          "This request has no captured location, so there is nothing to measure the distance to. "
          + "Type the distance on the request instead.",
        status: 422,
      },
      ok: false,
      requestId,
    };
  }

  // The LIVE residence, never the copy frozen on the row — the frozen copy is exactly what is
  // wrong on these requests, and the employee's real coordinate has since been set.
  const residence = await getResidenceLocationForEmployee(existing.employeeHrId);
  if (
    !residence
    || residence.residenceLatitude == null
    || residence.residenceLongitude == null
    || isUnresolvedResidenceCoordinate(residence.residenceLatitude, residence.residenceLongitude)
  ) {
    return {
      failure: unresolvedResidenceFailure(
        existing.employeeHrId,
        residence?.residenceLatitude != null && residence?.residenceLongitude != null
          ? { latitude: residence.residenceLatitude, longitude: residence.residenceLongitude }
          : { latitude: 0, longitude: 0 },
      ),
      ok: false,
      requestId,
    };
  }

  const directions = await googleDirectionsRoute(
    { lat: residence.residenceLatitude, lng: residence.residenceLongitude },
    { lat: destinationLat, lng: destinationLng },
  );

  if (directions.distanceMeters == null) {
    return {
      failure: noDrivingRouteFailure({
        destinationIsRegion: false,
        destinationLabel: existing.toLabel ?? existing.toArea ?? null,
        destinationLat,
        destinationLng,
      }),
      ok: false,
      requestId,
    };
  }

  const payload = buildDistanceOnlyPayload({
    distanceMeters: directions.distanceMeters,
    durationInTrafficSeconds: directions.durationInTrafficSeconds,
    durationSeconds: directions.durationSeconds,
    now: new Date().toISOString(),
    polyline: directions.polyline,
  });
  assertNoMoneyColumns(payload);

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update(payload)
    // Pinning the status means a claim that was approved or paid while this ran is not written to.
    .eq("id", requestId)
    .eq("status", existing.status)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Outstation request state changed. Refresh and retry.");

  return {
    distanceKm: payload.distance_km,
    durationMinutes: payload.duration_minutes,
    ok: true,
    requestId,
  };
}
