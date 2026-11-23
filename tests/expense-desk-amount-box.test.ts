/**
 * Expense Approvals — THE AMOUNT BESIDE APPROVE IS HIS TO EDIT, pinned.
 *
 * Owner, 2026-11-23, about 23:40 Cairo: "make me able to edit in the value, make it as it is or
 * decrease it, or if you decided that it should be decreased, make me able to edit it."
 *
 * Every waiting claim's row, phone card and opened trip carries an amount box before Approve. It opens
 * on what Approve pays untouched (the claim, or the system's idle-day cut), and the one press pays what
 * the box says:
 *
 *   1. the claim itself → Approve in full, "Keep full claim" said out loud where a cut was offered;
 *   2. exactly the system's cut → the same press the untouched button sends;
 *   3. any other figure below the claim → a reduced amount, with the sentence of what he set as its
 *      reason (a reduced amount is never told to the employee);
 *   4. more than the claim, nothing, or a lower figure on a trip the payroll gate would hold → no
 *      press, the button disabled and the reason shown;
 *   5. a typed figure belongs to the version of the claim it was typed on.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { amountPress, approvePress, defaultAmountText } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim } from "@/lib/outstation/approvals/types";

const plain = { holdReason: null, preCut: null, requestId: 7, revision: "r7", standing: "waiting", total: 1200 } as unknown as DeskClaim;
const withCut = {
  ...plain,
  preCut: { deduction: 500, payable: 700, reason: "5 days with no field work: their allowance is not paid." },
  requestId: 8,
  revision: "r8",
} as unknown as DeskClaim;
const held = { ...plain, holdReason: "Photos are missing.", requestId: 9, revision: "r9" } as unknown as DeskClaim;

export async function runExpenseDeskAmountBoxTests() {
  // The box opens on what Approve pays untouched.
  assert.equal(defaultAmountText(plain), "1200", "HEADLINE: a claim with no cut opens on the claim");
  assert.equal(defaultAmountText(withCut), "700", "HEADLINE: a claim the system cut opens on the cut, for him to edit");
  assert.equal(defaultAmountText({ ...withCut, holdReason: "Photos are missing." } as DeskClaim), "1200", "a held trip carries no cut, so it opens on the claim");

  // 1. The claim itself: paid in full.
  assert.deepEqual(amountPress(plain, "1200"), { decision: approvePress(plain, { full: true }), error: null, figure: 1200 });
  assert.deepEqual(
    amountPress(withCut, "1,200").decision,
    { action: "approve", keepFull: true, requestId: 8, revision: "r8" },
    "HEADLINE: typing the claim back over the system's cut pays it in full, keep-full said out loud",
  );
  assert.equal(amountPress(withCut, "1199.6").figure, 1200, "within half a pound is the claim itself");

  // 2. Exactly the cut: the untouched button's own press.
  assert.deepEqual(amountPress(withCut, "700").decision, approvePress(withCut), "HEADLINE: the cut left as it is sends the untouched Approve");

  // 3. Any other lower figure: a reduced amount, with what he set as its reason.
  const lower = amountPress(withCut, "850");
  assert.deepEqual(
    lower.decision,
    {
      action: "reduce",
      approvedAmount: 850,
      comment: "Amount set to EGP 850 of the EGP 1,200 claimed. The system offered EGP 700 for the idle days.",
      requestId: 8,
      revision: "r8",
    },
    "HEADLINE: editing the system's cut pays exactly the figure typed",
  );
  assert.deepEqual(amountPress(plain, "950.5").decision, {
    action: "reduce",
    approvedAmount: 950.5,
    comment: "Amount set to EGP 950.5 of the EGP 1,200 claimed.",
    requestId: 7,
    revision: "r7",
  }, "HEADLINE: a claim with no cut can be decreased from the row");

  // 4. Refused before anything is sent.
  assert.equal(amountPress(plain, "1300").decision, null, "HEADLINE: never more than the claim");
  assert.match(String(amountPress(plain, "1300").error), /More than the claim \(EGP 1,200\)/);
  assert.equal(amountPress(plain, "").decision, null, "nothing typed, nothing sent");
  assert.equal(amountPress(plain, "0").decision, null, "zero is a rejection, never an approval");
  assert.equal(amountPress(plain, "abc").decision, null);
  assert.equal(amountPress(held, "800").decision, null, "HEADLINE: a trip the payroll gate would hold cannot carry a lower amount");
  assert.match(String(amountPress(held, "800").error), /held out of payroll/);
  assert.deepEqual(amountPress(held, "1200").decision, approvePress(held, { full: true }), "but it can still be approved in full");

  // 5 + the screen: one box before Approve, its figure kept for the version it was typed on, a
  // refused figure disabling the press and saying why.
  const screen = fs.readFileSync("src/components/outstation/approvals-desk/desk-decision.tsx", "utf8");
  assert.ok(screen.includes("data-amount-box"), "HEADLINE: the box is on the row");
  assert.ok(screen.includes("const amountText = typed && typed.revision === claim.revision ? typed.text : defaultAmountText(claim);"), "HEADLINE: a changed claim opens on its own figure again");
  assert.ok(screen.includes("onClick={() => onPress([edited?.decision ?? approvePress(claim)], [claim])}"), "HEADLINE: Approve pays what the box says, in one press");
  assert.ok(screen.includes("disabled={edited?.error ? true : undefined}"), "HEADLINE: a figure the server would refuse disables Approve");
  assert.ok(screen.includes("{edited.error}"), "and says why");
}
