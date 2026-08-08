import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateManualWorkloadInput } from "../src/lib/outstation/expense-gate.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Slice one function body so an assertion is scoped to it, not to the whole 3k-line service. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/**
 * The Super Admin repair path (owner request 2026-08-04): when the CRM workload grab fails, a
 * Super Admin may retry it or type the numbers in. The typed numbers release money, so the
 * validation below is the last thing standing between a typo and a payroll row.
 */
export function runOutstationWorkloadRepairTests() {
  // ── A valid entry passes through normalised ─────────────────────────────────────
  const good = validateManualWorkloadInput({ amWorkload: 3, pmWorkload: 4, reason: "CRM outage on 17 Oct" });
  assert.equal(good.ok, true, "a whole-number entry with a reason is accepted");
  if (good.ok) {
    assert.equal(good.amWorkload, 3);
    assert.equal(good.pmWorkload, 4);
    assert.equal(good.reason, "CRM outage on 17 Oct");
  }

  // Numeric strings are what an HTML input actually produces.
  const fromInputs = validateManualWorkloadInput({ amWorkload: "2", pmWorkload: "0", reason: " typed " });
  assert.equal(fromInputs.ok, true, "the numeric strings an <input> yields are accepted");
  if (fromInputs.ok) {
    assert.equal(fromInputs.pmWorkload, 0, "a real, deliberate zero is allowed — it is a measurement");
    assert.equal(fromInputs.reason, "typed", "the reason is trimmed");
  }

  // ── A reason is mandatory ───────────────────────────────────────────────────────
  for (const reason of ["", "   ", null, undefined]) {
    const result = validateManualWorkloadInput({ amWorkload: 1, pmWorkload: 1, reason });
    assert.equal(
      result.ok,
      false,
      `reason ${JSON.stringify(reason)} must be refused — an unexplained hand-entered figure is indistinguishable from a mistake later`,
    );
  }

  // ── Bad numbers are REFUSED, never coerced ──────────────────────────────────────
  // This is the behaviour the extraction changed. The previous inline version did
  // Math.max(0, Math.trunc(value)), which turned every one of these into a plausible-looking
  // number and wrote it to a column that feeds payroll.
  const negative = validateManualWorkloadInput({ amWorkload: -5, pmWorkload: 1, reason: "why" });
  assert.equal(
    negative.ok,
    false,
    "a negative must be refused, NOT clamped to 0 — clamping records 'he did no work' as though it were measured",
  );

  const fractional = validateManualWorkloadInput({ amWorkload: 2.5, pmWorkload: 1, reason: "why" });
  assert.equal(fractional.ok, false, "half a visit is not a thing — a fraction means the caller meant something else");

  for (const bad of ["abc", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    const result = validateManualWorkloadInput({ amWorkload: bad, pmWorkload: 1, reason: "why" });
    assert.equal(
      result.ok,
      false,
      `${JSON.stringify(String(bad))} must be refused — NaN in the column makes the workload unreadable rather than visibly wrong`,
    );
  }

  // An empty box is an ABSENT value, not a measured zero. Number("") is 0, so without this a
  // blank field would silently record that the employee did no work that half-day.
  for (const blank of ["", null, undefined]) {
    const result = validateManualWorkloadInput({ amWorkload: blank, pmWorkload: 1, reason: "why" });
    assert.equal(result.ok, false, `a blank AM box (${JSON.stringify(blank)}) must be refused, not read as zero`);
  }

  // ── The service must actually USE the checker ───────────────────────────────────
  // setOutstationWorkloadManually needs Supabase, so this is the only way to pin that the
  // validated value is what gets written rather than the raw input.
  const service = source("src/lib/outstation/service.ts");
  const manualSlice = functionSlice(service, "export async function setOutstationWorkloadManually");
  assert.match(
    manualSlice,
    /validateManualWorkloadInput\(input\)/,
    "the manual entry must run through the pure checker, not re-implement its rules inline",
  );
  assert.doesNotMatch(
    manualSlice,
    /Math\.max\(0,\s*Math\.trunc/,
    "the coercing version must be gone — it silently turned a negative into a measured-looking zero",
  );
  assert.match(
    manualSlice,
    /workload_source:\s*"override"/,
    "a hand-entered workload must be stored as an override, never as if the CRM produced it",
  );
  assert.match(
    manualSlice,
    /workload_match_status:\s*"manual_override"/,
    "and its match status must say so too — an approver has to tell a typed number from a measured one",
  );

  // ── Both repairs are Super Admin only ───────────────────────────────────────────
  // assertOutstationAdminAccess(..., "approve") is Super-Admin-only; the "read" variant also
  // admits the execution-only finance roles. Using "read" here would hand Finance and the CEO
  // the ability to release payments.
  for (const declaration of [
    "export async function setOutstationWorkloadManually",
    "export async function retryOutstationWorkloadCapture",
  ]) {
    assert.match(
      functionSlice(service, declaration),
      /assertOutstationAdminAccess\(access,\s*"approve"\)/,
      `${declaration} must be gated on approve (Super Admin), never on read — read admits Finance Manager and CEO`,
    );
  }
  assert.match(
    functionSlice(service, "export async function listHeldOutstationRequests"),
    /assertOutstationAdminAccess\(access,\s*"read"\)/,
    "the held LIST is read-scoped on purpose, so finance can see what is stuck without being able to change it",
  );

  // ── The employee-facing capture is owner-scoped, and CSRF-guarded at the edge ────
  const captureSlice = functionSlice(service, "export async function captureOutstationDeparturePhoto");
  assert.match(
    captureSlice,
    /normalizeHrIdForAccess\(access\.hrId\)/,
    "the departure capture must establish who the caller is…",
  );
  assert.match(
    captureSlice,
    /assertOutstationAdminAccess\(access,\s*"approve"\)/,
    "…and anyone who is NOT the submitting employee must clear the admin gate instead",
  );
  // Until 2026-08-08 this asserted that a second departure photo was refused outright. The owner
  // then allowed retakes, because refusing a blurred photo pushed honest employees into asking an
  // administrator to waive the evidence gate entirely — a worse outcome than the retake. The rule
  // it protected has NOT been dropped, it has been re-stated: a replacement is allowed only while
  // the trip window is open, and it may never overwrite what it replaces. Both halves are asserted
  // here and again, in depth, in outstation-departure-photo-retake.test.ts.
  assert.match(
    captureSlice,
    /isWithinDepartureWindow\(\{/,
    "a retake must be bounded by the trip window in the SERVICE — unbounded, the photo stops proving the employee was still at the destination, which is the only thing the pair is for",
  );
  // Matched inside the metadata literal, not merely somewhere in the function. A bare
  // /previousVersions/ passes while the archive is built and then never stored — which is exactly
  // what happened when this assertion was first written, and it stayed green through the break.
  assert.match(
    captureSlice,
    /const metadata: OutstationDepartureEvidenceMetadata = \{[\s\S]*?\n\s*previousVersions,[\s\S]*?\n\s*\};/,
    "the archived versions must be WRITTEN INTO the stored metadata — building the list and not persisting it leaves no trail at all, and a corrected photo becomes indistinguishable from a substituted one",
  );

  for (const route of [
    "app/api/outstation/[id]/departure-photo/route.ts",
    "app/api/admin/outstation/[id]/workload/route.ts",
  ]) {
    assert.match(
      source(route),
      /assertSameOriginMutation\(request\)/,
      `${route} mutates state and must reject a cross-origin POST`,
    );
  }
}
