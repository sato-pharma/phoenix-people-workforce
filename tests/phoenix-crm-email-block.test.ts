import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  enforcePhoenixCrmEmailBlock,
  isPhoenixCrmModule,
  PHOENIX_CRM_EMAIL_EVENT_TYPES,
  PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES,
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

/**
 * 🔴 NO EMAIL EXCEPTION REMAINS (owner, 2026-10-13: "make phoenix crm send notifications through telegram and
 * in app only, stop any email firing from phoenix crm"). The guard's allowlist is EMPTY and pinned empty, so
 * adding an exception is a change this test makes visible. These are the event types that once emailed —
 * the plan-edit steps (2026-10-01), a rep's first visit and day start (2026-10-03), the held place
 * (2026-10-05), and every person-to-person step, reminder and nudge (2026-10-08). They are still SENT, so
 * they stay in the set the sender scan below must find, but each now asks for in-app, Telegram and the phone.
 */
const FORMERLY_EMAILED_EVENT_TYPES = [
  "plan_edit_waiting",
  "plan_edit_moved_on",
  "plan_edit_refused",
  "plan_edit_reopened",
  "first_visit_submitted",
  "day_start_confirmed",
  "validation_review_waiting",
  "plan_waiting",
  "plan_approved",
  "plan_returned",
  "monthly_plan_waiting",
  "monthly_plan_approved",
  "monthly_plan_returned",
  "grade_request_waiting",
  "drop_request_waiting",
  "add_request_waiting",
  "restore_request_waiting",
  "request_approved",
  "request_refused",
  "request_returned",
  "request_answered",
  "unplanned_visit_waiting",
  "unplanned_visit_approved",
  "unplanned_visit_refused",
  "unplanned_visit_moved_on",
  "visit_ask_waiting",
  "visit_ask_accepted",
  "visit_ask_declined",
  "plan_reminder",
  "approval_nudge",
  "validation_not_confirmed",
];

/**
 * The ONE notice that emails (owner, 2026-10-17: the Administrator's approval or refusal of a recorded visit, with his
 * comment, "goes email and telegram to the rep and his manager and his manager of manager"). It is sent by the
 * notifier like the others, so the sender scan below must find it, but it is checked on its own: it asks for email.
 */
const EMAILING_EVENT_TYPES = ["recorded_visit_decided"];

const EVENT_TYPES = [
  // The CNS daily forecast (owner, 2026-10-01): the district manager hears it is in — IN-APP ONLY.
  "forecast_sent",
  // The courtesy copy of a rep's ask for a visit (owner, 2026-10-02: "told (in-app)"): the manager above
  // for a chain visit, the rep's district manager for a product manager's. Nothing waits on it.
  "visit_ask_told",
  // A rep's request for a double visit (owner, 2026-10-16). Born in-app, Telegram and phone; never emailed.
  "double_visit_waiting",
  "double_visit_days_changed",
  "double_visit_accepted",
  "double_visit_declined",
  // 🔴 The expiry of a request to edit a week MOVED HERE from the emailing list on 2026-10-02, when
  // the owner was asked directly whether the new daily pass should email as it closes one and chose
  // "in-app and Telegram only, no email". His "only" is enforced on both axes (PUSH_BLOCKED below).
  "plan_edit_expired",
  // The SFE Manager's copy of a rep's day start (owner, 2026-10-03): about 74 a morning is a burial.
  "day_start_seen",
  // The activity mirror (owner, 2026-10-05): every action, to the NSM and SFE Managers — in-app and
  // Telegram only, the module's highest-volume feed to its two widest-scope readers.
  "activity_mirror",
  // The SFE Manager's own copy of a re-send, on the week HE returned (2026-10-08). Informational.
  "plan_resent",
  // The district manager's weekly plan (owner, 2026-10-16) — born after the email ban, so never emailed.
  "manager_plan_waiting",
  "manager_plan_approved",
  "manager_plan_returned",
  "manager_plan_edit_waiting",
  "manager_plan_edit_reopened",
  "manager_plan_edit_refused",
  "manager_plan_edit_expired",
  "manager_list_removal_waiting",
  "manager_list_removal_decided",
  // Every type that once emailed — now ordinary: never email, the phone allowed.
  ...FORMERLY_EMAILED_EVENT_TYPES,
];

