import assert from "node:assert/strict";

import { enforceEarlyBirdsEmailBlock, isEarlyBirdsModule } from "../src/lib/notifications/early-birds-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

// Owner rule (2026-08-09): Early Birds goes to the manager IN-APP and by TELEGRAM. Never email.
//
// Three independent things have to hold, and the module is only as quiet as the weakest one:
//   1. the policy row must not ASK for email
//   2. the guard must strip email even when something else asks for it anyway
//   3. Telegram must be explicitly allowed, or the unknown-module fail-safe disables it and the
//      "two channels" quietly become one

export function runEarlyBirdsEmailBlockTests() {
  // ── 1. The policy row states the intent ─────────────────────────────────────────
  {
    const policy = resolveNotificationPolicy({ module: "early_birds", eventType: "recommendation_pending" });
    assert.equal(
      policy.channels.includes("email"),
      false,
      "the early_birds policy row must not request the email channel",
    );
    assert.equal(policy.channels.includes("telegram"), true, "Telegram is one of the two delivery channels");
    assert.equal(policy.channels.includes("in_app"), true, "in-app is the other");
  }

  // ── 2. The guard is the enforcement, not the policy row ─────────────────────────
  {
    // The policy table is not the last word: an explicit call-site `channels`, the code defaults
    // in resolveBasePolicyChannels, and the Telegram-failure fallback all re-introduce email
    // downstream. The fallback is the live risk here — Telegram failing is the EXPECTED case while
    // managers are unlinked, and it re-enters with exactly ["email","in_app"].
    assert.deepEqual(
      enforceEarlyBirdsEmailBlock(["email", "in_app"], "early_birds"),
      ["in_app"],
      "an Early Birds notification must never be emailed — this is the Telegram-failure fallback shape, the one most likely to fire in practice",
    );
    assert.deepEqual(
      enforceEarlyBirdsEmailBlock(["in_app", "email", "telegram"], "early_birds"),
      ["in_app", "telegram"],
      "email is stripped and the two authorized channels survive",
    );
    assert.deepEqual(enforceEarlyBirdsEmailBlock(["email"], "early_birds"), [], "email-only resolves to NOTHING, never to a send");

    // Module-keyed, so it covers every event type — recommendation, approval, rejection, and the
    // auto-crown notice — including ones nobody has written yet.
    for (const eventType of ["recommendation_pending", "winner_approved", "winner_rejected", "auto_confirmed"]) {
      assert.deepEqual(
        enforceEarlyBirdsEmailBlock(["in_app", "email"], "early_birds"),
        ["in_app"],
        `email must be stripped for ${eventType} too`,
      );
    }

    assert.deepEqual(enforceEarlyBirdsEmailBlock(["in_app", "EMAIL" as never], "EARLY_BIRDS"), ["in_app", "EMAIL"],
      "channel values are compared exactly; only the module match is case-insensitive");
    assert.deepEqual(enforceEarlyBirdsEmailBlock(["in_app", "email"], "  Early_Birds  "), ["in_app"]);

    // Every other module is untouched. A guard that quietly widened would silence real email.
    for (const other of ["marketing_requests", "outstation", "payroll", "vacation", null, undefined]) {
      assert.deepEqual(
        enforceEarlyBirdsEmailBlock(["in_app", "email"], other),
        ["in_app", "email"],
        `${String(other)} must keep its email channel`,
      );
    }

    assert.deepEqual(enforceEarlyBirdsEmailBlock(["in_app", "in_app", "telegram"], "early_birds"), ["in_app", "telegram"]);
  }

  // ── 3. Telegram must be explicitly allowed, or two channels silently become one ──
  {
    const policy = defaultTelegramPolicyFor("early_birds");
    assert.equal(
      policy.enabled,
      true,
      "early_birds needs an explicit Telegram policy — the unknown-module fail-safe disables Telegram, which with email blocked would leave in-app as the ONLY channel",
    );
    assert.equal(
      policy.genericOnly,
      false,
      "a generic 'you have a notification' ping cannot be approved or rejected, which is the whole point of sending it",
    );
  }

  // ── Predicate ───────────────────────────────────────────────────────────────────
  assert.equal(isEarlyBirdsModule("early_birds"), true);
  assert.equal(isEarlyBirdsModule("EARLY_BIRDS"), true);
  assert.equal(isEarlyBirdsModule("early_bird"), false, "the singular is a different string and must not match");
  assert.equal(isEarlyBirdsModule("marketing_requests"), false);
  assert.equal(isEarlyBirdsModule(null), false);
}
