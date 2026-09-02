import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * Production incident: request 77 (B-122, 2026-08-16). The admin typed 550 into "Meeting
 * amount" while Expense type was "meeting", then switched the type to "other" before saving.
 * The Meeting amount box disappeared from the screen — it only rendered when
 * expenseType === "meeting" — but React state does not clear itself on an unmount, and
 * handleSubmit built its payload from meetingAmount/otherAmount unconditionally, not from
 * whichever box was on screen. The request saved as expense_type "other" with the 550 still in
 * meeting_amount and other_amount at 0.00 — an amount typed under one type, paid under another,
 * while the visible box for that type read empty. The payable total was correct throughout
 * (reportExpectedTotal in src/lib/outstation/service.ts sums travelCost + meetingAmount +
 * allowanceAmount + otherAmount unconditionally); only the category the admin could see was
 * wrong, silently.
 *
 * Fixed by always rendering both amount boxes, never gating either on expenseType — matching
 * the rep-facing mobile-outstation-wizard, which never gated them either, and matching
 * production reality: six live rep-submitted requests carry a real meeting or "other" amount
 * on an expense_type of "traveling" (e.g. #45 "BRM for delta 1 team7" meeting 627.20, #114
 * parking 20.00 on 2026-09-02). Zeroing whichever amount doesn't match the selected type would
 * have been the wrong fix — it would silently drop real money from every one of those trips.
 */
export function runOutstationAdminManualExpenseAmountVisibilityTests() {
  const modal = readSource("../src/components/outstation/admin-manager-expense-modal.tsx");

  // The two amount inputs must not be wrapped in an expenseType-gated conditional. Matching the
  // exact pre-fix shape (`{expenseType === "meeting" ? (` / `) : expenseType === "other" ? (`)
  // catches a straight revert; matching either half alone catches a half-revert that leaves one
  // box gated and the other unconditional.
  assert.doesNotMatch(
    modal,
    /expenseType === "meeting" \? \(/,
    "the Meeting amount field must not be conditionally rendered on expenseType — an admin " +
      "switching type away from \"meeting\" must not be able to hide a typed amount that still " +
      "gets submitted",
  );
  assert.doesNotMatch(
    modal,
    /expenseType === "other" \? \(/,
    "the Other amount field must not be conditionally rendered on expenseType — an admin " +
      "switching type away from \"other\" must not be able to hide a typed amount that still " +
      "gets submitted",
  );

  // Both fields must still exist, unconditionally, driven by their own state.
  assert.match(
    modal,
    /<FieldLabel>Meeting amount \(EGP\)<\/FieldLabel>[\s\S]{0,200}?onChange=\{\(e\) => setMeetingAmount\(e\.target\.value\)\}/,
    "the admin modal must render a Meeting amount input bound to setMeetingAmount",
  );
  assert.match(
    modal,
    /<FieldLabel>Other amount \(EGP\)<\/FieldLabel>[\s\S]{0,200}?onChange=\{\(e\) => setOtherAmount\(e\.target\.value\)\}/,
    "the admin modal must render an Other amount input bound to setOtherAmount",
  );

  // Guard against the fields being reintroduced as conditional on ANY other flag or step —
  // count them: with both always visible there must be exactly one render site for each label.
  const meetingLabelCount = (modal.match(/Meeting amount \(EGP\)/g) ?? []).length;
  const otherLabelCount = (modal.match(/Other amount \(EGP\)/g) ?? []).length;
  assert.equal(meetingLabelCount, 1, "Meeting amount (EGP) must render from exactly one place");
  assert.equal(otherLabelCount, 1, "Other amount (EGP) must render from exactly one place");

  // The submit payload sends both amounts unconditionally — this was already true before the
  // fix and is what made the hidden-box bug possible. It stays true after the fix too, so pin
  // it: the fix is "always show what you always submit", not "only submit what you show".
  const submitPayload = modal.match(
    /const input: ManagerExpenseAdminInput = \{[\s\S]*?\n {4}\};/,
  )?.[0];
  assert.ok(submitPayload, "the admin modal must build a ManagerExpenseAdminInput submit payload");
  assert.match(
    submitPayload,
    /meetingAmount:\s*meetingAmount \? Number\(meetingAmount\) : 0/,
    "the submit payload must always carry meetingAmount, matching the box that is always shown",
  );
  assert.match(
    submitPayload,
    /otherAmount:\s*otherAmount \? Number\(otherAmount\) : 0/,
    "the submit payload must always carry otherAmount, matching the box that is always shown",
  );
}
