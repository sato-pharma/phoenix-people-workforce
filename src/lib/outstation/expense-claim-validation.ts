/**
 * Assembles the evidence for one outstation claim and hands it to the pure evaluators.
 *
 * Owner request (2026-08-08). This module does the I/O — CRM reads, brick resolution, territory
 * lookup — and nothing else: every judgement lives in expense-fraud-checks.ts, which is pure and
 * assertable without a database.
 *
 * NEVER THROWS. A CRM outage, a missing seat, a schema drift — all of it resolves to
 * `{ available: false, reason }`. This panel is advisory; it must not be capable of breaking the
 * approval screen that real payroll decisions are made on.
 */

import { getTripVisitPartnersByDate } from "@/lib/crm/visit-partners";
import { getRepTripVisitWorkload, type RepCheckinDetail } from "@/lib/crm/visit-workload";
import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { systemAccessContext } from "@/lib/auth/permissions";
import { getManagerAreaRepOptions } from "@/lib/outstation/area-rep-options";
import {
  evaluateOutstationClaim,
  type ClaimPartner,
  type FraudCheckInput,
  type OutstationClaimValidation,
} from "@/lib/outstation/expense-fraud-checks";
import { getOutstationRequestById } from "@/lib/outstation/service";
import { logError } from "@/lib/observability/log";

export type OutstationClaimValidationResult =
  | ({ available: true; employeeName: string; tripDay: string } & OutstationClaimValidation)
  | { available: false; reason: string };

/**
 * The earliest check-in of the trip's first day, across every route the workload read produced.
 *
 * `getRepTripVisitWorkload` already sorts a day's check-ins ascending and stamps `via` with the
 * rep's name when the route is borrowed — which is the normal case here, because a manager does
 * not check in himself. Taking [0] is therefore "the first thing that happened that day", which
 * is exactly the anchor the owner asked to compare against.
 */
function firstCheckinOfDay(
  days: readonly { checkins: RepCheckinDetail[]; date: string }[],
  tripDay: string,
): RepCheckinDetail | null {
  const day = days.find((entry) => entry.date === tripDay);
  const withCoordinates = (day?.checkins ?? []).filter(
    (checkin) => typeof checkin.lat === "number" && typeof checkin.lon === "number",
  );
  return withCoordinates[0] ?? day?.checkins?.[0] ?? null;
}

/**
 * Which reps corroborate this day.
 *
 * Primary: the CRM visit rows that name this manager as the double-visitor. `hops: 1` is passed
 * EXPLICITLY — a District Manager is a 0-hop seat in the workload roll-up, and at 0 hops
 * getTripVisitPartnersByDate returns nothing at all. That default is the roll-up's concern, not
 * this one's.
 *
 * Fallback: the borrowed check-in already carries its owner's NAME in `via`. When the pair query
 * comes back empty because the rep's employees.crm_id is null, that name still identifies him,
 * so the day is not written off as uncorroborated. Costs no extra round trip — the workload read
 * has already happened.
 */
async function resolvePartners(input: {
  checkins: readonly RepCheckinDetail[];
  submitterHrId: string;
  tripDay: string;
}): Promise<ClaimPartner[]> {
  const partners = new Map<string, ClaimPartner>();

  try {
    const byPerson = await getTripVisitPartnersByDate({
      hops: 1,
      rootHrIds: [input.submitterHrId],
      tripEndDate: input.tripDay,
      tripStartDate: input.tripDay,
    });
    const key = Object.keys(byPerson).find(
      (hrId) => canonicalHrIdKey(hrId) === canonicalHrIdKey(input.submitterHrId),
    );
    const hrIds = key ? (byPerson[key]?.[input.tripDay] ?? []) : [];
    if (hrIds.length > 0) {
      const directory = await getEmployeeDirectory();
      for (const hrId of hrIds) {
        const match = directory.employees.find(
          (row) => canonicalHrIdKey(row.hrId) === canonicalHrIdKey(hrId),
        );
        partners.set(canonicalHrIdKey(hrId) ?? hrId, {
          hrId,
          name: match?.fullName ?? hrId,
          source: "visit_partner",
        });
      }
    }
  } catch (error) {
    logError("Outstation claim validation: partner lookup failed (non-blocking)", {
      error,
      labels: { event: "outstation_claim_partner_lookup_failed", hrId: input.submitterHrId },
    });
  }

  if (partners.size === 0) {
    for (const checkin of input.checkins) {
      const via = String(checkin.via ?? "").trim();
      if (!via) continue;
      partners.set(via.toLowerCase(), { hrId: null, name: via, source: "checkin_via" });
    }
  }

  return [...partners.values()];
}