/**
 * The notices he has called "in-app and Telegram ONLY": barred from email AND from the phone. The
 * 06:55 digest is the other one and is pinned in its own test — it never comes through the notifier.
 */
const PUSH_BLOCKED_EVENT_TYPES = [
  "plan_edit_expired",
  // The district manager's ask to edit, ended with its week (2026-10-16): the rep's expiry's twin.
  "manager_plan_edit_expired",
  // The SFE Manager's copy of a rep's day start (2026-10-03). On this list rather than merely off the
  // email list because the Telegram-failure fallback re-sends as email, and an unlinked Telegram is
  // the expected case — so "off the email list" alone would mail him once per rep on exactly the days
  // Telegram fails. Here both axes are shut and `phoenixCrmChannels` answers in-app + Telegram.
  "day_start_seen",
  // The activity mirror (2026-10-05): in-app and Telegram only, for the same reason — a high-volume feed
  // to the NSM and SFE whose Telegram is often not linked yet, so a push/email fallback would flood them.
  "activity_mirror",
  // The SFE's copy of a re-send (2026-10-08): on this list for the day_start_seen reason — the
  // Telegram-failure fallback would mail him one per re-send, and the module's emails are the four
  // person-taken plan-edit steps plus a rep's first visit and the held place, nothing else.
  "plan_resent",
];

