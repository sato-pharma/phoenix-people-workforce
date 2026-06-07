import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runTelegramOperationsTests() {
  const operations = source("src/lib/notifications/telegram-operations.ts");
  const dailyRoute = source("app/api/notifications/daily/route.ts");
  const policy = source("src/lib/notifications/policy.ts");
  const telegram = source("src/lib/notifications/telegram.ts");
  const adminService = source("src/lib/notifications/telegram-admin.ts");

  assert.match(operations, /export async function runTelegramDailyHrDigest/);
  assert.match(operations, /telegramDigestPilotHrIds = \["B-10", "admin-HR"\]/, "daily digest recipients must be explicit pilot HR identities");
  assert.doesNotMatch(operations, /\.in\("role"/, "daily digest must not discover recipients by broad role");
  assert.doesNotMatch(operations, /salary|amount|compensation|resignation/i, "digest content must not include sensitive payroll/resignation/compensation details");
  assert.match(operations, /safeSummaryOnly: true/, "digest metadata must declare safe count-only summary");
  assert.match(operations, /createSystemNotification\(\{/);
  assert.match(operations, /eventType: "daily_hr_digest"/);
  assert.match(operations, /module: "telegram"/);
  assert.match(operations, /channels: \["in_app", "telegram"\]/);
  assert.match(operations, /Telegram daily HR digest skipped because no exact pilot recipient was resolved/);
  assert.match(operations, /failClosed: true/);

  assert.match(dailyRoute, /runTelegramDailyHrDigest/);
  assert.match(dailyRoute, /telegramDigest/);

  assert.match(policy, /"telegram\.daily_hr_digest":[\s\S]*recipientStrategy:\s*\["workflow_step_approver"\]/);
  assert.match(policy, /"telegram\.daily_hr_digest":[\s\S]*telegramAllowed:\s*true/);
  assert.match(policy, /"telegram\.delivery_escalation":[\s\S]*recipientStrategy:\s*\["workflow_step_approver"\]/);
  const digestPolicyLine = policy.split("\n").find((line) => line.includes('"telegram.daily_hr_digest"')) ?? "";
  const escalationPolicyLine = policy.split("\n").find((line) => line.includes('"telegram.delivery_escalation"')) ?? "";
  assert.doesNotMatch(digestPolicyLine, /permission_based/, "digest policy must not broaden by permission fallback");
  assert.doesNotMatch(escalationPolicyLine, /permission_based/, "escalation policy must not broaden by permission fallback");

  assert.match(telegram, /isPhoenixTelegramButtonUrl/);
  assert.match(telegram, /\.filter\(\(button\) => isPhoenixTelegramButtonUrl\(button\.url\)\)/, "Telegram action buttons must be Phoenix-only");

  assert.doesNotMatch(adminService, /select\("id,attempts,last_error,next_attempt_at,recipient_hr_id,recipient_user_id,sent_at,status,updated_at,metadata/, "delivery monitor must not select raw metadata payloads");
  assert.match(adminService, /maskedChatId/);
}
