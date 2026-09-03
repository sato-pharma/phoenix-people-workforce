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
 * production reality: six live rep-submitted requests carry a real meeting or "other" amount
 * on an expense_type of "traveling" (e.g. #45 "BRM for delta 1 team7" meeting 627.20, #114
 * parking 20.00 on 2026-09-02). Zeroing whichever amount doesn't match the selected type would
 * have been the wrong fix — it would silently drop real money from every one of those trips.
 *
 * The rep-facing mobile-outstation-wizard is now pinned to the same rule, and this file's
 * earlier claim that it "never gated them either" was wrong: it carried BOTH shapes at once.
 * The gated pair came first (1a9d4b482, 2026-06-11) and an always-visible pair landed four days
 * later in ec2a5dded ("expense report fields, rescued from #129") without removing it, so the
 * two sat on one screen bound to the same meetingAmount / otherAmount state — on a Meeting trip
 * the rep saw "Meeting Amount" stacked above "Meeting Amount (EGP)", mirroring each other as he
 * typed. The gated pair is the one that went, leaving both screens on one rule: always show
 * what you always submit.
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

  // ── The rep-facing wizard, on the same rule ────────────────────────────────────
  // The wizard is where the reps actually file, and it carried the same expenseType gate on a
  // duplicate pair of these inputs. Same assertions, same reasoning: an amount that is always
  // submitted must always be visible.
  const wizard = readSource("../src/components/outstation/mobile-outstation-wizard.tsx");

  assert.doesNotMatch(
    wizard,
    /expenseType === "meeting" \? \(/,
    "the wizard's Meeting Amount field must not be conditionally rendered on expenseType — a " +
      'rep on a "traveling" trip must still be able to record a real meeting cost, and one ' +
      "typed under another type must never be hidden while it is still submitted",
  );
  assert.doesNotMatch(
    wizard,
    /expenseType === "other" \? \(/,
    "the wizard's Other Amount field must not be conditionally rendered on expenseType — a rep " +
      'on a "traveling" trip must still be able to record a real parking cost, and one typed ' +
      "under another type must never be hidden while it is still submitted",
  );

  // Both fields must still exist, unconditionally, driven by their own state.
  assert.match(
    wizard,
    /<Field label="Meeting Amount \(EGP\)">[\s\S]{0,240}?onChange=\{\(event\) => setMeetingAmount\(event\.target\.value\)\}/,
    "the wizard must render a Meeting Amount input bound to setMeetingAmount",
  );
  assert.match(
    wizard,
    /<Field label="Other Amount \(EGP\)">[\s\S]{0,240}?onChange=\{\(event\) => setOtherAmount\(event\.target\.value\)\}/,
    "the wizard must render an Other Amount input bound to setOtherAmount",
  );

  // Exactly one render site each. This is the assertion that catches the shape that was actually
  // wrong here: not a missing field, but the SAME field twice on one screen — an always-visible
  // pair and an expenseType-gated pair, both bound to the same state, mirroring each other as
  // the rep typed.
  const wizardMeetingSites = (wizard.match(/onChange=\{\(event\) => setMeetingAmount\(/g) ?? []).length;
  const wizardOtherSites = (wizard.match(/onChange=\{\(event\) => setOtherAmount\(/g) ?? []).length;
  assert.equal(
    wizardMeetingSites,
    1,
    `the wizard must bind setMeetingAmount from exactly one input — found ${wizardMeetingSites}; two means the rep sees the same amount twice`,
  );
  assert.equal(
    wizardOtherSites,
    1,
    `the wizard must bind setOtherAmount from exactly one input — found ${wizardOtherSites}; two means the rep sees the same amount twice`,
  );

  // And the wizard submits both amounts unconditionally too, on both of its write paths (the
  // online submit and the offline draft), so "always show what you always submit" holds here in
  // the same direction it does in the modal.
  const wizardMeetingSubmits = (wizard.match(/meetingAmount: Number\(meetingAmount \|\| 0\)/g) ?? []).length;
  const wizardOtherSubmits = (wizard.match(/otherAmount: Number\(otherAmount \|\| 0\)/g) ?? []).length;
  assert.equal(
    wizardMeetingSubmits,
    2,
    `both wizard write paths must carry meetingAmount unconditionally — found ${wizardMeetingSubmits} of 2`,
  );
  assert.equal(
    wizardOtherSubmits,
    2,
    `both wizard write paths must carry otherAmount unconditionally — found ${wizardOtherSubmits} of 2`,
  );
}
