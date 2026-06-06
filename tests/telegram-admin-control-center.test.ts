import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runTelegramAdminControlCenterTests() {
  const migration = source("supabase/migrations/20260605114952_telegram_admin_control_center.sql");
  const governance = source("src/lib/notifications/telegram-governance.ts");
  const adminService = source("src/lib/notifications/telegram-admin.ts");
  const templateService = source("src/lib/notifications/telegram-templates.ts");
  const telegramService = source("src/lib/notifications/telegram.ts");
  const system = source("src/lib/notifications/system.ts");
  const route = source("app/api/admin/notifications/telegram/route.ts");
  const page = source("app/(admin)/admin/notifications/telegram/page.tsx");
  const component = source("src/components/admin/telegram-admin-control-center.tsx");
  const navigation = source("src/config/system-navigation.ts");
  const accessRegistry = source("src/lib/security/access-registry.ts");
  const settingsPanel = source("src/components/notifications/notification-settings-panel.tsx");

  assert.match(migration, /create table if not exists public\.notification_channel_settings/);
  assert.match(migration, /enabled_globally boolean not null default false/, "global Telegram must default OFF");
  assert.match(migration, /values \('telegram', false/, "seeded Telegram global switch must default OFF");
  assert.match(migration, /create table if not exists public\.notification_module_channel_policies/);
  assert.match(migration, /generic_only boolean not null default false/);
  assert.match(migration, /alter table public\.notification_channel_settings enable row level security/);
  assert.match(migration, /alter table public\.notification_module_channel_policies enable row level security/);
  assert.match(migration, /revoke all on public\.notification_channel_settings from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.notification_channel_settings to service_role/);
  assert.match(migration, /'resignations', 'telegram', false/, "resignations Telegram must be disabled by default");
  assert.match(migration, /'payroll', 'telegram', true, true/, "payroll Telegram must be generic-only");

  assert.match(governance, /getTelegramGlobalEnabled/);
  assert.match(governance, /resolveTelegramGovernance/);
  assert.match(governance, /Telegram is disabled globally/);
  assert.match(governance, /defaultTelegramPolicies/);
  assert.match(governance, /enabled_globally\?: boolean[\s\S]*=== true/, "global Telegram must only enable on explicit true");
  assert.match(governance, /tableMissing\(error\)\) return false/, "missing governance table must fail closed");

  assert.match(system, /resolveTelegramGovernance/);
  assert.match(system, /telegramGovernance\.reason/);
  assert.match(system, /telegramGovernance\.genericOnly/);
  assert.match(system, /retryTelegramDeliveryById/);
  assert.match(system, /Delivery already sent/);
  assert.match(system, /Telegram disabled by user preference/);
  assert.match(system, /connection\?\.status !== "connected" \|\| !connection\.telegram_chat_id/, "disabled or disconnected Telegram accounts must skip delivery");
  assert.match(system, /last_error: "Telegram is not connected\."/);
  assert.match(system, /if \(row\.status === "sent"\) return \{ channel: "telegram", idempotencyKey, reason: "Delivery already sent\.", status: "skipped" \}/, "retry must not duplicate already-sent Telegram deliveries");
  assert.match(system, /if \(!telegramGovernance\.enabled\)[\s\S]*status: "skipped"/, "global OFF or module-disabled Telegram must create skipped delivery records");
  assert.match(system, /Your payslip is available\./);

  assert.match(telegramService, /telegramEnvironmentStatus/);
  assert.match(telegramService, /getTelegramWebhookStatus/);
  assert.match(telegramService, /getWebhookInfo/);
  assert.match(telegramService, /urlMatchesExpected/);
  assert.match(telegramService, /replace\(\/bot\\d\+:\[A-Za-z0-9_-\]\+\/g, "bot\[redacted\]"\)/, "webhook errors must redact bot tokens");

  assert.match(adminService, /maskTelegramChatId/);
  assert.match(adminService, /getTelegramAdminControlCenter/);
  assert.match(adminService, /setTelegramGlobalSwitch/);
  assert.match(adminService, /adminDisableTelegram/);
  assert.match(adminService, /adminDisconnectTelegram/);
  assert.match(adminService, /adminSendTelegramTest/);
  assert.match(adminService, /renderTelegramTemplate/);
  assert.match(adminService, /renderTelegramTemplate\("general_admin_test"/, "admin test must render the editable General Admin Test template");
  assert.match(templateService, /templateKey: "general_admin_test"/, "General Admin Test template must exist in the editable template catalog");
  assert.match(adminService, /recipientUserId = actor\(access\)/, "admin test must target the signed-in admin only");
  assert.match(adminService, /eventType: "telegram_admin_test"/, "admin test must use a system-only test event");
  assert.match(adminService, /idempotencyKey: `telegram-admin-test:\$\{recipientUserId\}:/, "each admin test must create a fresh delivery attempt");
  assert.match(adminService, /title: rendered\.title/, "admin test must use the saved template title");
  assert.match(adminService, /message: rendered\.message/, "admin test must use the saved template message");
  assert.match(adminService, /buttons: rendered\.buttons/, "admin test must pass rendered Telegram buttons into delivery");
  assert.match(adminService, /ctaLabel: rendered\.ctaLabel/);
  assert.match(adminService, /ctaUrl: rendered\.ctaUrl/);
  assert.match(adminService, /templateKey: "general_admin_test"/, "admin test metadata/audit must include the rendered template key");
  assert.match(adminService, /General Admin Test Telegram template is not configured/, "missing template must show an admin-readable error");
  assert.match(adminService, /General Admin Test Telegram template is inactive/, "inactive template must show an admin-readable error");
  assert.doesNotMatch(adminService, /Phoenix Telegram admin test notification\./, "admin test must not use hardcoded Telegram message text");
  assert.doesNotMatch(adminService, /title: "Telegram admin test"/, "admin test title must come from the editable template");
  assert.match(adminService, /adminRetryTelegramDelivery/);
  assert.match(adminService, /createSystemNotification/);
  assert.match(adminService, /retryTelegramDeliveryById/);
  assert.match(adminService, /auditLogs/);
  assert.match(adminService, /connectedCount/);
  assert.match(adminService, /pendingCount/);
  assert.match(adminService, /pilotHealth/);
  assert.match(adminService, /telegramEnvironmentStatus/);
  assert.match(adminService, /getTelegramWebhookStatus/);
  assert.match(adminService, /generalAdminTestTemplateActive/);
  assert.match(adminService, /connectedEnabledUsersCount/);
  assert.match(adminService, /More than one connected user has Telegram enabled/);
  assert.doesNotMatch(adminService, /telegram_chat_id:[\s\S]*TelegramAdminConnection/, "admin view type must not expose raw chat IDs");
  assert.doesNotMatch(adminService, /select\("id,attempts,last_error,next_attempt_at,recipient_hr_id,recipient_user_id,sent_at,status,updated_at,metadata/, "delivery monitor must not select raw delivery metadata payloads");

  assert.match(route, /assertPermission\(access, "communication", action\)/);
  assert.match(route, /getTelegramAdminControlCenter\(access\)/, "admin API refreshes must compute pilot health for the signed-in admin");
  assert.match(route, /body\?\.type === "global_switch"/);
  assert.match(route, /body\?\.type === "module_policy"/);
  assert.match(route, /body\?\.action === "send_test"[\s\S]*adminSendTelegramTest\(access\)/, "route must not accept employee-wide or arbitrary test recipients");
  assert.match(route, /body\?\.action === "retry_delivery"/);
  assert.match(route, /body\?\.action === "disconnect_user"/);
  assert.doesNotMatch(route, /approve|reject/i, "Telegram admin route must not expose workflow decisions");

  assert.match(page, /canAccess\(access, "communication", "read"\)/);
  assert.match(page, /TelegramAdminControlCenter/);
  assert.match(page, /getTelegramAdminControlCenter\(access\)/);
  assert.match(page, /data\.summary\.connectedCount/);
  assert.match(page, /data\.summary\.pendingCount/);
  assert.match(component, /Payload bodies are intentionally hidden/);
  assert.match(component, /Global Kill Switch/);
  assert.match(component, /Production Pilot Health/);
  assert.match(component, /envLabels/);
  assert.match(component, /\["TELEGRAM", "BOT", "TOKEN"\]\.join\("_"\)/);
  assert.match(component, /\["TELEGRAM", "BOT", "USERNAME"\]\.join\("_"\)/);
  assert.match(component, /\["PHOENIX", "APP", "URL"\]\.join\("_"\)/);
  assert.match(component, /\["NOTIFICATION", "WEBHOOK", "SECRET"\]\.join\("_"\)/);
  assert.match(component, /urlMatchesExpected/);
  assert.match(component, /generalAdminTestTemplateActive/);
  assert.match(component, /connectedEnabledUsersCount/);
  assert.doesNotMatch(component, /process\.env/, "client UI must never read or expose raw environment values");
  assert.match(component, /Global Telegram is OFF/);
  assert.match(component, /Connected Users/);
  assert.match(component, /Pending Users/);
  assert.match(component, /Last Telegram Test/);
  assert.match(component, /Recent Telegram Audit Logs/);
  assert.match(component, /Employee-wide tests are not available/);
  assert.match(component, /action: "send_test"/);
  assert.doesNotMatch(component, /action: "send_test", hrId: connection\.hrId, userId: connection\.userId/, "UI must not send per-user Telegram tests");
  assert.match(component, /Generic message only/);
  assert.match(component, /Delivery Monitor/);
  assert.match(component, /maskedChatId/);

  assert.match(navigation, /href: "\/admin\/notifications\/telegram"/);
  assert.match(accessRegistry, /pattern: "\/api\/admin\/notifications\/telegram"[\s\S]*resource: "communication", action: "read"/);
  assert.match(accessRegistry, /pattern: "\/api\/admin\/notifications\/telegram"[\s\S]*resource: "communication", action: "update"/);

  assert.match(settingsPanel, /telegramUsername/);
  assert.match(settingsPanel, /not_connected/);
}
