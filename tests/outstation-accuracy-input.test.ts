import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseNativeVisitDraft } from "../src/lib/crm/native-visits/rules.ts";
import { parseEvidenceLocationBody } from "../src/lib/evidence/location-service.ts";
import { readAccuracyInput } from "../src/lib/geo/coordinate-input.ts";
import { outstationGpsAccuracyHoldReason } from "../src/lib/outstation/decision.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A GPS accuracy the device never reported is NO accuracy, never a perfect 0 m fix.
//
// `Number(null)`, `Number("")` and `Number(" ")` are all 0, which is finite. The four outstation
// routes read the accuracy as `Number(body.capturedAccuracyMeters)`, and the submit holds a claim
// for Super Admin review only when the accuracy is ABOVE the policy limit, so a claim with no
// accuracy passed the limit as a 0 m fix. The routes now read it with readAccuracyInput
// (src/lib/geo/coordinate-input.ts, shared with direct orders since #3998).
//
// What a missing accuracy MEANS was the owner's decision, asked in chat on 2026-09-18: the claim is
// saved as "not reported" (null) and HELD for Super Admin review. It is never refused (the system
// flags, it never rejects), and a National Sales Manager is still never held: the new reason joins
// detectedHoldReasons, which the NSM rule empties for the hold and keeps for the record.
//
// 0 keeps its old meaning: the marker the admin-entered and medical-rep manual paths write, which
// expense-command.ts reads to tell a manual entry from a live one. A stored null must never read
// back as that 0.
//
// The same parse fixes two more readers: the evidence stamp (`Number(null)` stamped "±0 m") and
// the CRM visit form (" " slipped past its null and "" checks as 0 m).
//
// Production on 2026-09-18: 115 outstation claims; 23 at 0 m, every one an admin-entered manual
// claim; the 92 live claims carry 2 to 1,427 m. The defect was latent; no data was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES = [
  "app/api/outstation/calculate/route.ts",
  "app/api/outstation/capture-location/route.ts",
  "app/api/outstation/submit/route.ts",
  "app/api/outstation/sync-offline/route.ts",
];
const SERVICE = "src/lib/outstation/service.ts";
const EXPENSE_COMMAND = "src/lib/outstation/expense-command.ts";
const WIZARD = "src/components/outstation/mobile-outstation-wizard.tsx";
const ADMIN_SCREEN = "src/components/outstation/outstation-requests-admin.tsx";
const MIGRATION = "supabase/migrations/20260918113748_outstation_captured_accuracy_nullable.sql";
const EVIDENCE = "src/lib/evidence/location-service.ts";
const CRM_RULES = "src/lib/crm/native-visits/rules.ts";

const BLANKS = [
  ["null", null],
  ["undefined", undefined],
  ["empty", ""],
  ["blank", " "],
  ["tab and newline", "\t\n"],
] as const;