export function runPhoenixCrmEmailBlockTests() {
  assert.deepEqual(
    [...PHOENIX_CRM_EMAIL_EVENT_TYPES],
    [...EMAILING_EVENT_TYPES],
    "exactly ONE Phoenix CRM notice may email — the Administrator's decision on a recorded visit (owner, 2026-10-17); every other stays email-free since 2026-10-13",
  );
  assert.deepEqual(
    [...PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES].sort(),
    // crm_daily_digest, crm_visit_rollup and crm_fraud_scan are the cron-only notices here — each
    // calls createSystemNotificationForRecipients directly, so none comes through the notifier and
    // none is harvested into EVENT_TYPES; all three are in-app and Telegram only.
    ["crm_daily_digest", "crm_fraud_scan", "crm_visit_rollup", ...PUSH_BLOCKED_EVENT_TYPES].sort(),
    "and exactly these are barred from the phone too — the 06:55 digest, the hourly visit rollup, the weekly fraud scan, the plan-edit expiry, the SFE day-start copy, the activity mirror, and the SFE's copy of a re-send",
  );
  for (const eventType of EVENT_TYPES) {
    const phoneBarred = PUSH_BLOCKED_EVENT_TYPES.includes(eventType);
    assert.deepEqual(phoenixCrmChannels(eventType).includes("email"), false, `${eventType} never asks for email`);
    // The phone since 2026-10-02 (owner): 16 of 74 reps allowed Phoenix push, and Telegram reached none of
    // them — except where he said "in-app and Telegram only", which the call site honours as well as the guard.
    assert.deepEqual(
      phoenixCrmChannels(eventType),
      phoneBarred ? ["in_app", "telegram"] : ["in_app", "telegram", "push"],
      phoneBarred ? `${eventType} goes in-app and by Telegram, never to the phone` : `${eventType} goes in-app, by Telegram and to the phone`,
    );
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
    assert.equal(
      policy.channels.includes("push"),
      !PUSH_BLOCKED_EVENT_TYPES.includes(eventType),
      `the policy row for ${eventType} agrees with the guard about the phone — the row is the intent, the guard the enforcement`,
    );
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
    // The in-app-only exceptions are TWO, and ONLY these two (the rep's validate-again was a third until 2026-10-08): the daily forecast's alert — the owner
    // asked for an in-app alert, and some 26 reps send one every working day — the courtesy a district
    // manager gets when one of his reps asks a product manager for a visit, which waits on nobody
    // (owner's brief, 2026-10-02: "told (in-app)"), and the rep's "validate this customer again"
    // (owner, 2026-10-08: tell the rep why, worded about his photo).
    assert.equal((notify.match(/inAppOnly: true,/g) ?? []).length, 2, "exactly two notices are in-app only (the rep's validate-again joined the other channels on 2026-10-08)");
    const forecastBranch = notify.slice(notify.indexOf('if (notice.kind === "forecast_sent")'), notify.indexOf('if (notice.kind === "unplanned_visit_raised")'));
    assert.match(forecastBranch, /inAppOnly: true,/, "one is the daily forecast's");
    const visitAskBranch = notify.slice(notify.indexOf("async function describeVisitAsk("), notify.indexOf("async function describe(notice"));
    assert.equal((visitAskBranch.match(/inAppOnly: true,/g) ?? []).length, 1, "the other is the visit ask's, once");
    assert.match(
      visitAskBranch,
      /productManager\s+\?\s+\{\s+\.\.\.toldDelivery,[\s\S]*?inAppOnly: true,\s+\}\s+:\s+toldDelivery,/,
      "and it is the copy the rep's district manager is told of a product manager visit — the person asked, and a chain visit's manager above, still get Telegram and the phone",
    );
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
    assert.doesNotMatch(nudge, /"email"/, "the approval nudge never names email itself — it asks the guard");
    // The Super Admin's alert for a place the Google Maps check could not confirm (2026-10-03), which
    // emails him since 2026-10-05. 🔴 IT STILL MUST NOT NAME EMAIL ITSELF: it asks the guard, whose
    // allowlist is the one place the module's exception is declared. A hardcoded `["in_app","email",…]`
    // here would be a second truth — and the one the guard silently overrules, so the day he narrows
    // this notice again it would read as sent and arrive stripped.
    const placeCheck = readFileSync("src/lib/phoenix-crm/server/validation-reviews.ts", "utf8");
    assert.doesNotMatch(placeCheck, /"email"/, "the place-check alert must never name email itself — it asks the guard");
    assert.match(
      placeCheck,
      /channels: phoenixCrmChannels\("validation_review_waiting"\),/,
      "the place-check alert takes its channels from the guard's allowlist, so email cannot drift apart from it",
    );
    const sent = new Set<string>();
    for (const line of `${notify}\n${reminder}\n${nudge}\n${placeCheck}`.split("\n").filter((text) => /^\s*eventType: /.test(text))) {
      for (const match of line.matchAll(/"([a-z_]+)"/g)) sent.add(match[1]);
    }
    assert.deepEqual([...sent].sort(), [...EVENT_TYPES, ...EMAILING_EVENT_TYPES].sort(), "the notices this test checks are exactly the notices the module sends");

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
      // A rep's ask for a visit: raised from the customer's page or a visit's next step, then answered.
      "src/lib/phoenix-crm/server/visit-asks.ts",
      // A rep's request for a double visit (owner, 2026-10-16): raised from the visit, re-dated, answered.
      "src/lib/phoenix-crm/server/double-visit-requests.ts",
      // The district manager's weekly plan (owner, 2026-10-16): sent, decided, an ask to edit it, and an
      // ask to take a customer off his own list. Every notice goes to him or to whoever decides.
      "src/lib/phoenix-crm/server/manager-plans.ts",
      "src/lib/phoenix-crm/server/manager-customers.ts",
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
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", "forecast_sent"), ["in_app"], "the daily forecast alert is still never emailed");
    assert.deepEqual(enforcePhoenixCrmEmailBlock(["email", "in_app"], "phoenix_crm", "plan_waiting"), ["in_app"], "a plan waiting is not emailed — nothing is (owner, 2026-10-13)");
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
    assert.match(system, /enforcePhoenixCrmEmailBlock,\n\s+enforcePhoenixCrmPushBlock,/);
    assert.match(system, /from "@\/lib\/notifications\/phoenix-crm-channel-guard";/);
    const base = /function basePolicyChannels\([^)]*\) \{([\s\S]*?)\n\}/.exec(system);
    assert.ok(base, "system.ts still has basePolicyChannels");
    assert.match(
      base[1],
      /enforcePhoenixCrmEmailBlock\(\w+, input\.module, input\.eventType\)/,
      "basePolicyChannels must run the phoenix_crm email guard — a guard nothing calls blocks nothing",
    );
    // The chain's last line was the EMAIL block until 2026-10-02, when the push block was chained
    // after it for the 06:55 digest (see its own section below). Still the last line, and still the
    // point: nothing downstream of the policy may add a banned channel back.
    assert.match(
      base[1],
      /return enforcePhoenixCrmPushBlock\(\w+, input\.module, input\.eventType\);\s*$/,
      "and must END on the phoenix_crm push guard, so no later step can add the phone back",
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
