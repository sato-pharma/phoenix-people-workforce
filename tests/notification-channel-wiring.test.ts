import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { resolveWorkflowCcHrIds } from "../src/lib/market-awareness/notifications.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

/**
 * The two gates a module has to pass to reach Telegram, and the CC line the owner asked for.
 *
 * WHY THIS FILE EXISTS. Market Awareness asked for Telegram on every one of its four notifiers and
 * got it on none of them, for three weeks, with nothing failed and nothing logged: it was listed in
 * neither `notifications/policy.ts` (which decides whether a channel is REQUESTED) nor
 * `notifications/telegram-governance.ts` (which decides whether it is ALLOWED), and both default to
 * refuse. Measured on production 2026-09-28 — 10 events since 2026-09-07, 9 in-app, 8 email, 9 push,
 * 0 Telegram.
 *
 * A missing row is indistinguishable from a deliberate one by reading either file, which is exactly
 * why nobody saw it, and repairing one file alone leaves the module just as silent. So the assertion
 * is on BOTH gates at once: that is the shape of the bug, and a test that checked one of them would
 * have gone green over the same three weeks.
 *
 * `telegram-governance.ts` already records this same two-gate miss for `direct_orders` and
 * `attendance`, and `policy.ts` records it for `weekly_plans`. Third time; hence a test.
 */
export function runNotificationChannelWiringTests() {
  // ── Gate 1: the policy table must REQUEST the channel.
  const policy = resolveNotificationPolicy({
    eventType: "market_awareness_decision_pending",
    module: "market_awareness",
  });

  assert.ok(
    policy.channels.includes("email"),
    "market_awareness must request email: this approval chain commits money and the people on it read mail",
  );
  assert.ok(
    policy.channels.includes("telegram"),
    "market_awareness must request telegram — without a policy row it fell through to defaultPolicy, which does not",
  );
  assert.equal(
    policy.telegramAllowed,
    true,
    "defaultPolicy.telegramAllowed is false, so a market_awareness row that forgets this flag is the same silent bug again",
  );

  // ── Gate 2: telegram governance must ALLOW it. Fixing gate 1 alone changes nothing.
  const governance = defaultTelegramPolicyFor("market_awareness");
  assert.equal(
    governance.enabled,
    true,
    "the unknown-module fail-safe disables telegram for any module with no row here — gate 1 cannot override it",
  );
  assert.equal(
    governance.genericOnly,
    false,
    "the activity, area, line and value ARE what an approver decides on; a generic ping cannot be approved or rejected",
  );

  // The fail-safe itself must stay fail-CLOSED. If this ever passes, every future module silently
  // gains full-content Telegram and the two assertions above stop meaning anything.
  assert.equal(
    defaultTelegramPolicyFor("a_module_that_does_not_exist").enabled,
    false,
    "an unlisted module must default to NO telegram — the fail-safe is what makes the rows above load-bearing",
  );

  // ── The CC line: every notice copies the whole workflow (owner rule, 2026-09-28).
  // No cast. `resolveWorkflowCcHrIds` takes only the four fields it reads, so a fixture states
  // exactly those — and a wrong one is a compile error rather than something an `as` swallowed.
  const activity: Parameters<typeof resolveWorkflowCcHrIds>[0] = {
    approvers: [{ assignedHrId: "A-9" }, { assignedHrId: "B-122" }, { assignedHrId: null }],
    decisions: [{ actorHrId: "B-122" }, { actorHrId: "A-12" }],
    managerHrId: "A-2",
    requesterHrId: "B-185",
  };

  const ccForCeo = resolveWorkflowCcHrIds(activity, ["AA"]);
  assert.deepEqual(
    ccForCeo,
    ["B-185", "A-2", "A-9", "B-122", "A-12"],
    "the CEO notice copies the requester, his manager, every approver slot and everyone who has already decided — before this it read To: the CEO, Cc: nobody",
  );

  // The To line is never also the Cc line. Copying a man on his own notice reads as two messages.
  assert.ok(
    !resolveWorkflowCcHrIds(activity, ["A-9"]).includes("A-9"),
    "whoever the notice is addressed to must be excluded from its own cc",
  );
  assert.deepEqual(
    resolveWorkflowCcHrIds(activity, ["B-185", "A-2", "A-9", "B-122", "A-12"]),
    [],
    "when the whole workflow is on the To line the cc is empty, not a duplicate of it",
  );

  // Canonical HR id matching, both directions: the ids arrive in mixed casing from three different
  // tables here, and a case-sensitive compare would copy the same person twice or fail to drop him.
  assert.deepEqual(
    resolveWorkflowCcHrIds(
      { approvers: [{ assignedHrId: "b-185" }], decisions: [], managerHrId: null, requesterHrId: "B-185" },
      [],
    ),
    ["B-185"],
    "one person named twice in two different casings is copied once",
  );
  assert.deepEqual(
    resolveWorkflowCcHrIds(
      { approvers: [], decisions: [], managerHrId: null, requesterHrId: "B-185" },
      ["b-185"],
    ),
    [],
    "the exclusion is canonical too — a lower-cased To line must still drop that person from the cc",
  );

  // A null slot is a vacant approver seat, not a person. It must never reach the address lookup.
  assert.ok(
    !resolveWorkflowCcHrIds(activity, []).includes(null as unknown as string),
    "a vacant approver slot contributes nobody to the cc",
  );
}
