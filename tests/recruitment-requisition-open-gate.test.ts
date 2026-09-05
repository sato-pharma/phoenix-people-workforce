import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  isReplacementRequisition,
  requisitionOpenBlock,
} from "../src/lib/recruitment/requisition-open-gate.ts";

/**
 * What a requisition must be able to say before it opens a real hire.
 *
 * ── MEASURED FIRST, SO THE GATE REFUSES NOTHING THAT EXISTS ───────────────────────────────────
 *
 * Production, 2026-09-05: six requisitions, four open. Every replacement names a real person and
 * every one of those people is `resigned`. So this is a floor for what comes next, not a sweep that
 * invalidates today's work — which is the difference between a guard people keep and one they
 * switch off.
 *
 * The plan called for "headcount/budget approval". A budget gate was NOT built: salary_band_min and
 * salary_band_max are NULL on all six rows, so it would have refused everything on day one.
 */
export function runRecruitmentRequisitionOpenGateTests() {
  const replacement = (over: Record<string, unknown> = {}) => ({
    headcount: 1,
    headcountType: "replacement",
    replacementForHrId: "B-175",
    ...over,
  }) as Parameters<typeof requisitionOpenBlock>[0];

  const expansion = (over: Record<string, unknown> = {}) => ({
    headcount: 1,
    headcountType: "expansion",
    replacementForHrId: null,
    ...over,
  }) as Parameters<typeof requisitionOpenBlock>[0];

  // ── the shape production actually has: passes ────────────────────────────────────────────────
  assert.equal(
    requisitionOpenBlock(replacement(), "resigned"),
    null,
    "a replacement for somebody who resigned is exactly the normal case and must open cleanly",
  );
  assert.equal(requisitionOpenBlock(expansion(), null), null, "an expansion needs no replacement");

  // ── a hire for nobody ────────────────────────────────────────────────────────────────────────
  for (const headcount of [0, -1, Number.NaN]) {
    const block = requisitionOpenBlock(expansion({ headcount }), null);
    assert.equal(block?.code, "no_headcount", `headcount ${String(headcount)} must be refused`);
  }

  // ── a replacement that names nobody ──────────────────────────────────────────────────────────
  for (const value of [null, "", "   "]) {
    const block = requisitionOpenBlock(replacement({ replacementForHrId: value }), "resigned");
    assert.equal(
      block?.code,
      "replacement_unnamed",
      "a replacement requisition must say who it replaces, or be an expansion instead",
    );
  }

  // ── THE ONE THAT MATTERS: replacing somebody who is still here ───────────────────────────────
  //
  // Either the seat is counted twice or an exit was never recorded, and both look identical to a
  // healthy requisition on screen.
  {
    const block = requisitionOpenBlock(replacement(), "active");
    assert.equal(block?.code, "replacement_still_employed");
    assert.match(
      block?.message ?? "",
      /counts their seat twice|never recorded/,
      "the refusal must name BOTH possibilities - the reader has to know which one to go and check",
    );
    assert.match(block?.message ?? "", /B-175/, "and name the person, so the check is actionable");
  }

  // ── an UNKNOWN status must not read as "has left" ────────────────────────────────────────────
  //
  // The list is of statuses that mean gone, not the inverse of "active". Inverting it would let any
  // status this code has never seen - a new one, a typo, a blank - open a duplicate seat, which is
  // the direction that costs money.
  for (const unknown of [null, "", "on_leave", "seconded", "probation", "suspended"]) {
    const block = requisitionOpenBlock(replacement(), unknown);
    assert.equal(
      block?.code,
      "replacement_still_employed",
      `"${String(unknown)}" is not a status meaning the person has gone, so it must NOT open the gate`,
    );
  }

  // ── the statuses that do mean gone ───────────────────────────────────────────────────────────
  for (const gone of ["resigned", "Resigned", " TERMINATED ", "inactive", "retired"]) {
    assert.equal(
      requisitionOpenBlock(replacement(), gone),
      null,
      `"${gone}" means the person has left, in any casing or padding`,
    );
  }

  assert.equal(isReplacementRequisition("Replacement"), true, "the type match is casing-blind");
  assert.equal(isReplacementRequisition("expansion"), false);

  // ── wired to req_open ONLY ───────────────────────────────────────────────────────────────────
  //
  // Re-running it on close would refuse to CLOSE a requisition whose replacement was since
  // re-hired - blocking the tidy-up rather than the hire.
  const service = readFileSync("src/lib/recruitment/requisitions.ts", "utf8");
  assert.match(
    service,
    /if \(actionKey === "req_open"\) \{/,
    "the gate must run on req_open and nothing else",
  );
  assert.match(
    service,
    /hrIdLookupKeys\(requisition\.replacementForHrId\)/,
    "the replacement lookup must be casing-blind - a plain .eq under-returns and would read as "
      + "'this person does not exist', blocking a legitimate replacement",
  );
  // Compared by POSITION rather than by one regex spanning both: a window wide enough to hold
  // whatever sits between them is a window wide enough to match them in either order.
  const transitionAt = service.indexOf("await assertRecruitmentTransition({");
  const gateAt = service.indexOf('if (actionKey === "req_open") {');
  assert.ok(transitionAt > -1, "the registry transition check must still be there");
  assert.ok(gateAt > -1, "and the open gate must be there");
  assert.ok(
    transitionAt < gateAt,
    "the gate must run AFTER the registry transition check, which is what decides who may act at "
      + "all - running first would answer a caller who was never allowed to act with a business "
      + "complaint instead of a refusal",
  );
}
