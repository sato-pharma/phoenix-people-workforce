import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseValidationRefusalReason,
  VALIDATION_REFUSAL_REASON_KEYS,
  VALIDATION_REFUSAL_REASONS,
  validationRefusalLabel,
  validationRefusalRepText,
} from "../src/lib/phoenix-crm/validation-feedback.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — what a rep is told when his signboard photo could not be confirmed (owner,
 * 2026-10-08: "tell the rep why, from a fixed pick-list, worded about his photo, never naming a
 * person"). Measured before it: no path to the rep at all, the mandatory note holding "-" twenty-two
 * times in twenty-four, and 0 of 22 reopened customers validated again after 40.8 hours on average.
 */

/** Words that would tell the rep a PERSON decided, or who. */
const A_PERSON = /\b(admin|super admin|manager|reviewer|rejected by|approved by|refused by|sfe|owner|he |she |they )/i;

export function runPhoenixCrmValidationFeedbackTests(): void {
  // ── The closed list ────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    [...VALIDATION_REFUSAL_REASON_KEYS],
    ["no_signboard", "wrong_name", "too_dark", "not_at_door", "photo_of_paper", "point_off"],
    "six, closed — a seventh needs the owner's word",
  );
  const migration = readFileSync("supabase/migrations/20261008023801_phoenix_crm_validation_refusal_reason.sql", "utf8");
  for (const key of VALIDATION_REFUSAL_REASON_KEYS) {
    assert.ok(migration.includes(`'${key}'`), `the SQL CHECK holds ${key}`);
  }
  for (const reason of VALIDATION_REFUSAL_REASONS) {
    assert.doesNotMatch(reason.rep, A_PERSON, `"${reason.key}" is about the photo, never a person`);
    assert.ok(reason.rep.endsWith("."), "a whole sentence");
  }
  assert.equal(parseValidationRefusalReason("too_dark"), "too_dark");
  assert.equal(parseValidationRefusalReason("<script>"), null, "nothing off the wire is trusted");
  assert.equal(validationRefusalLabel(null), null);
  assert.equal(validationRefusalRepText("unknown"), null, "an unknown key falls back to the system wording");

  // ── Required to refuse, never asked to approve ────────────────────────────────────────────────
  const reviews = stripComments(readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8"));
  assert.ok(reviews.includes("VALIDATION_REASON_REQUIRED"), "a refusal without a reason is refused");
  assert.ok(reviews.includes("refusal_reason"), "and the reason is stored on the review row");
  assert.ok(reviews.includes("tellRepValidateAgain("), "the rep is told");
  assert.ok(reviews.includes("withdrawValidationNotConfirmed("), "and the notice is taken back when the place is restored or approved");

  // ── In-app only, never email or a push to anyone else ─────────────────────────────────────────
  const notices = stripComments(readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8"));
  const block = notices.slice(notices.indexOf('if (notice.kind === "validation_not_confirmed")'), notices.indexOf('if (notice.kind === "plan_submitted")'));
  assert.ok(block.includes("inAppOnly: true"), "the rep's notice is in-app only");
  assert.ok(block.includes("phoenix_crm:validation_not_confirmed:${notice.customerId}:${notice.reviewId}"), "one notice per refusal, never a repeat");
  const guard = readFileSync("src/lib/notifications/phoenix-crm-channel-guard.ts", "utf8");
  assert.ok(guard.includes('"validation_not_confirmed"'), "and the channel guard blocks a push of it");

  // ── The rep's row reads the reason, in place of the generic sentence ──────────────────────────
  const row = stripComments(readFileSync("src/components/phoenix-crm/list-customer.tsx", "utf8"));
  assert.ok(row.includes("validationRefusalRepText(customer.validateAgainReason) ?? LOCATION_NOT_CONFIRMED_TEXT"), "the reason, or the system's own words");
  assert.ok(row.includes("!notConfirmed"), "and never a second 'Not validated yet' note under it");

  // ── Both decision screens use one field ───────────────────────────────────────────────────────
  for (const path of ["src/components/phoenix-crm/validation-review-queue.tsx", "src/components/phoenix-crm/validated-place-list.tsx"]) {
    const screen = readFileSync(path, "utf8");
    assert.ok(screen.includes("<RefusalReasonField"), `${path} offers the closed list`);
    assert.ok(screen.includes("refusalReason"), `${path} posts it`);
  }

  // ── The Super Admin sees who is waiting to be captured again ──────────────────────────────────
  const board = readFileSync("src/components/phoenix-crm/validation-reviews-board.tsx", "utf8");
  assert.ok(board.includes("<ReopenedCustomerList"), "the wait is on his page");
  const list = readFileSync("src/components/phoenix-crm/reopened-customer-list.tsx", "utf8");
  assert.ok(list.indexOf("<CrmCardsOnPhone") < list.indexOf("<CrmTable"), "phone cards first, then the table");
  assert.doesNotMatch(stripComments(list), /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b/, "square, no sideways scroll, no ellipsis");
  console.log("phoenix-crm validation feedback: OK");
}
