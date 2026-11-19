import assert from "node:assert/strict";

import {
  DEFAULT_POLICY_ACKNOWLEDGED,
  notificationPolicySource,
  resolveNotificationPolicy,
} from "../src/lib/notifications/policy.ts";
import { NOTIFICATION_TYPES } from "../src/lib/notifications/notification-types.ts";
import { runResignationSlaDaily } from "../src/lib/resignations/service.ts";
// Loaded up front so a fire-and-forget error row written by the code under test resolves its module
// from the cache and lands inside the stand-in, never after it has been taken down.
import "../src/lib/error-monitor/service.ts";
import { outboundCalls, withPostgrestStandIn, writesTo, writtenRow, type Row, type Seen } from "./support/postgrest-stand-in.ts";

/**
 * THE RESIGNATION REMINDER TAKES THE RESIGNATIONS POLICY (owner, 19 Nov 2026: "fix the resignation
 * reminder's policy").
 *
 * The daily "a resignation is waiting too long for a decision" reminder was sent under the module
 * `resignation` while every other resignation notice — and the policy row — is `resignations`. So the
 * `resignations.*` row (in-app, email, Telegram, push; high priority) never reached it, and its own
 * hand-written channel list (email and push) decided instead. It is now sent under `resignations` with
 * no channel list of its own, so the row decides.
 *
 * Tested by what it DOES: the real `runResignationSlaDaily` runs against the shared in-memory database
 * (tests/support/postgrest-stand-in.ts) with every sending key blanked, and the test reads the notice
 * and the four deliveries it opened. Nothing can leave the machine.
 *
 * What did NOT change, and is pinned here too: the people. The reminder still names its own recipient
 * list (`resignation_sla_reminder`, Super Admin by default, editable on the recipients screen), one
 * notice per person, and nobody else is told.
 */

const SENDING_KEYS = [
  "RESEND_API_KEY",
  "BREVO_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "ONESIGNAL_REST_API_KEY",
  "NEXT_PUBLIC_ONESIGNAL_APP_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "EMAIL_NOTIFICATIONS_ENABLED",
] as const;