function read(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

/** The body of one top-level function, so a pin can target the submit path alone. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const ends = [rest.indexOf("\nexport "), rest.indexOf("\nasync function ")].filter((i) => i !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

export function runOutstationAccuracyInputTests() {
  // ── The headline: a claim with no accuracy is held, never passed as 0 m ────────
  for (const [label, value] of BLANKS) {
    const reason = outstationGpsAccuracyHoldReason({
      capturedAccuracyMeters: readAccuracyInput(value),
      gpsAccuracyLimitMeters: 100,
    });
    assert.ok(
      reason,
      `an outstation claim whose accuracy is ${label} must be held for Super Admin review — Number(...) read it as a perfect 0 m fix and it passed the 100 m limit`,
    );
    assert.match(reason, /did not report its GPS accuracy/);
    assert.match(reason, /held for Super Admin review/);
    assert.doesNotMatch(reason, /reject|refus/i, "a missing accuracy is a hold, never a refusal");
  }

  // ── The rest of the limit is unchanged ────────────────────────────────────────
  assert.equal(outstationGpsAccuracyHoldReason({ capturedAccuracyMeters: 12, gpsAccuracyLimitMeters: 100 }), null);
  assert.equal(
    outstationGpsAccuracyHoldReason({ capturedAccuracyMeters: 100, gpsAccuracyLimitMeters: 100 }),
    null,
    "an accuracy AT the limit is inside it",
  );
  assert.equal(
    outstationGpsAccuracyHoldReason({ capturedAccuracyMeters: 0, gpsAccuracyLimitMeters: 100 }),
    null,
    "a device that really reports 0 m keeps it; no range check is invented here",
  );
  assert.equal(
    outstationGpsAccuracyHoldReason({ capturedAccuracyMeters: 1427.03, gpsAccuracyLimitMeters: 100 }),
    "The captured GPS accuracy (1427 m) is outside the 100 m policy limit, so this request is held for Super Admin review before it moves to payroll.",
    "the over-limit hold keeps its exact wording",
  );
  for (const accuracy of [null, 5000]) {
    assert.equal(
      outstationGpsAccuracyHoldReason({ capturedAccuracyMeters: accuracy, gpsAccuracyLimitMeters: 0 }),
      null,
      "a policy limit of 0 still switches the check off",
    );
  }

  // ── The four routes read the accuracy with the shared reader ──────────────────
  for (const path of ROUTES) {
    const route = read(path);
    assert.doesNotMatch(
      route,
      /Number\(\s*body\.capturedAccuracyMeters\s*\)/,
      `${path} must not coerce the accuracy — Number(null), Number("") and Number(" ") are a perfect 0 m fix`,
    );
    assert.match(route, /readAccuracyInput\(body\.capturedAccuracyMeters\)/, `${path} reads the accuracy with readAccuracyInput`);
    assert.match(route, /import \{ readAccuracyInput \} from "@\/lib\/geo\/coordinate-input";/, `${path} uses the shared reader, not a copy`);
  }

  // ── The service: read at its boundary, held through the NSM-aware list ────────
  const service = read(SERVICE);
  assert.match(
    service,
    /capturedAccuracyMeters: readAccuracyInput\(params\.capturedAccuracyMeters\),/,
    "the capture result reads the accuracy once more, so a caller handing over NaN still gets null",
  );
  const submit = functionSlice(service, "export async function submitOutstationRequest");
  assert.match(
    submit,
    /const gpsAccuracyHoldReason = nonTravel\s*\?\s*null\s*:\s*outstationGpsAccuracyHoldReason\(\{\s*capturedAccuracyMeters: calculation\.capturedAccuracyMeters,/,
    "the submit path applies the shared GPS accuracy rule to the accuracy as read, while skipping it for non-travel requests",
  );
  assert.doesNotMatch(
    submit,
    /numberValue\(calculation\.capturedAccuracyMeters\)/,
    "numberValue turns a missing accuracy back into 0 m",
  );
  assert.match(
    submit,
    /detectedHoldReasons = \[[^\]]*gpsAccuracyHoldReason/,
    "the missing-accuracy hold must reach the approver through detectedHoldReasons",
  );
  assert.match(
    submit,
    /const reviewHoldReasons = noHoldRole \? \[\] : detectedHoldReasons;/,
    "a National Sales Manager is never held — the owner's 2026-08-28 rule covers this hold too",
  );
  assert.match(
    submit,
    /\[OUTSTATION_NO_HOLD_APPROVAL_REASON, \.\.\.detectedHoldReasons\]/,
    "an NSM claim still carries the flag in its reason, it is only not held",
  );
  assert.match(
    service,
    /capturedAccuracyMeters: readAccuracyInput\(row\.captured_accuracy_meters\),/,
    "a stored null reads back as null",
  );
  assert.doesNotMatch(
    service,
    /capturedAccuracyMeters: numberValue\(row\.captured_accuracy_meters\)/,
    "numberValue reads a stored null back as 0, the manual-entry marker",
  );

  // ── 0 stays the manual-entry marker, written only by the manual paths ─────────
  assert.equal(
    (service.match(/captured_accuracy_meters: 0,/g) ?? []).length,
    2,
    "the admin-entered and medical-rep manual paths still write the 0 marker, and nothing else does",
  );
  assert.match(
    read(EXPENSE_COMMAND),
    /request\.capturedAccuracyMeters === 0 &&/,
    "the expense command still recognises a manual entry by its 0 marker; null never matches it",
  );

  // ── The wizard and the admin screen ───────────────────────────────────────────
  assert.doesNotMatch(
    read(WIZARD),
    /capturedAccuracyMeters \?\? 0/,
    "the wizard must not turn a missing accuracy into 0 before it reaches the server",
  );
  assert.match(read(ADMIN_SCREEN), /capturedAccuracyMeters === null\s*\?\s*"Not reported"/, "the admin screen says Not reported");

  // ── The column can hold null ──────────────────────────────────────────────────
  assert.match(
    readFileSync(MIGRATION, "utf8"),
    /alter table public\.outstation_expense_requests\s+alter column captured_accuracy_meters drop not null;/,
    "captured_accuracy_meters must allow null, or the insert of a held claim fails",
  );

  // ── The evidence stamp ────────────────────────────────────────────────────────
  for (const [label, value] of BLANKS) {
    const parsed = parseEvidenceLocationBody({ accuracyMeters: value, latitude: 30.0444, longitude: 31.2357 });
    assert.ok(parsed, "a real pin parses");
    assert.equal(parsed.accuracyMeters, null, `an evidence stamp whose accuracy is ${label} has none — Number(...) stamped it ±0 m`);
  }
  assert.equal(
    parseEvidenceLocationBody({ accuracy: " ", latitude: 30.0444, longitude: 31.2357 })?.accuracyMeters,
    null,
    "the `accuracy` spelling is read the same way",
  );
  assert.equal(parseEvidenceLocationBody({ accuracy: 18, latitude: 30.0444, longitude: 31.2357 })?.accuracyMeters, 18);
  assert.equal(parseEvidenceLocationBody({ accuracyMeters: "12.5", latitude: 30.0444, longitude: 31.2357 })?.accuracyMeters, 12.5);
  assert.match(
    read(EVIDENCE),
    /accuracyMeters: readAccuracyInput\(input\.accuracyMeters\),/,
    "resolveEvidenceLocation reads the accuracy with the shared reader too",
  );

  // ── The CRM visit form ────────────────────────────────────────────────────────
  const visitContext = { cairoToday: "2026-09-20", now: new Date("2026-09-20T08:00:00.000Z") };
  const visitBody = (accuracyMeters: unknown) => ({
    accuracyMeters,
    clientSubmissionId: "3f1c2a6e-9b4d-4c8e-8a1f-2b3c4d5e6f70",
    comment: "",
    contactCrmId: 5123,
    deviceRecordedAt: "2026-09-20T07:55:00.000Z",
    latitude: 30.0444,
    longitude: 31.2357,
    partnerHrIds: [],
    shift: "AM",
    visitDate: "2026-09-20",
    visitType: "regular",
  });
  for (const [label, value] of BLANKS) {
    const visit = parseNativeVisitDraft(visitBody(value), visitContext);
    assert.ok(visit.ok, "a visit with a fix and no accuracy still parses");
    assert.equal(visit.value.accuracyMeters, null, `a CRM visit whose accuracy is ${label} has none — " " read as 0 m`);
  }
  const measured = parseNativeVisitDraft(visitBody(12), visitContext);
  assert.ok(measured.ok);
  assert.equal(measured.value.accuracyMeters, 12, "a real accuracy is kept");
  assert.doesNotMatch(read(CRM_RULES), /finiteOrNull\(body\.accuracyMeters\)/, "the CRM rules read the accuracy with the shared reader");
}
