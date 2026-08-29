/**
 * Mailbox offboarding — the BULK recording path.
 *
 * WHAT THIS FILE PROTECTS. Two rules, and both exist because a bulk action is the one control on
 * this page that can be wrong forty-eight times before anybody notices.
 *
 *   1. **A correction can never be applied in bulk.** `not_applicable` ("there is no mailbox to
 *      revoke") and `reopen` both demand a written reason, and a reason typed once and stamped
 *      across a selection is not a reason — it is a shrug with several people's names on it. Worse,
 *      a licence-style verdict on this register is effectively permanent: `reopen` is the only
 *      correction path a settled row has, so a bulk reopen carrying one shared sentence would
 *      destroy the individual account of why each row moved. The guard is a separate, NARROWER
 *      predicate than `isMailboxStep` for exactly this reason, and the API boundary calls the
 *      narrow one. If a future edit "simplifies" the route to reuse `isMailboxStep`, this fails.
 *
 *   2. **A bulk request is bounded, and the bound is checked BEFORE the database is touched.**
 *      A Supabase client request that times out at 15s still commits, so an unbounded batch is a
 *      way to produce a silent half-applied state that no single response describes. The cap is
 *      asserted here against the real exported function, not against a copy of the number.
 *
 * WHY THESE ASSERTIONS RUN WITHOUT A DATABASE. `recordMailboxOffboardingStepsBulk` normalises its
 * input and enforces the cap before it calls `getSupabaseAdmin()`. That ordering is itself part of
 * what is pinned: if someone moves the client construction above the guard, these tests stop
 * passing rather than quietly starting to need production credentials.
 */

import assert from "node:assert/strict";

import {
  MAILBOX_BULK_MAX,
  isMailboxBulkStep,
  isMailboxStep,
  recordMailboxOffboardingStepsBulk,
} from "../src/lib/mailbox-offboarding/service.ts";

export async function runMailboxBulkRecordingTests(): Promise<void> {
  // ---------------------------------------------------------------------------------------------
  // 1. The three steps an admin actually performs in one pass are bulk-recordable.
  // ---------------------------------------------------------------------------------------------
  for (const step of ["password_reset", "app_passwords_cleared", "disposition"]) {
    assert.equal(
      isMailboxBulkStep(step),
      true,
      `"${step}" is done for a batch of leavers in one visit to the control panel and must be bulk-recordable`,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 2. THE HEADLINE. Corrections are refused in bulk — while remaining valid single-row steps.
  //    Both halves matter: if `isMailboxBulkStep` were simply a typo'd copy that rejected
  //    everything, the first assertion above would catch it; if it were `isMailboxStep` under a
  //    new name, this one does.
  // ---------------------------------------------------------------------------------------------
  for (const correction of ["not_applicable", "reopen"]) {
    assert.equal(
      isMailboxBulkStep(correction),
      false,
      `"${correction}" needs a written reason per person and must NEVER be applicable to a selection`,
    );
    assert.equal(
      isMailboxStep(correction),
      true,
      `"${correction}" must remain a valid SINGLE-row step — the bulk guard narrows, it does not remove`,
    );
  }

  for (const nonsense of ["", "delete_mailbox", "password-reset", null, undefined, 7, {}]) {
    assert.equal(isMailboxBulkStep(nonsense), false, "an unknown value is never a bulk step");
  }

  // ---------------------------------------------------------------------------------------------
  // 3. An empty or blank selection is a no-op that returns BEFORE any database client exists.
  //    Asserted as a plain empty array rather than by watching for a credential error: this repo
  //    may well have service-role credentials in scope, so "it threw" would not prove the guard
  //    ran first. Returning [] can only happen on the early-exit path.
  // ---------------------------------------------------------------------------------------------
  assert.deepEqual(
    await recordMailboxOffboardingStepsBulk({ taskIds: [], step: "password_reset" }, "test-actor"),
    [],
    "an empty selection records nothing and must not open a database client",
  );
  assert.deepEqual(
    await recordMailboxOffboardingStepsBulk({ taskIds: ["", "   "], step: "password_reset" }, "test-actor"),
    [],
    "blank ids are filtered out, leaving an empty selection",
  );

  // ---------------------------------------------------------------------------------------------
  // 4. The cap is real, is enforced before any database work, and names itself in the message.
  // ---------------------------------------------------------------------------------------------
  assert.equal(
    typeof MAILBOX_BULK_MAX === "number" && MAILBOX_BULK_MAX > 0,
    true,
    "the bulk cap must be a positive number",
  );

  const oversized = Array.from({ length: MAILBOX_BULK_MAX + 1 }, (_, index) => `task-${index}`);
  await assert.rejects(
    () => recordMailboxOffboardingStepsBulk({ taskIds: oversized, step: "password_reset" }, "test-actor"),
    (error: unknown) =>
      error instanceof Error && error.message.includes(String(MAILBOX_BULK_MAX)),
    "a selection over the cap is refused before the database is touched, and the message says the limit",
  );

  // Deduplication is deliberately NOT asserted here. A selection that survives the guard proceeds
  // to `getSupabaseAdmin()`, and this repo's `.env.local` points at PRODUCTION — a test that
  // reached a live client would be querying real payroll infrastructure to prove a set operation.
  // The dedupe is one `new Set()` on the first line of the function; the cost of pinning it here
  // is far higher than the risk it covers.
}
