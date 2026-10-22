import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isOutstationRequestHeldForRepair,
  validateManualWorkloadInput,
} from "../src/lib/outstation/expense-gate.ts";

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

  // ── A re-grab must leave the row agreeing with itself ───────────────────────────
  // The capture writes am/pm and workload_source but used to leave workload_match_status alone,
  // so a repaired row stored a real CRM count next to a column still reading "no_activity" — the
  // state the FIRST, premature grab had recorded. Three production rows looked like that on
  // 2026-08-19. It gates nothing, which is precisely why it went unnoticed: it is the field a
  // human reads to decide whether the number in front of them means anything.
  const captureWorkloadSlice = functionSlice(service, "async function captureWorkloadAndReleaseIfReady");
  // Since 2026-10-22 the columns a capture writes are ONE shape, capturedWorkloadColumns in
  // workload-stamp.ts, shared with the next-morning refresh — so the re-grab must write through it,
  // and that shape must restate the verdict from the numbers it writes.
  assert.ok(
    captureWorkloadSlice.includes("...capturedWorkloadColumns(capture, now),"),
    "a successful re-grab must write the one shared stamp shape, numbers and verdict together",
  );
  const stampColumns = functionSlice(
    source("src/lib/outstation/workload-stamp.ts"),
    "export function capturedWorkloadColumns(",
  );
  assert.match(
    stampColumns,
    // Since 2026-09-21 the numbers are AM · PM · Pharmacies, so the verdict comes from all three
    // (a pharmacy-only trip is worked) — tests/outstation-trip-workload-pharmacies.test.ts pins why.
    /workload_match_status:\s*\n?\s*capturedWorkloadMatchStatus\(capture\)/,
    "a successful re-grab must restate the match status from the numbers it just wrote, or the row contradicts itself",
  );
  // Both branches, so the pair can never drift into "matched" on a genuine zero.
  const matchStatusFn = functionSlice(
    source("src/lib/outstation/workload-rollup.ts"),
    "export function capturedWorkloadMatchStatus(",
  );
  for (const value of ['"matched"', '"no_activity"']) {
    assert.ok(
      matchStatusFn.includes(value),
      `the re-grab must still be able to record ${value} — collapsing to one of the two makes the column decorative`,
    );
  }

  // ── The retry reports the release's OWN reason ──────────────────────────────────
  // releaseOutstationRequestToPayrollIfReady declines for three different causes; only one of
  // them is the evidence gate. Re-deriving the gate here reported "Retry, or check the expense
  // record" for a request that was merely still awaiting the owner's approval — advice that leads
  // nowhere and invites an endless retry loop.
  const retrySlice = functionSlice(service, "export async function retryOutstationWorkloadCapture");
  assert.match(
    retrySlice,
    /const release = await captureWorkloadAndReleaseIfReady\(request, access\)/,
    "the retry must KEEP the release outcome — discarding it is what left it guessing",
  );
  assert.match(
    retrySlice,
    /if \(release && !release\.released\) \{\s*\n\s*return \{ message: `Workload captured, but the request did not reach payroll: \$\{release\.reason\}`/,
    "and must report that reason verbatim, ahead of any gate it re-derives",
  );

  // ── What the repair panel is allowed to LIST ────────────────────────────────────
  // The panel is what stops a held request being invisible, and until 2026-08-19 it listed
  // nothing at all: it required `status.startsWith("accepted")`, borrowed from the payroll
  // release rule. That rule is right about who may be PAID and wrong about what may be SHOWN.
  // Since the owner's 2026-08-08 change every submission persists as `submitted`, and production
  // has carried 57 requests across two months without one reaching an `accepted_*` status — so
  // the screen built for this job could never display a row, and the 2026-08-19 repair had to be
  // driven from a script instead.
  type HeldInput = Parameters<typeof isOutstationRequestHeldForRepair>[0];
  const heldGate: HeldInput["gate"] = { blocker: "workload", isPayrollEligible: false, message: "waiting" };
  const clearedGate: HeldInput["gate"] = { blocker: null, isPayrollEligible: true, message: "complete" };
  const TODAY = "2026-08-19";
  // Fields resolved one by one rather than by spreading a Partial, so that an explicit
  // `tripEndDate: null` case is passed through as null instead of falling back to the default.
  const listed = (over: Partial<HeldInput>): boolean =>
    isOutstationRequestHeldForRepair({
      cairoTodayIso: over.cairoTodayIso ?? TODAY,
      gate: over.gate ?? heldGate,
      status: over.status ?? "submitted",
      tripEndDate: over.tripEndDate === undefined ? "2026-08-16" : over.tripEndDate,
    });

  assert.equal(
    listed({}),
    true,
    "a SUBMITTED request the gate is holding must be listed — requiring `accepted` is precisely what left this panel showing nothing at all",
  );
  for (const status of ["approved", "accepted_by_system", "accepted_by_admin", "needs_review"]) {
    assert.equal(listed({ status }), true, `a held ${status} request must be listed too`);
  }

  // Rejected is held by a DECISION. Nothing this panel offers may overturn one — the same rule
  // releaseOutstationRequestToPayrollIfReady states, and the one part of the old filter that was
  // doing real work.
  for (const status of ["rejected", "rejected_by_system", "rejected_by_admin"]) {
    assert.equal(
      listed({ status }),
      false,
      `${status} must never be listed — it is held by a decision, and the buttons here would override it`,
    );
  }

  assert.equal(listed({ gate: clearedGate }), false, "a request the gate has cleared has nothing to repair");

  // A trip that has not finished is IN PROGRESS, not held. The departure photo is taken before
  // leaving the destination, so listing a live trip under "Held out of payroll — the employee is
  // not paid until each one clears", beside a button that waives the photo permanently, invites
  // an administrator to waive a photo that is not yet due. Request 93 was submitted at 20:32
  // Cairo on the day of its own trip and would have been the newest row in the list.
  assert.equal(
    listed({ tripEndDate: TODAY }),
    false,
    "a trip ending TODAY must not be listed — the employee may still be at the destination",
  );
  assert.equal(listed({ tripEndDate: "2026-08-21" }), false, "nor a trip still days from finishing");
  assert.equal(
    listed({ tripEndDate: "2026-08-18" }),
    true,
    "a trip that ended yesterday with no departure photo IS held, and is exactly what the panel is for",
  );

  // An unreadable trip end must not hide a stuck request. These are compared as strings, and any
  // non-date text sorts ABOVE a "2026-…" date — so without the shape check a malformed value
  // would read as a far-future trip and silently suppress the row.
  for (const tripEndDate of [null, "", "not-a-date", "n/a"]) {
    assert.equal(
      listed({ tripEndDate }),
      true,
      `trip end ${JSON.stringify(tripEndDate)} proves nothing about whether the trip is over, so the request must still be shown`,
    );
  }

  // The service must actually USE the predicate rather than re-filter inline — two copies of
  // "what counts as held" is how the list and the panel's own copy drift apart.
  const heldListSlice = functionSlice(service, "export async function listHeldOutstationRequests");
  assert.match(
    heldListSlice,
    /isOutstationRequestHeldForRepair\(\{/,
    "the held list must delegate to the pure predicate, not re-implement the rule inline",
  );
  assert.doesNotMatch(
    heldListSlice,
    /status\.startsWith\("accepted"\)/,
    "the accepted-only filter must be gone — it is what made this panel permanently empty",
  );

  // ── Both repairs are Super Admin only ───────────────────────────────────────────
  // assertOutstationAdminAccess(..., "approve") is Super-Admin-only; the "read" variant also
  // admits the execution-only oversight roles. Using "read" here would hand the CEO the ability
  // to release payments. (The Finance Manager was the other read-tier role until 2026-08-10, when
  // the owner excluded him from outstation and expenses entirely.)
  for (const declaration of [
    "export async function setOutstationWorkloadManually",
    "export async function retryOutstationWorkloadCapture",
  ]) {
    assert.match(
      functionSlice(service, declaration),
      /assertOutstationAdminAccess\(access,\s*"approve"\)/,
      `${declaration} must be gated on approve (Super Admin), never on read — read also admits the CEO`,
    );
  }
  assert.match(
    functionSlice(service, "export async function listHeldOutstationRequests"),
    /assertOutstationAdminAccess\(access,\s*"read"\)/,
    "the held LIST is read-scoped on purpose, so oversight can see what is stuck without being able to change it",
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
