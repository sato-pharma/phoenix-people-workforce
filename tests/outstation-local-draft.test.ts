import assert from "node:assert/strict";

import {
  isRestorableOutstationLocalDraft,
  outstationDraftStorageKey,
  parseOutstationLocalDraft,
  saveOutstationLocalDraft,
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
  fraudFlags: [],
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
  suspiciousLocationScore: 0,
  territoryValidationReason: "Pending server validation.",
  territoryValidationStatus: "not_available",
  toArea: null,
  toCity: null,
  toLabel: "Test destination",
};

const nowIso = new Date().toISOString();

const baseDraft: OutstationLocalDraft = {
  employeeHrId: "DEV-NSM-001",
  captured,
  carEvidenceCapturedAt: "2026-05-22T10:00:00.000Z",
  carEvidenceImageDataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
  carEvidenceImagePath: null,
  carEvidenceLatitude: 30.0444,
  carEvidenceLocationLabel: "Old submitted car photo",
  carEvidenceLongitude: 31.2357,
  carEvidenceRequestId: "draft-1",
  expenseType: "traveling",
  goTicketAmount: "",
  hasTicketAttachments: false,
  kilometerReading: "12345",
  medicalTripHrId: "",
  updatedAt: nowIso,
  notes: "Draft note",
  returnTicketAmount: "",
  syncPending: true,
  transportationType: "car",
  tripEndDate: "2026-05-22",
  tripStartDate: "2026-05-22",
};

type QuotaMode = "none" | "failOnce" | "alwaysFail";

type MockStorage = {
  setRawItem: (key: string, value: string) => void;
  getRawItem: (key: string) => string | null;
  getSetItemAttempts: () => number;
  setQuotaMode: (mode: QuotaMode) => void;
};

function createMockWindowWithStorage() {
  const entries = new Map<string, string>();
  let setItemCalls = 0;
  let quotaMode: QuotaMode = "none";

  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    key(index) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      setItemCalls += 1;
      if (quotaMode === "failOnce" && setItemCalls === 1) {
        throw new DOMException("No space left", "QuotaExceededError");
      }
      if (quotaMode === "alwaysFail") {
        throw new DOMException("No space left", "QuotaExceededError");
      }
      entries.set(key, value);
    },
  } as Storage;

  return {
    storage,
    state: {
      setRawItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      getRawItem: (key: string) => entries.get(key) ?? null,
      getSetItemAttempts: () => setItemCalls,
      setQuotaMode: (mode: QuotaMode) => {
        quotaMode = mode;
      },
    } as MockStorage,
    install() {
      (globalThis as unknown as { window: { localStorage: Storage } }).window = {
        localStorage: storage,
      };
    },
  };
}

export function runOutstationLocalDraftTests() {
  assert.equal(parseOutstationLocalDraft(null), null);
  assert.equal(parseOutstationLocalDraft("{invalid"), null);
  assert.deepEqual(parseOutstationLocalDraft(JSON.stringify(baseDraft)), baseDraft);

  assert.equal(isRestorableOutstationLocalDraft(baseDraft, "DEV-NSM-001"), true);
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, syncPending: false }, "DEV-NSM-001"),
    false,
    "submitted or stale online drafts must not restore old expense data",
  );
  assert.equal(
    isRestorableOutstationLocalDraft({ ...baseDraft, captured: null }, "DEV-NSM-001"),
    false,
    "offline sync drafts need a captured destination before restore",
  );
  assert.equal(
    isRestorableOutstationLocalDraft(
      { ...baseDraft, employeeHrId: "OTHER-000", updatedAt: nowIso },
      "DEV-NSM-001",
    ),
    false,
    "drafts from another employee should not auto-restore old expense data",
  );

  const previousWindow = (globalThis as { window?: { localStorage: Storage } }).window;
  try {
    const fresh = createMockWindowWithStorage();
    fresh.install();
    const freshResult = saveOutstationLocalDraft(outstationDraftStorageKey, baseDraft);
    assert.deepEqual(freshResult, { success: true, quotaExceeded: false });
    assert.equal(fresh.state.getSetItemAttempts(), 1);
    assert.equal(fresh.state.getRawItem(outstationDraftStorageKey), JSON.stringify(baseDraft));

    const stale = new Date(Date.now() - 1000 * 60 * 60 * 13).toISOString();
    const retry = createMockWindowWithStorage();
    retry.state.setRawItem(
      outstationDraftStorageKey,
      JSON.stringify({ ...baseDraft, updatedAt: stale }),
    );
    retry.state.setQuotaMode("failOnce");
    retry.install();
    const retryResult = saveOutstationLocalDraft(outstationDraftStorageKey, baseDraft);
    assert.deepEqual(retryResult, { success: true, quotaExceeded: false });
    assert.equal(retry.state.getSetItemAttempts(), 2);
    assert.equal(retry.state.getRawItem(outstationDraftStorageKey), JSON.stringify(baseDraft));

    const fail = createMockWindowWithStorage();
    fail.state.setRawItem(
      outstationDraftStorageKey,
      JSON.stringify({ ...baseDraft, updatedAt: nowIso }),
    );
    fail.state.setQuotaMode("alwaysFail");
    fail.install();
    const failResult = saveOutstationLocalDraft(outstationDraftStorageKey, baseDraft);
    assert.deepEqual(failResult, { success: false, quotaExceeded: true });
    assert.equal(fail.state.getRawItem(outstationDraftStorageKey), JSON.stringify(baseDraft));
  } finally {
    (globalThis as { window?: { localStorage: Storage } }).window = previousWindow ?? undefined;
  }
}