async function withoutSendingKeys(body: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = SENDING_KEYS.map((key) => [key, env[key]] as const);
  for (const key of SENDING_KEYS) delete env[key];
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

const DAY_MS = 86_400_000;
const SUPER_ADMIN_HR_ID = "B-10";
const OTHER_PERMISSION_HOLDER_HR_ID = "CEO-1";

function seededTables(): Record<string, Row[]> {
  return {
    app_auth_users: [
      { auth_email: "super.admin@example.test", hr_id: SUPER_ADMIN_HR_ID, is_active: true, line: null, login_id: "b-10", manager_hr_id: null, name: "Super Admin", role: "Super Admin" },
      // Holds every resignations permission, but is not on the reminder's list — must not be told.
      { auth_email: "ceo@example.test", hr_id: OTHER_PERMISSION_HOLDER_HR_ID, is_active: true, line: null, login_id: "ceo-1", manager_hr_id: null, name: "Chief Executive", role: "CEO" },
    ],
    employee_resignations: [
      // Ten days without a decision: past the five-day line, so it is reminded.
      { created_at: new Date(Date.now() - 10 * DAY_MS).toISOString(), effective_date: "2026-12-01", employee_hr_id: "AI-0042", employee_name: "Test Leaver", id: "res-1", status: "submitted" },
      // Two days old: not yet.
      { created_at: new Date(Date.now() - 2 * DAY_MS).toISOString(), effective_date: "2026-12-15", employee_hr_id: "AI-0043", employee_name: "Recent Leaver", id: "res-2", status: "under_review" },
    ],
    employees: [
      { department_id: null, employment_status: "active", full_name: "Super Admin", hr_id: SUPER_ADMIN_HR_ID, line_id: null, manager_hr_id: null, nickname: null, work_email: "super.admin@example.test" },
      { department_id: null, employment_status: "active", full_name: "Chief Executive", hr_id: OTHER_PERMISSION_HOLDER_HR_ID, line_id: null, manager_hr_id: null, nickname: null, work_email: "ceo@example.test" },
    ],
  };
}

function testTheRegistryAndThePolicyAgree() {
  const entry = NOTIFICATION_TYPES.find((type) => type.eventType === "resignation_sla_reminder");
  assert.ok(entry, "the reminder is registered");
  assert.equal(entry.module, "resignations", "the registry lists the reminder under resignations, the module it is sent under");
  assert.equal(notificationPolicySource(entry), "wildcard", "the reminder takes its module's resignations.* row, not the default");
  const policy = resolveNotificationPolicy(entry);
  const resignationsRow = resolveNotificationPolicy({ eventType: "workflow_updated", module: "resignations" });
  assert.deepEqual(policy.channels, resignationsRow.channels, "the reminder's channels are the other resignation notices' channels");
  assert.deepEqual([...policy.channels].sort(), ["email", "in_app", "push", "telegram"], "in-app, email, Telegram and push");
  assert.equal(policy.priority, "high");
  assert.equal(policy.telegramAllowed, true);
  for (const [moduleName, acknowledged] of Object.entries(DEFAULT_POLICY_ACKNOWLEDGED)) {
    assert.ok(!acknowledged.eventTypes.includes("resignation_sla_reminder"), `DEFAULT_POLICY_ACKNOWLEDGED still names the reminder under ${moduleName} — it has a policy row now`);
  }
}

async function testTheReminderIsSentOnTheResignationsChannels() {
  const tables = seededTables();
  let result: { processed: number; errors: number } = { errors: -1, processed: -1 };
  let seen: Seen[] = [];
  await withoutSendingKeys(async () => {
    seen = await withPostgrestStandIn({ tables }, async () => {
      result = await runResignationSlaDaily();
    });
  });

  assert.deepEqual(result, { errors: 0, processed: 1 }, "one overdue resignation, one person on the list: one reminder, no error");

  const notices = (tables.notification_events ?? []).filter((row) => row.event_type === "resignation_sla_reminder");
  assert.equal(notices.length, 1, "one stored notice");
  const [notice] = notices;
  assert.equal(notice.module, "resignations", "the notice is stored under resignations, so the resignations.* row and the people's resignations preferences apply");
  assert.deepEqual(notice.recipients, [SUPER_ADMIN_HR_ID], "addressed to the person on the reminder's list");
  assert.equal(notice.priority, "high");
  assert.equal(notice.category, "general", "on the bell under general, like the other resignation notices");
  assert.match(String((notice.metadata as Row | null)?.message ?? ""), /Test Leaver's resignation \(effective: 2026-12-01\) has been pending 10 days/);

  assert.ok(writesTo(seen, "notification_deliveries").map(writtenRow).length > 0, "the deliveries were written to the stand-in");
  const deliveries = (tables.notification_deliveries ?? []).filter((row) => row.notification_event_id === notice.id);
  const channels = deliveries.map((row) => String(row.channel)).sort();
  assert.deepEqual(
    channels,
    ["email", "in_app", "push", "telegram"],
    `the reminder opened one delivery on each channel of the resignations.* row — it opened ${channels.join(", ") || "none"}`,
  );
  const byChannel = new Map(deliveries.map((row) => [String(row.channel), row] as const));
  assert.equal(byChannel.get("in_app")?.status, "sent", "the bell copy is delivered");
  // Under `resignations` an email must name the employee it is about, or the identity guard refuses
  // it for good. The only thing allowed to stop it here is this test's own switched-off sending.
  assert.equal(
    byChannel.get("email")?.last_error,
    "EMAIL_NOTIFICATIONS_ENABLED is not true.",
    `the email passed every check but the test's switched-off sending — it stopped at: ${String(byChannel.get("email")?.last_error)}`,
  );

  // The people did not change: only the named person was told, never another permission holder.
  const told = new Set(
    (tables.notification_events ?? []).flatMap((row) => (Array.isArray(row.recipients) ? row.recipients.map(String) : [])),
  );
  assert.deepEqual([...told], [SUPER_ADMIN_HR_ID], "nobody but the reminder's own recipient list was told");
  assert.deepEqual(outboundCalls(seen), [], "nothing left the machine");
}

export async function runResignationReminderPolicyTests() {
  testTheRegistryAndThePolicyAgree();
  await testTheReminderIsSentOnTheResignationsChannels();
}
