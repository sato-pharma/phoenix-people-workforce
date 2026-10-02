import assert from "node:assert/strict";

import { ApiError, forbiddenError, validationError } from "../src/lib/http/api-errors.ts";
import { isForbiddenError } from "../src/lib/auth/server.ts";
import { TEST_ACCOUNT_SAVE_REFUSAL } from "../src/lib/auth/test-persona.ts";
import { canonicalPersonHrId } from "../src/lib/auth/identity-aliases.ts";

/**
 * TWO PRODUCTION DEFECTS THAT SHARE A SHAPE: a value that looks right to a string test and is not.
 *
 * (1) A 403 THAT BECAME A 500 IN 552 ROUTE FILES. `isForbiddenError` tested only
 *     `message.toLowerCase().startsWith("forbidden:")`. The test-account write guard throws
 *     `forbiddenError(TEST_ACCOUNT_SAVE_REFUSAL)` — an ApiError with status 403 whose message begins
 *     "This is a test account: …". It failed the prefix test, so every route that branches on
 *     `isForbiddenError` fell through to its 500 branch. Measured in production:
 *     `POST /api/notifications/push/register` returned 500 at 02 Oct 2026 19:12:11 Cairo to a real
 *     Firefox user, and logged nothing anywhere, because the route catches its own error (so Next's
 *     onRequestError never fires) and had no logging call of its own.
 *
 *     552 files under `app/api` call `isForbiddenError`; only 132 of them also read `ApiError` or
 *     `toApiError`, so for the other 420 this function IS the whole decision.
 *
 * (2) A NULL hr_id THAT BECAME THE STRING "NULL". `.map((a) => String(a.hr_id)).filter(Boolean)` on
 *     a row whose `hr_id` column is NULL yields the truthy string `"null"`, which `cleanHrId`
 *     upper-cases to `"NULL"`, which is written to `notification_events.employee_hr_id` and rejected
 *     by its FK to `employees(hr_id)`. Production has exactly one such row — the `admin-HR` console
 *     login — so `{resignation_sla_reminder_failed}` fired once per overdue resignation, daily at
 *     06:36 Cairo, SQLSTATE 23503.
 *
 *     🔴 The FK is MATCH SIMPLE and the column is ALREADY nullable, with 2,604 rows holding a
 *     genuine NULL. A real NULL inserts fine. Relaxing the schema would have fixed nothing, because
 *     the value being written was never null — this is the `marketing-approver-hrid-casing-fk` class,
 *     now on its fifth feature, across the 84 FK columns in 52 tables that reference employees(hr_id).
 */
export async function runForbiddenErrorAndNullRecipientTests() {
  // ── (1) THE REFUSAL THE PREFIX TEST MISSED ────────────────────────────────────────────────
  const testAccountRefusal = forbiddenError(TEST_ACCOUNT_SAVE_REFUSAL);
  assert.ok(testAccountRefusal instanceof ApiError, "the guard throws an ApiError, which is what carries the status");
  assert.equal(testAccountRefusal.status, 403, "its status says 403 even though its message does not");
  assert.ok(
    !testAccountRefusal.message.toLowerCase().startsWith("forbidden:"),
    "and its message does NOT start with the prefix — this is the whole defect, so pin it",
  );
  assert.equal(
    isForbiddenError(testAccountRefusal),
    true,
    "a test account's write refusal must read as forbidden, so routes answer 403 and not 500",
  );

  // The prefix branch still has to work: `assertPermission` throws a plain Error with no status.
  assert.equal(
    isForbiddenError(new Error("Forbidden: sales is temporarily locked for the monthly closing.")),
    true,
    "a plain Error whose message starts with the prefix still reads as forbidden",
  );
  assert.equal(isForbiddenError(forbiddenError()), true, "the default forbiddenError() message keeps working");

  // And it must not widen. A 400 or a 500 is not a refusal, and nor is an unrelated throw.
  assert.equal(isForbiddenError(validationError("Pick a month first.")), false, "a 400 is not a 403");
  assert.equal(isForbiddenError(new ApiError(500, "boom", "Forbidden fruit")), false, "a 500 is a fault, whatever it says");
  assert.equal(isForbiddenError(new Error("not allowed")), false, "an ordinary error is not a refusal");
  assert.equal(isForbiddenError(null), false, "null is not a refusal");
  assert.equal(isForbiddenError({ status: 403 }), false, "a plain object is not an Error and must not pass");

  // ── (2) THE RECIPIENT THAT RESOLVED TO "NULL" ────────────────────────────────────────────
  // The exact value the old line produced, kept here as the thing that must never be written.
  assert.equal(String(null).toUpperCase(), "NULL", "this is where the four-character string came from");
  assert.equal(Boolean(String(null)), true, ".filter(Boolean) could never have caught it");

  // The replacement resolves a login with no hr_id through the shared-identity groups instead.
  // admin-HR is a declared alias of B-10 — one person, owner-confirmed — so it canonicalises rather
  // than being written as a literal or dropped.
  assert.equal(canonicalPersonHrId("admin-HR"), "B-10", "the console login resolves to the person behind it");
  assert.equal(canonicalPersonHrId("PHX-1"), "B-10", "so does the other alias");
  assert.equal(canonicalPersonHrId("B-10"), "B-10", "and the canonical id resolves to itself");
  assert.equal(canonicalPersonHrId(null), null, "nothing in, nothing out — never the string 'null'");
  assert.equal(canonicalPersonHrId(""), null, "an empty login is not an id either");

  // Dedupe by person is what stops the owner being notified twice now that admin-HR resolves: both
  // rows collapse to one key. This is the contract resolveRoleRecipientHrIds relies on.
  assert.equal(
    canonicalPersonHrId("admin-HR"),
    canonicalPersonHrId("B-10"),
    "admin-HR and B-10 share one person key, so they share one notification",
  );

  console.log("forbidden-error-and-null-recipient: ok");
}