/**
 * Every area code covered by the reps the manager was with.
 *
 * getManagerAreaRepOptions walks the seat tree beneath a manager, so it is called with the
 * SUBMITTER's identity rather than the reviewer's — the CEO reading this panel has no seat over
 * these reps and would resolve nothing. Filtered to the partner reps: the question is whether the
 * captured point falls in the territory of the rep actually visited, not anywhere in the
 * manager's whole span.
 *
 * Empty result means UNKNOWN, and the pure check treats it as unverifiable — never as "outside".
 */
async function resolveRepAreaCodes(input: {
  partners: readonly ClaimPartner[];
  submitterHrId: string;
}): Promise<string[]> {
  const partnerKeys = new Set(
    input.partners
      .map((partner) => canonicalHrIdKey(partner.hrId))
      .filter((key): key is string => Boolean(key)),
  );
  if (partnerKeys.size === 0) return [];

  try {
    const options = await getManagerAreaRepOptions({
      ...systemAccessContext,
      hrId: input.submitterHrId,
    });
    const codes = options
      .filter((option) => partnerKeys.has(canonicalHrIdKey(option.repHrId) ?? ""))
      .map((option) => String(option.areaCode ?? "").trim())
      .filter(Boolean);
    return [...new Set(codes)];
  } catch (error) {
    logError("Outstation claim validation: rep territory lookup failed (non-blocking)", {
      error,
      labels: { event: "outstation_claim_territory_lookup_failed", hrId: input.submitterHrId },
    });
    return [];
  }
}

export async function getOutstationClaimValidation(
  requestId: number,
): Promise<OutstationClaimValidationResult> {
  try {
    const request = await getOutstationRequestById(requestId);
    if (!request) return { available: false, reason: "That outstation request is not available." };

    const tripDay = String(request.tripStartDate ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tripDay)) {
      return { available: false, reason: "This request has no usable trip date." };
    }

    // One read covers both the check-ins and their times. Scoped to the trip's FIRST day, not the
    // whole span: the owner's question is about the day the expense was captured.
    const workload = await getRepTripVisitWorkload({
      hrId: request.employeeHrId,
      tripEndDate: tripDay,
      tripStartDate: tripDay,
    });
    const day = workload.dateBreakdown.find((entry) => entry.date === tripDay) ?? null;
    const firstCheckin = firstCheckinOfDay(workload.dateBreakdown, tripDay);

    const partners = await resolvePartners({
      checkins: day?.checkins ?? [],
      submitterHrId: request.employeeHrId,
      tripDay,
    });
    const repAreaCodes = await resolveRepAreaCodes({
      partners,
      submitterHrId: request.employeeHrId,
    });

    // Brick resolution is local maths over a cached centroid index — no round trip on a warm cache.
    let capturedBrick: FraudCheckInput["capturedBrick"] = null;
    try {
      const centroids = await loadBrickCentroids();
      const resolved = resolveBrickForPoint(
        request.capturedLatitude,
        request.capturedLongitude,
        centroids,
      );
      if (resolved) {
        capturedBrick = {
          areaCode: resolved.areaCode,
          brickName: resolved.brickName,
          distanceKm: resolved.distanceKm,
        };
      }
    } catch (error) {
      logError("Outstation claim validation: brick resolution failed (non-blocking)", {
        error,
        labels: { event: "outstation_claim_brick_failed", requestId: String(requestId) },
      });
    }

    // The only vendor field with a real clock. `visit_date_time` is a midnight placeholder on
    // ~100% of rows and must never anchor a time comparison.
    // A recorded meeting is listed among the day's rows but is never a visit (trip-day-meetings.ts).
    const firstVisitSavedAt = (day?.visits ?? [])
      .filter((visit) => visit.kind !== "meeting")
      .map((visit) => visit.submittedAt ?? null)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;

    const validation = evaluateOutstationClaim({
      capturedBrick,
      capturedLatitude: request.capturedLatitude,
      capturedLongitude: request.capturedLongitude,
      firstCheckin,
      firstVisitSavedAt,
      partners,
      repAreaCodes,
      submittedAt: request.submittedAt ?? request.capturedAt ?? null,
      tripDay,
    });

    return {
      available: true,
      employeeName: request.employeeName,
      tripDay,
      ...validation,
    };
  } catch (error) {
    logError("Outstation claim validation failed (non-blocking)", {
      error,
      labels: { event: "outstation_claim_validation_failed", requestId: String(requestId) },
    });
    return {
      available: false,
      reason: "The validation could not be built for this request.",
    };
  }
}
