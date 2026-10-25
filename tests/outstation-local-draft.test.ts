import assert from "node:assert/strict";

import {
  isRestorableOutstationLocalDraft,
  outstationDraftStorageKeyFor,
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
  ownerHrId: "DEV-NSM-001",
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

  const owner = "DEV-NSM-001";
  assert.equal(isRestorableOutstationLocalDraft(baseDraft, owner), true);
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, syncPending: false }, owner),
    false,
    "submitted or stale online drafts must not restore old expense data",
  );
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, captured: null }, owner),
    false,
    "offline sync drafts need a captured destination before restore",
  );

  // ── Whose claim is it? (cache audit, 2026-10-26, P0) ──────────────────────────────────────
  // The wizard restores AND replays the draft, and the server files a replay under the session that
  // sends it. A draft restored for the wrong person is that person's money claim.
  assert.equal(
    isRestorableOutstationLocalDraft(baseDraft, "DEV-REP-002"),
    false,
    "HEADLINE: rep A's offline claim is never restored or replayed for rep B on a shared phone",
  );
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, ownerHrId: undefined }, owner),
    false,
    "a draft from before the owner rule cannot say whose claim it is, so it is never restored",
  );
  assert.equal(isRestorableOutstationLocalDraft(baseDraft, ""), false, "nor for a viewer not yet known");
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, ownerHrId: " dev-nsm-001 " }, owner),
    true,
    "spaces and letter case never decide whose draft it is",
  );
  assert.notEqual(
    outstationDraftStorageKeyFor("DEV-NSM-001"),
    outstationDraftStorageKeyFor("DEV-REP-002"),
    "each person on a shared phone keeps a draft under their own key",
  );
  assert.notEqual(
    outstationDraftStorageKeyFor("DEV-NSM-001"),
    "phoenix-outstation-draft",
    "and never under the old browser-wide key",
  );
  assert.equal(outstationDraftStorageKeyFor(""), null, "no viewer, no key: nothing is stored");
}
