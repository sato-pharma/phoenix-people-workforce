import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runTelegramOperationsTests() {
  const operations = source("src/lib/notifications/telegram-operations.ts");
  const dailyRoute = source("app/api/cron/daily/_lib/daily-job-runners.ts");
  const policy = source("src/lib/notifications/policy.ts");
  const telegram = source("src/lib/notifications/telegram.ts");
  const adminService = source("src/lib/notifications/telegram-admin.ts");
  const settings = source("src/lib/notifications/settings.ts");

  // ── In-portal connect link: never silently return a null link ──────────────────
  // The employee "Connect Telegram" flow (createTelegramConnectionToken) must resolve
  // the bot username and build the deep link BEFORE writing the pending DB row, and
  // throw a clear error when the link can't be produced — instead of returning a 200
  // with link:null (which surfaced to employees as "unable to produce a Telegram link"
  // and left a dangling pending token row behind).
  const connectFn = settings.slice(settings.indexOf("export async function createTelegramConnectionToken"));
  const connectBody = connectFn.slice(0, connectFn.indexOf("\nexport "));
  assert.match(connectBody, /resolveTelegramBotUsername\(\)/, "connect-token flow must verify the bot is reachable");
  assert.match(connectBody, /const link = await buildTelegramDeepLinkFromToken\(token\)/, "connect-token flow must build the link explicitly");
  assert.match(connectBody, /if \(!link\) \{[\s\S]*throw new Error/, "connect-token flow must throw when the link can't be built");
  // The link must be built/validated before the DB write, so a failed link never leaves a pending row.
  assert.ok(
    connectBody.indexOf("buildTelegramDeepLinkFromToken") < connectBody.indexOf(".from(\"telegram_connections\")"),
    "the connect link must be built before writing the telegram_connections row",
  );
  // The success return must hand back the already-built link, not re-derive a possibly-null one.
  assert.doesNotMatch(connectBody, /link: await buildTelegramDeepLinkFromToken/, "return must reuse the validated link, not rebuild it");

  assert.match(operations, /export async function runTelegramDailyHrDigest/);
  assert.doesNotMatch(operations, /telegramDigestPilotHrIds/, "hardcoded pilot IDs must be replaced by role-based lookup");
  assert.match(operations, /resolveNotificationRoleRecipients\("telegram_daily_hr_digest"\)/, "digest recipients must be resolved by admin-editable role policy, not a hardcoded array");
  assert.match(operations, /\.in\("role", roles\)/, "digest recipients must be resolved by elevated role, not hardcoded IDs");
  assert.doesNotMatch(operations, /"HR Manager"/, "\"HR Manager\" is a job title, not an app_auth_users.role value — it must never appear in a role-array literal");
  assert.doesNotMatch(operations, /salary|amount|compensation|resignation/i, "digest content must not include sensitive payroll/resignation/compensation details");
  assert.match(operations, /safeSummaryOnly: true/, "digest metadata must declare safe count-only summary");
  assert.match(operations, /createSystemNotification\(\{/);
  assert.match(operations, /eventType: "daily_hr_digest"/);
  assert.match(operations, /module: "system"/, "digest must use a module recognized by telegram-governance policies, not the literal string \"telegram\" (which fails closed)");
  assert.match(operations, /channels: \["in_app", "telegram", "push"\]/);
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
