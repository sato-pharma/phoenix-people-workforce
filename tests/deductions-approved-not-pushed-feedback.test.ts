// An approved deduction must never be told it is "awaiting your approval", on either screen.
//
// WHY THIS EXISTS, MEASURED. Owner-reported 2026-10-06, then again 2026-10-07 in his own words:
// *"i presss approv to payroll nothing happns and kept needs review"*, and before that *"those
// are the vacation no balanace deductions i approved on deductions module automated payroll is
// only showing me mohamed khaled"*.
//
// Neither was a broken button, and no figure was ever wrong. Since the push cutover (owner rule
// 2026-09-22) the gate for pay is the PUSH, not the decision — "nothing is deducted until the
// Super Admin pushes that specific line" (deductions-source.ts). Both screens were telling him
// to APPROVE things he had already approved, and nothing named the push that was actually left:
//
//   * the Automated Payroll breakdown labelled every withheld line "awaiting your approval in
//     Deductions", including the ones whose decision already read "Approved for Payroll";
//   * the Deductions workspace kept its orange "Needs your review" pill on every row whose
//     calculation_status is `requires_review`, a field that records the ENGINE's inability to
//     settle an amount and which no decision ever rewrites — so the pill survived his approval.
//
// Measured on production the night he reported it: 17 approved candidates worth 11,580.17 EGP
// sat un-pushed across four categories, and all five September unpaid-vacation rows marked
// `requires_review` already carried a decision — one of them saved two minutes before he wrote
// in. Every one of them was still being labelled as waiting for him.
//
// This test holds both ends. It does NOT assert that an approval reaches payroll — it must not,
// because the owner's rule is that it does not until he pushes it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PAYROLL_APPROVED_STATUS, withheldLineStatus } from "@/lib/automated-payroll/deductions-source";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE = "src/components/admin/deductions-workspace.tsx";

export function runDeductionsApprovedNotPushedFeedbackTests() {
  // ---- 1. The payroll breakdown sentence ------------------------------------------------------

  const approved = withheldLineStatus(PAYROLL_APPROVED_STATUS);

  assert.ok(
    !/awaiting your approval/i.test(approved),
    `An APPROVED but un-pushed line still reads "awaiting your approval": ${JSON.stringify(approved)}. ` +
      `He has approved it — that sentence names a step he has finished and hides the push, which is ` +
      `the one thing left. It is what made him report payroll as broken twice.`,
  );
  assert.ok(
    /push/i.test(approved),
    `An APPROVED but un-pushed line must name the PUSH as the remaining action, because that is the ` +
      `gate for pay (owner rule 2026-09-22). It reads: ${JSON.stringify(approved)}.`,
  );
  assert.ok(
    /not charged/i.test(approved),
    `An approved but un-pushed line must still say it is NOT charged — it contributes 0.00 to the ` +
      `row, and a reader checking the breakdown against the figure must not read it as money. It ` +
      `reads: ${JSON.stringify(approved)}.`,
  );
  assert.ok(
    approved.startsWith(PAYROLL_APPROVED_STATUS),
    `The line must keep carrying its real decision status first. It reads: ${JSON.stringify(approved)}.`,
  );

  // An undecided line keeps the original sentence: there the approval IS what is missing.
  for (const undecided of ["Pending", "Needs Follow-up", "Disputed", "Do Not Take Action"]) {
    const text = withheldLineStatus(undecided);
    assert.ok(
      /awaiting your approval/i.test(text),
      `An UNDECIDED line ("${undecided}") must still ask for the approval — that is genuinely the ` +
        `missing step. It reads: ${JSON.stringify(text)}.`,
    );
    assert.ok(
      !/push/i.test(text),
      `An UNDECIDED line ("${undecided}") must NOT ask for a push: a candidate cannot be pushed ` +
        `before it is approved (push.ts refuses it), so that would be an impossible instruction. ` +
        `It reads: ${JSON.stringify(text)}.`,
    );
  }

  // ---- 2. The workspace's "Needs your review" pill --------------------------------------------

  // Comments are STRIPPED before anything is counted or searched. The comment recording this
  // incident quotes the pill's own text, and the first draft of this test tripped its own
  // "exactly one" guard on that quotation — the same trap as tests/login-form-locator-contract:
  // a guard that reads prose polices the wording of its own explanation.
  const workspace = readFileSync(path.join(ROOT, WORKSPACE), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");

  // Extraction guard: the assertions below are worthless if the pill moved or was renamed.
  const pillCount = workspace.split("Needs your review").length - 1;
  assert.equal(
    pillCount,
    1,
    `Expected exactly one "Needs your review" pill in ${WORKSPACE}, found ${pillCount}. If it moved ` +
      `or was duplicated, re-point this test — a second copy would be ungated and would reproduce ` +
      `the bug on another surface.`,
  );

  const pillAt = workspace.indexOf("Needs your review");
  // The condition that renders it sits just above the pill's own markup.
  const condition = workspace.slice(Math.max(0, pillAt - 700), pillAt);

  assert.ok(
    /row\.calculationStatus === "requires_review"/.test(condition),
    `${WORKSPACE}: the "Needs your review" pill is no longer gated on calculationStatus at all. ` +
      `Re-point this test, then check the new gate still clears once a decision exists.`,
  );
  assert.ok(
    /decisionStatus/.test(condition),
    `${WORKSPACE}: the "Needs your review" pill is rendered from calculationStatus ALONE, so it ` +
      `survives his decision and the row keeps demanding a review he has already done — exactly ` +
      `what he reported on 2026-10-07 ("i presss approv to payroll nothing happns and kept needs ` +
      `review"). calculation_status is the engine's verdict and nothing rewrites it, so the pill ` +
      `must also require the decision to still be Pending.`,
  );
  assert.ok(
    /"Pending"/.test(condition),
    `${WORKSPACE}: the pill's gate mentions decisionStatus but not the Pending comparison. An ` +
      `undecided row has no decision row at all, so the gate must treat a missing decision as ` +
      `Pending — otherwise a genuinely unreviewed row stops showing the pill, which is the same ` +
      `bug pointing the other way.`,
  );
}
