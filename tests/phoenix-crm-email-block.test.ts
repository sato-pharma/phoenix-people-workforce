import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  enforcePhoenixCrmEmailBlock,
  isPhoenixCrmModule,
  PHOENIX_CRM_EMAIL_EVENT_TYPES,
  phoenixCrmChannels,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import { isPersonalBellCategory } from "../src/lib/notifications/recipients.ts";
import { defaultTelegramPolicyFor } from "../src/lib/notifications/telegram-governance.ts";

// Owner rule (2026-09-16): Phoenix CRM tells people IN-APP and by TELEGRAM only — a grade or drop
// request waiting for the district manager, a request decided, a weekly OR monthly plan waiting for
// review, a plan approved or returned. Never email. And the Super Admin's try-out entries tell nobody.
//
// Four independent things have to hold, and each notice is only as quiet as the weakest one:
//   1. the policy row must not ASK for email
//   2. the sender must not name email, and must stay silent for test entries
//   3. the guard must strip email even when something else asks for it anyway — the Telegram-failure
//      fallback re-enters with ["email","in_app","push"], and an unlinked manager is the EXPECTED case
//   4. Telegram must be explicitly allowed (or the unknown-module fail-safe disables it), and the
//      category must reach the in-app bell (or the bell stays empty while the audit says "sent")

const EVENT_TYPES = [
  "grade_request_waiting",
  "drop_request_waiting",
  // The rep's flow rebuilt (owner, 2026-09-29): adding a customer met outside the list, and bringing one
  // back from the Archive, go to the district manager too.
  "add_request_waiting",
  "restore_request_waiting",
  "request_approved",
  "request_refused",
  "plan_waiting",
  "plan_approved",
  "plan_returned",
  "monthly_plan_waiting",
  "monthly_plan_approved",
  "monthly_plan_returned",
  // An off-plan visit (owner, 2026-09-26). The first visit in the module that tells anybody at all:
  // it counts in nothing until it is decided, so the manager who must decide it is told and the rep
  // is told each time it moves — which makes it the first place this rule could be broken by accident.
  "unplanned_visit_waiting",
  "unplanned_visit_approved",
  "unplanned_visit_refused",
  "unplanned_visit_moved_on",
  // The CNS daily forecast (owner, 2026-10-01): the district manager hears it is in — IN-APP ONLY.
  "forecast_sent",
  // "Your coming week is not sent" (owner, 2026-10-02): the rep and his district manager, never by email.
  "plan_reminder",
  // The daily nudge to a slow approver (owner, 2026-10-02): the district manager or SFE, never by email.
  "approval_nudge",
];

/**
 * 🔴 THE ONE EXCEPTION, BY THE OWNER'S OWN ORDER (2026-10-01): a rep's request to edit a week he already
 * sent runs the district manager → SFE → HR, "with emails, in-app and Telegram for every step". These
 * five, and ONLY these five, keep their email — the list is pinned exactly, so widening it is a change
 * this test makes visible rather than one that slips through.
 */
const EMAIL_EVENT_TYPES = ["plan_edit_waiting", "plan_edit_moved_on", "plan_edit_refused", "plan_edit_reopened", "plan_edit_expired"];

