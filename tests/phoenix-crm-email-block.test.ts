import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { enforcePhoenixCrmEmailBlock, isPhoenixCrmModule } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
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
  "request_approved",
  "request_refused",
  "plan_waiting",
  "plan_approved",
  "plan_returned",
  "monthly_plan_waiting",
  "monthly_plan_approved",
  "monthly_plan_returned",
];

export function runPhoenixCrmEmailBlockTests() {
  for (const eventType of EVENT_TYPES) {
    const policy = resolveNotificationPolicy({ module: "phoenix_crm", eventType });
    assert.equal(policy.channels.includes("email"), false, `the phoenix_crm policy for ${eventType} must not request email`);
    assert.equal(policy.channels.includes("telegram"), true, `Telegram is one of the two delivery channels for ${eventType}`);
    assert.equal(policy.channels.includes("in_app"), true, `in-app is the other for ${eventType}`);
  }

  {
    // The notices name their channels explicitly, which bypasses the policy's channel list — so the
    // sender itself must never name email either.
    const notify = readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8");
    assert.doesNotMatch(notify, /"email"/, "the Phoenix CRM notifier must never ask for email");
    assert.equal(
      (notify.match(/channels: \["in_app", "telegram"\],/g) ?? []).length,
      1,
      "every Phoenix CRM notice goes out through one send, in-app and Telegram, and nothing else",
    );
    assert.match(
      notify,
      /export async function notifyPhoenixCrm\(notice: PhoenixCrmNotice, isTest: boolean\): Promise<void> \{\s+if \(isTest\) return;/,
      "a test entry tells nobody: the notifier returns before it describes or sends anything",
    );
    assert.match(notify, /module: PHOENIX_CRM_NOTIFICATION_MODULE,/, "the send carries the module the email guard keys on");
    assert.match(notify, /export const PHOENIX_CRM_NOTIFICATION_MODULE = "phoenix_crm";/);
    assert.match(notify, /category: PHOENIX_CRM_NOTIFICATION_CATEGORY,/);
    assert.match(notify, /export const PHOENIX_CRM_NOTIFICATION_CATEGORY = "phoenix_crm";/);

    const sent = new Set<string>();
    for (const line of notify.split("\n").filter((text) => /^\s*eventType: /.test(text))) {
      for (const match of line.matchAll(/"([a-z_]+)"/g)) sent.add(match[1]);
    }
    assert.deepEqual([...sent].sort(), [...EVENT_TYPES].sort(), "the notices this test checks are exactly the notices the module sends");

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
    for (const file of ["src/lib/phoenix-crm/server/list.ts", "src/lib/phoenix-crm/server/plans.ts", "src/lib/phoenix-crm/server/monthly-plans.ts"]) {
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
        assert.match(call.slice(0, end), /,\s*isTest,?\s*\)$/, `a notice in ${file} must pass the entry's test flag, so a Super Admin try-out tells nobody`);
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
      /return enforcePhoenixCrmEmailBlock\(\w+, input\.module\);\s*$/,
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
