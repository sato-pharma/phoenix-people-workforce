import assert from "node:assert/strict";

import {
  buildTileRouteMapModel,
  decodePolyline,
  outstationRouteCoordinatesReady,
  routesForMap,
  selectedRouteForMap,
} from "../src/lib/outstation/route-preview.ts";
import type { OutstationExpenseRequest } from "../src/lib/outstation/types.ts";

const encodedRoute = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

function baseRequest(): OutstationExpenseRequest {
  return {
    allowanceAmount: 300,
    allowanceBreakdown: null,
    attachmentCount: 0,
    approvalReason: "Manager review.",
    approvalRecommendation: "manager_review",
    capturedAccuracyMeters: 8,
    capturedAt: "2026-05-22T10:00:00.000Z",
    capturedLatitude: 43.252,
    capturedLongitude: -126.453,
    carEvidenceImagePath: null,
    carEvidenceImageUrl: null,
    carEvidenceMetadata: null,
    claimedTotalAmount: 0,
    createdAt: "2026-05-22T10:00:00.000Z",
    distanceFromResidenceKm: 238.14,
    durationMinutes: 162,
    eligibilityReason: "Needs review.",
    eligibilityStatus: "needs_review",
    employeeArea: null,
    employeeHrId: "DEV-NSM-001",
    employeeLine: null,
    employeeName: "Dev User",
    employeeRole: "National Sales Manager",
    expectedTotalAmount: 300,
    expenseType: "traveling",
    fraudFlags: [],
    fuelAmount: 0,
    goTicketAmount: 0,
    id: 1,
    kilometerReading: null,
    medicalTripHrId: null,
    medicalTripName: null,
    minimumRequiredDistanceKm: 60,
    notes: null,
    offlineCaptured: false,
    overnightDays: 0,
    residenceAddress: null,
    residenceArea: null,
    residenceCity: null,
    residenceLatitude: 38.5,
    residenceLongitude: -120.2,
    returnTicketAmount: 0,
    routeAlternatives: [
      {
        distanceKm: 260,
        durationInTrafficMinutes: 190,
        durationMinutes: 180,
        encodedPolyline: null,
        index: 0,
        isSelected: false,
        summary: "Missing preview line",
      },
      {
        distanceKm: 238.14,
        durationInTrafficMinutes: 162,
        durationMinutes: 170,
        encodedPolyline: encodedRoute,
        index: 1,
        isSelected: true,
        summary: "Fastest route",
      },
    ],
    routeError: null,
    routePolyline: encodedRoute,
    sameDayTrip: true,
    selectedRouteIndex: 1,
    selectedRouteReason: "fastest_duration",
    status: "calculated",
    submittedAt: "2026-05-22T10:00:00.000Z",
    suspiciousLocationScore: 0,
    territoryValidationReason: "Not available.",
    territoryValidationStatus: "not_available",
    ticketAmount: 0,
    ticketAttachmentMetadata: [],
    ticketAttachmentPaths: [],
    toArea: null,
    toCity: null,
    toCountry: null,
    toLabel: "Captured destination",
    transportationType: "car",
    tripEndDate: "2026-05-22",
    tripStartDate: "2026-05-22",
    updatedAt: "2026-05-22T10:00:00.000Z",
    varianceAmount: 0,
    variancePercent: 0,
  };
}

function assertModelFits(model: ReturnType<typeof buildTileRouteMapModel>) {
  assert.ok(model.tiles.length > 0, "route preview should include map tiles");
  assert.match(model.path, /^M /);
  assert.ok(model.path.includes(" L "), "route preview should draw a route path");

  for (const point of [...model.pathPoints, model.residence, model.destination]) {
    assert.ok(point.x >= 0 && point.x <= model.width, `x coordinate ${point.x} should fit`);
    assert.ok(point.y >= 0 && point.y <= model.height, `y coordinate ${point.y} should fit`);
  }
}

export function runOutstationRoutePreviewTests() {
  const request = baseRequest();
  const decoded = decodePolyline(encodedRoute);
  assert.deepEqual(decoded[0], { lat: 38.5, lng: -120.2 });
  assert.deepEqual(decoded.at(-1), { lat: 43.252, lng: -126.453 });

  assert.equal(outstationRouteCoordinatesReady(request), true);
  assert.equal(outstationRouteCoordinatesReady({ ...request, residenceLatitude: null }), false);
  assert.equal(routesForMap(request).length, 1, "routes without encoded lines must be ignored");
  assert.equal(selectedRouteForMap(request)?.index, 1);

  const desktopModel = buildTileRouteMapModel(request, selectedRouteForMap(request), {
    height: 420,
    width: 900,
  });
  assert.equal(desktopModel.width, 900);
  assert.equal(desktopModel.height, 420);
  assertModelFits(desktopModel);

  const compactModel = buildTileRouteMapModel(request, selectedRouteForMap(request), {
    height: 300,
    width: 360,
  });
  assert.equal(compactModel.width, 360);
  assert.equal(compactModel.height, 300);
  assertModelFits(compactModel);
}