export function runPhoenixCrmEmailBlockTests() {
  assert.deepEqual([...PHOENIX_CRM_EMAIL_EVENT_TYPES].sort(), [...EMAIL_EVENT_TYPES].sort(), "exactly the five steps of a plan edit may email");
  for (const eventType of EMAIL_EVENT_TYPES) {
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType });
    for (const channel of ["in_app", "email", "telegram"] as const) {
      assert.equal(policy.channels.includes(channel), true, `the plan-edit step ${eventType} goes by ${channel} (owner, 2026-10-01)`);
    }
    assert.deepEqual(phoenixCrmChannels(eventType), ["in_app", "email", "telegram", "push"], `${eventType} asks for email, in-app, Telegram and the phone`);
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm", eventType),
      ["in_app", "email", "telegram"],
      `the guard lets ${eventType} keep its email`,
    );
  }
  for (const eventType of EVENT_TYPES) {
    assert.deepEqual(phoenixCrmChannels(eventType).includes("email"), false, `${eventType} never asks for email`);
    // The phone since 2026-10-02 (owner): 16 of 74 reps allowed Phoenix push, and Telegram reached none of them.
    assert.deepEqual(phoenixCrmChannels(eventType), ["in_app", "telegram", "push"], `${eventType} goes in-app, by Telegram and to the phone`);
    assert.deepEqual(phoenixCrmChannels(eventType, true), ["in_app"], `a test entry for ${eventType} stays in the app`);
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm", eventType),
      ["in_app", "telegram"],
      `the guard strips email from ${eventType} even when something asks for it`,
    );
  }
  for (const eventType of EVENT_TYPES) {
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType });
    assert.equal(policy.channels.includes("email"), false, `the phoenix_crm policy for ${eventType} must not request email`);
    assert.equal(policy.channels.includes("telegram"), true, `Telegram is one of the two delivery channels for ${eventType}`);
    assert.equal(policy.channels.includes("in_app"), true, `in-app is the other for ${eventType}`);
    assert.equal(policy.channels.includes("push"), true, `and the phone for ${eventType} (owner, 2026-10-02)`);
  }

  {
    // The notices name their channels explicitly, which bypasses the policy's channel list — so the
    // sender itself must never name email either.
    const notify = readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8");
    // The notifier names NO channel itself: the guard's own allowlist answers for each event type, so the
    // one exception the owner ordered cannot be widened from here.
    assert.doesNotMatch(notify, /"email"/, "the Phoenix CRM notifier must never ask for email itself");
    assert.equal(
      (notify.match(/channels: phoenixCrmChannels\(delivery\.eventType, delivery\.inAppOnly\),/g) ?? []).length,
      1,
      "every Phoenix CRM notice goes out through one send, its channels named by the guard's allowlist, and nothing else",
    );
    // The in-app-only exception is the daily forecast's alert, and ONLY that one: the owner asked for an
    // in-app alert, and some 26 reps send one every working day.
    assert.equal((notify.match(/inAppOnly: true,/g) ?? []).length, 1, "exactly one notice is in-app only");
    const forecastBranch = notify.slice(notify.indexOf('if (notice.kind === "forecast_sent")'), notify.indexOf('if (notice.kind === "unplanned_visit_raised")'));
    assert.match(forecastBranch, /inAppOnly: true,/, "and it is the daily forecast's");
    assert.match(
      forecastBranch,
      /idempotencyKey: `phoenix_crm:forecast:\$\{notice\.seat\.seatId\}:\$\{notice\.day\}:sent`,/,
      "one alert per territory and day — a corrected re-send updates it rather than adding a second",
    );
    assert.match(forecastBranch, /const reviewer = territoryReviewer\(notice\.org, notice\.seat\.seatId\);/, "it goes to the territory's reviewing manager, his district manager");
    assert.match(
      notify,
      /\.\.\.\(delivery\.inAppOnly \? \{\} : \{ telegram: /,
      "an in-app-only notice carries no Telegram call to action either",
    );
    // The test world used to tell nobody at all. Since 2026-09-28 (owner) it tells the TEST accounts
    // — and the email ban has to survive that, because the test branch is a SECOND send. It does so
    // twice over: the branch names in-app alone, and the module guard still keys on the module above.
    assert.match(
      notify,
      /const mirrors = await testAccountsMirroring\(delivery\.recipients\);/,
      "a test entry is routed to the TEST- logins that mirror its recipients, never to the recipients themselves",
    );
    assert.equal(
      (notify.match(/channels: \["in_app"\],/g) ?? []).length,
      1,
      "the test branch asks for in-app ALONE: her Telegram chat, her push subscription and her email are hers",
    );
    assert.match(notify, /module: PHOENIX_CRM_NOTIFICATION_MODULE,/, "the send carries the module the email guard keys on");
    assert.match(notify, /export const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";/);
    assert.match(notify, /category: PHOENIX_CRM_NOTIFICATION_CATEGORY,/);
    assert.match(notify, /export const PHOENIX_CRM_NOTIFICATION_CATEGORY = "phoenix_crm";/);

    // The notifier, and the two other senders of the module that name their event outright: the coming
    // week's reminder and the daily nudge to a slow approver (owner, 2026-10-02). The 06:55 digest is
    // pinned in its own test.
    const reminder = readFileSync("src/lib/phoenix-crm/server/plan-reminder.ts", "utf8");
    const nudge = readFileSync("src/lib/phoenix-crm/server/approval-nudge.ts", "utf8");
    assert.doesNotMatch(nudge, /"email"/, "the approval nudge never names email");
    const sent = new Set<string>();
    for (const line of `${notify}\n${reminder}\n${nudge}`.split("\n").filter((text) => /^\s*eventType: /.test(text))) {
      for (const match of line.matchAll(/"([a-z_]+)"/g)) sent.add(match[1]);
    }
    assert.deepEqual([...sent].sort(), [...EVENT_TYPES, ...EMAIL_EVENT_TYPES].sort(), "the notices this test checks are exactly the notices the module sends");

    // Every notice opens a tab the page really has, on a page that exists.
    const app = readFileSync("src/components/phoenix-crm/phoenix-crm-app.tsx", "utf8");
    const tabList = /const TAB_ORDER[^=]*=\s*\[([^\]]+)\]/.exec(app);
    assert.ok(tabList, "the Phoenix CRM app declares its tabs in TAB_ORDER");
    const tabs = new Set([...tabList[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]));
    const opened = [...notify.matchAll(/\btab: "([a-z]+)"/g)].map((match) => match[1]);
    assert.ok(opened.length >= 3, "the notices open the team, list and plan tabs");
    for (const tab of opened) assert.ok(tabs.has(tab), `a notice opens the "${tab}" tab, which the Phoenix CRM app does not have`);
    assert.match(notify, /export const PHOENIX_CRM_PORTAL_PATH = "\/employee-portals\/field-crm";/);
    assert.ok(existsSync("app/employee-portals/field-crm/page.tsx"), "a notice's link opens a page that exists");

    // Every place that notifies passes the entry's test flag through — never a literal.
    for (const file of [
      "src/lib/phoenix-crm/server/list.ts",
      "src/lib/phoenix-crm/server/plans.ts",
      "src/lib/phoenix-crm/server/monthly-plans.ts",
      // The off-plan visit: raised from the save, decided from the queue.
      "src/lib/phoenix-crm/server/visits.ts",
      "src/lib/phoenix-crm/server/unplanned.ts",
      // The daily forecast's alert, from the save.
      "src/lib/phoenix-crm/server/daily-forecast.ts",
      // A request to edit a sent week: raised by the rep, then each step (owner, 2026-10-01).
      "src/lib/phoenix-crm/server/plan-edits.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      const calls = source.split("notifyPhoenixCrm(").slice(1);
      assert.ok(calls.length > 0, `${file} notifies`);
      for (const call of calls) {
        let depth = 1;
        let end = 0;
        while (end < call.length && depth > 0) {
          if (call[end] === "(") depth += 1;
          else if (call[end] === ")") depth -= 1;
          end += 1;
        }
        assert.match(call.slice(0, end), /,\s*isTest,?\s*\)$/, `a notice in ${file} must pass the entry's test flag, or a test entry would be sent as a real one`);
      }
    }
  }

  {
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["email", "in_app", "push"], "phoenix_crm"),
      ["in_app", "push"],
      "a Phoenix CRM notice is never emailed — this is the Telegram-failure fallback's shape",
    );
    assert.deepEqual(
      enforcePhoenixCrmEmailBlock(["in_app", "email", "telegram"], "phoenix_crm"),
      ["in_app", "telegram"],
      "email is stripped and the two authorized channels survive",
    );
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["email"], "phoenix_crm"), [], "email-only resolves to NOTHING");
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", "plan_waiting"), ["in_app"], "a plan waiting is still never emailed");
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", null), ["in_app"], "no event type, no exception");
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["in_app", "email", "in_app"], " Phoenix_CRM "), ["in_app"], "the module string is read loosely and channels are deduplicated");

    // Other modules keep their own rules; a guard that widened would silence them.
    for (const other of ["crm", "crm_native_visits", "weekly_plans", "attendance_digest", "payroll", null, undefined]) {
      assert.deepEqual(
        enforcePhoenixCrmEmailBlock(["in_app", "email"], other),
        ["in_app", "email"],
        `${String(other)} must be left alone by the phoenix_crm guard`,
      );
    }
  }

  {
    // The guard is only enforcement if the delivery path actually calls it, and it must run last so
    // no later step can add email back.
    const system = readFileSync("src/lib/notifications/system.ts", "utf8");
    assert.match(system, /import \{ enforcePhoenixCrmEmailBlock \} from "@\/lib\/notifications\/phoenix-crm-channel-guard";/);
    const base = /function basePolicyChannels\([^)]*\) \{([\s\S]*?)\n\}/.exec(system);
    assert.ok(base, "system.ts still has basePolicyChannels");
    assert.match(
      base[1],
      /return enforcePhoenixCrmEmailBlock\(\w+, input\.module, input\.eventType\);\s*$/,
      "basePolicyChannels must END by running the phoenix_crm guard — a guard nothing calls blocks nothing",
    );
  }

  {
    const policy = defaultTelegramPolicyFor("phoenix_crm");
    assert.equal(
      policy.enabled,
      true,
      "phoenix_crm needs an explicit Telegram policy — with email blocked, the unknown-module fail-safe would leave in-app as the ONLY channel",
    );
    assert.equal(policy.genericOnly, false, "a generic ping does not tell a manager which customer or week is waiting");
  }

  assert.equal(isPersonalBellCategory("phoenix_crm"), true, "Phoenix CRM notices reach the in-app bell");
  assert.equal(isPhoenixCrmModule("phoenix_crm"), true);
  assert.equal(isPhoenixCrmModule("crm"), false, "the iReports360 CRM module is a different module");
  assert.equal(isPhoenixCrmModule("crm_native_visits"), false, "the old pilot is a different module");
  assert.equal(isPhoenixCrmModule(null), false);
}
