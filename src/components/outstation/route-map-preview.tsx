"use client";

import { OutstationReviewMap } from "@/components/outstation/outstation-review-map";
import type { OutstationCalculationResult, OutstationExpenseRequest } from "@/lib/outstation/types";

export function RouteMapPreview({
  request,
}: {
  request: OutstationCalculationResult | OutstationExpenseRequest | null;
}) {
  if (!request) {
    return <OutstationReviewMap request={null} />;
  }

  const mapRequest: OutstationExpenseRequest = "id" in request
    ? request
    : {
        allowanceAmount: request.allowanceAmount,
        allowanceBreakdown: request.allowanceBreakdown,
        attachmentCount: request.attachmentCount,
        approvalReason: request.approvalReason,
        approvalRecommendation: request.approvalRecommendation,
        capturedAccuracyMeters: request.capturedAccuracyMeters,
        capturedAt: request.capturedAt,
        capturedLatitude: request.capturedLatitude,
        capturedLongitude: request.capturedLongitude,
        claimedTotalAmount: request.claimedTotalAmount,
        createdAt: request.submittedAt,
        distanceFromResidenceKm: request.distanceFromResidenceKm,
        durationMinutes: request.durationMinutes,
        expenseType: request.expenseType,
        eligibilityReason: request.eligibilityReason,
        eligibilityStatus: request.eligibilityStatus,
        employeeArea: request.employeeArea,
        employeeHrId: request.employeeHrId,
        employeeLine: request.employeeLine,
        employeeName: request.employeeName,
        employeeRole: request.employeeRole,
        expectedTotalAmount: request.expectedTotalAmount,
        fraudFlags: request.fraudFlags,
        fuelAmount: request.fuelAmount,
        id: 0,
        kilometerReading: request.kilometerReading,
        medicalTripHrId: request.medicalTripHrId,
        medicalTripName: request.medicalTripName,
        minimumRequiredDistanceKm: request.minimumRequiredDistanceKm,
        notes: request.notes,
        offlineCaptured: request.offlineCaptured,
        overnightDays: request.overnightDays,
        residenceAddress: null,
        residenceArea: null,
        residenceCity: null,
        residenceLatitude: request.residenceLatitude,
        residenceLongitude: request.residenceLongitude,
        routePolyline: request.routePolyline,
        routeError: request.routeError,
        sameDayTrip: request.sameDayTrip,
        status: request.calculationStatus,
        submittedAt: request.submittedAt,
        suspiciousLocationScore: request.suspiciousLocationScore,
        territoryValidationReason: request.territoryValidationReason,
        territoryValidationStatus: request.territoryValidationStatus,
        ticketAmount: request.ticketAmount,
        toArea: request.toArea,
        toCity: request.toCity,
        toLabel: request.toLabel,
        transportationType: request.transportationType,
        tripEndDate: request.tripEndDate,
        tripStartDate: request.tripStartDate,
        updatedAt: request.submittedAt,
        varianceAmount: request.varianceAmount,
        variancePercent: request.variancePercent,
      };

  return <OutstationReviewMap request={mapRequest} />;
}
