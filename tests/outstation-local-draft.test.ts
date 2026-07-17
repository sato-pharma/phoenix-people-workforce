import assert from "node:assert/strict";

import {
  isRestorableOutstationLocalDraft,
  parseOutstationLocalDraft,
  type OutstationLocalDraft,
} from "../src/lib/outstation/local-draft.ts";
import type { OutstationCaptureResult } from "../src/lib/outstation/types.ts";

const captured: OutstationCaptureResult = {
  capturedAccuracyMeters: 5,
  capturedAt: "2026-05-22T10:00:00.000Z",
  capturedLatitude: 30.0444,
  capturedLocationSource: "browser_gps",
  capturedLongitude: 31.2357,
  distanceFromResidenceKm: null,
  durationMinutes: null,
  eligibilityReason: "Captured for local draft test.",
  eligibilityStatus: "needs_review",
  employeeArea: null,
  employeeHrId: "DEV-NSM-001",
  employeeLine: null,
  employeeName: "Dev User",
  employeeRole: "National Sales Manager",
  minimumRequiredDistanceKm: 60,
  residenceLatitude: null,
  residenceLongitude: null,
  routeAlternatives: [],
  routeError: null,
  routePolyline: null,
  routeProvider: "google_maps",
  selectedRouteIndex: null,
  selectedRouteReason: null,
  submittedAt: "2026-05-22T10:00:00.000Z",
  territoryValidationReason: "Pending server validation.",
  territoryValidationStatus: "not_available",
  toArea: null,
  toCity: null,
  toLabel: "Test destination",
};

const baseDraft: OutstationLocalDraft = {
  captured,
  carEvidenceCapturedAt: "2026-05-22T10:00:00.000Z",
  carEvidenceImageDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
  carEvidenceLatitude: 30.0444,
  carEvidenceLocationLabel: "Old submitted car photo",
  carEvidenceLongitude: 31.2357,
  carEvidenceRequestId: "draft-1",
  expenseType: "traveling",
  goTicketAmount: "",
  hasTicketAttachments: false,
  kilometerReading: "12345",
  medicalTripHrId: "",
  notes: "Draft note",
  returnTicketAmount: "",
  syncPending: true,
  transportationType: "car",
  tripEndDate: "2026-05-22",
  tripStartDate: "2026-05-22",
};

export function runOutstationLocalDraftTests() {
  assert.equal(parseOutstationLocalDraft(null), null);
  assert.equal(parseOutstationLocalDraft("{invalid"), null);
  assert.deepEqual(parseOutstationLocalDraft(JSON.stringify(baseDraft)), baseDraft);

  assert.equal(isRestorableOutstationLocalDraft(baseDraft), true);
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, syncPending: false }),
    false,
    "submitted or stale online drafts must not restore old expense data",
  );
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, captured: null }),
    false,
    "offline sync drafts need a captured destination before restore",
  );
}
