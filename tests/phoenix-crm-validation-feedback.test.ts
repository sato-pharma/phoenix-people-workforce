import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildingRefusalReason,
  parseValidationRefusalReason,
  reasonsFor,
  VALIDATION_REFUSAL_REASON_KEYS,
  VALIDATION_REFUSAL_REASONS,
  validationRefusalLabel,
  validationRefusalRepText,
} from "../src/lib/phoenix-crm/validation-feedback.ts";
import { phoenixCrmChannels } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
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
    [
      "no_signboard",
      "wrong_name",
      "too_dark",
      "not_at_door",
      "photo_of_paper",
      "point_off",
      // The seventh and eighth, the owner's own words on 2026-10-09, about the TIMETABLE inside a
      // polyclinic rather than a signboard.
      "schedule_other_name",
      "schedule_missing",
      // The ninth, the owner's word of 2026-11-07: a clinic customer with only one or two names is
      // sent back for all three.
      "short_name",
    ],
    "nine, closed — a tenth needs the owner's word",
  );
  // 🔴 THE CHECK THAT IS LIVE IS THE NEWEST MIGRATION'S: 20261107195700 DROPS the 20261010013001
  // constraint and recreates it with nine keys. Reading an older file would pass while the database refused
  // the newest reason — which is exactly the shape this assertion exists to catch.
  const reviewMigration = readFileSync("supabase/migrations/20261107195700_phoenix_crm_three_names_at_validation.sql", "utf8");
  const reviewCheck = reviewMigration.slice(reviewMigration.indexOf("add constraint phoenix_crm_validation_reviews_refusal_reason"));
  assert.ok(reviewCheck.length > 0, "the three-names migration recreates the review table's refusal-reason CHECK");
  for (const key of VALIDATION_REFUSAL_REASON_KEYS) {
    assert.ok(reviewCheck.includes(`'${key}'`), `the live SQL CHECK holds ${key}`);
  }
  // The venue's own column carries the closed list a BUILDING is offered, for a polyclinic the
  // administrator rejects — every reason but `short_name`, which is about a customer's name.
  const migration = readFileSync("supabase/migrations/20261010013001_phoenix_crm_shared_places.sql", "utf8");
  const venueCheckAt = migration.indexOf("refusal_reason text check (");
  assert.ok(venueCheckAt > 0, "phoenix_crm_shared_places carries its own refusal_reason CHECK");
  const venueCheck = migration.slice(venueCheckAt, migration.indexOf("retired_at timestamptz", venueCheckAt));
  for (const reason of reasonsFor("building")) {
    assert.ok(venueCheck.includes(`'${reason.key}'`), `phoenix_crm_shared_places.refusal_reason holds ${reason.key}`);
  }
  const buildingKeys = reasonsFor("building").map((reason) => reason.key);
  assert.ok(!buildingKeys.includes("short_name"), "🔴 a building is never refused for a short name — its CHECK does not hold the key");
  assert.equal(buildingRefusalReason("short_name"), null, "and the venue's server refuses it before the database could");
  assert.equal(buildingRefusalReason("no_signboard"), "no_signboard", "a building reason passes");
  const venueServer = stripComments(readFileSync("src/lib/phoenix-crm/server/shared-places.ts", "utf8"));
  assert.ok(venueServer.includes("buildingRefusalReason(body.refusalReason)"), "the venue decision parses through the building list");
  const venueScreen = readFileSync("src/components/phoenix-crm/shared-place-list.tsx", "utf8");
  assert.equal(venueScreen.split(`kind="building"`).length - 1, 2, "the venue row and its bulk bar offer the building list");
  assert.ok(reasonsFor("signboard").some((reason) => reason.key === "short_name"), "a customer's own signboard can be sent back for a short name");
  assert.ok(reasonsFor("schedule").some((reason) => reason.key === "short_name"), "and so can a seated customer's timetable");

  // ── Which of the eight are OFFERED depends on what the photo is ───────────────────────────────
  const signboardKeys = reasonsFor("signboard").map((reason) => reason.key);
  const scheduleKeys = reasonsFor("schedule").map((reason) => reason.key);
  assert.ok(!signboardKeys.includes("schedule_other_name"), "a timetable reason is never offered about a signboard");
  assert.ok(!signboardKeys.includes("schedule_missing"), "nor the other one");
  assert.ok(
    !scheduleKeys.includes("photo_of_paper"),
    "🔴 'a photo of paper, not a building' is NEVER offered on a timetable — a timetable IS paper, so the sentence would send the rep to photograph a building nobody asked him for",
  );
  assert.ok(
    !scheduleKeys.includes("point_off") && !scheduleKeys.includes("not_at_door"),
    "a seated customer has no reading of his own, so neither can honestly be said about his capture",
  );
  assert.ok(scheduleKeys.includes("too_dark"), "the one reason both kinds share: any photo can be unreadable");
  assert.ok(scheduleKeys.length >= 3, "a timetable refusal has something to choose");
  assert.ok(signboardKeys.length >= 6, "and a signboard refusal keeps all six it had");
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

  // ── Told only to the rep; the channels are the guard's ─────────────────────────────────────────
  const notices = stripComments(readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8"));
  const block = notices.slice(notices.indexOf('if (notice.kind === "validation_not_confirmed")'), notices.indexOf('if (notice.kind === "plan_submitted")'));
  assert.ok(!block.includes("inAppOnly"), "since 2026-10-08 (owner, asked about by name) the rep's notice takes the guard's channels: in-app, Telegram and the phone — and no email since 2026-10-13");
  assert.ok(block.includes("phoenix_crm:validation_not_confirmed:${notice.customerId}:${notice.reviewId}"), "one notice per refusal, never a repeat");
  assert.deepEqual(phoenixCrmChannels("validation_not_confirmed"), ["in_app", "telegram", "push"], "and the channel guard gives it in-app, Telegram and the phone, never email (owner, 2026-10-13)");

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
