import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { stripComments } from "./support/comment-strip.ts";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry === ".git") return [];
    if (statSync(full).isDirectory()) return walk(full);
    return [full];
  });
}

export function runUnifiedNotificationsTests() {
  const systemSource = source("src/lib/notifications/system.ts");
  const telegramSource = source("src/lib/notifications/telegram.ts");
  const settingsSource = source("src/lib/notifications/settings.ts");
  const policySource = source("src/lib/notifications/policy.ts");
  const templatesSource = source("src/lib/notifications/templates.ts");
  const inAppSource = source("src/lib/notifications/in-app.ts");
  const bellSource = source("src/components/layout/in-app-notifications-bell.tsx");
  const phase2Migration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605201000_notification_engine_phase2_center.sql");
  const migration = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260605050234_unified_notification_engine_phase1.sql");
  const recipientsSource = source("src/lib/notifications/recipients.ts");
  const configSource = source("src/config/system-settings.ts");

  assert.match(systemSource, /export async function createSystemNotification/, "central notification API must exist");
  assert.match(systemSource, /SystemNotificationChannel = "in_app" \| "email" \| "telegram"/, "engine must support in-app, email, and Telegram");
  assert.match(systemSource, /safeSendNotificationEmail/, "engine must reuse existing email outbox delivery");
  assert.match(systemSource, /sendTelegramNotification/, "engine must be the Telegram caller");
  assert.match(systemSource, /notification_deliveries/, "engine must record per-channel delivery status");
  assert.match(systemSource, /idempotencyKey/, "engine must use per-channel idempotency");
  assert.match(systemSource, /fallbackFrom: "telegram"/, "Telegram failure must fall back through governed channels");
  assert.match(systemSource, /GENERIC_PAYSLIP_MESSAGE/, "payroll Telegram messages must stay generic (redacted via the shared constant)");
  assert.match(systemSource, /resolveNotificationPolicy/, "engine must resolve module/event policy centrally");
  assert.match(systemSource, /resolveNotificationRecipients/, "engine must resolve recipients centrally when not explicit");
  assert.match(systemSource, /renderNotificationTemplate/, "engine must load notification_templates by channel");
  assert.match(systemSource, /quiet_hours_start/, "engine must enforce quiet hours preferences");
  assert.match(systemSource, /module_preferences/, "engine must enforce module-level preferences");
  assert.match(systemSource, /processTelegramDeliveryRetries/, "Telegram retries must be scheduled, not only inline");

  assert.match(telegramSource, /api\.telegram\.org/, "Telegram adapter should be the only raw Telegram API client");
  assert.match(telegramSource, /AbortController/, "Telegram sends must have timeout support");
  assert.match(telegramSource, /Open in Phoenix/, "Telegram messages must have one Phoenix action button");
  assert.doesNotMatch(telegramSource, /approve|reject/i, "Telegram phase 1 must not expose approve/reject actions");

  assert.match(policySource, /marketing_requests\.request_submitted/, "Marketing request submitted policy required");
  assert.match(policySource, /payroll\.payslip_available[\s\S]*telegramGenericOnly:\s*true/, "payroll payslip Telegram policy must be generic only");
  assert.match(policySource, /direct_manager/, "recipient resolver must support direct manager routing");
  assert.match(policySource, /manager_chain/, "recipient resolver must support hierarchy routing");
  assert.match(policySource, /workflow_step_approver/, "recipient resolver must support workflow approvers");
  assert.match(templatesSource, /notification_templates/, "template engine must read notification_templates");
  assert.match(templatesSource, /title_template/, "template engine must support channel title templates");
  assert.match(templatesSource, /message_template/, "template engine must support channel message templates");

  assert.match(settingsSource, /randomBytes\(32\)\.toString\("base64url"\)/, "Telegram connect token must be strong");
  assert.match(settingsSource, /connect_token_hash/, "Telegram token must be stored as a hash");
  assert.match(settingsSource, /used_at/, "Telegram token must be single-use");
  assert.match(settingsSource, /expires_at/, "Telegram token must expire");
  assert.match(settingsSource, /disableTelegramForIdentity/, "deactivation must disable Telegram without deleting history");

  assert.match(migration, /create table if not exists public\.notification_deliveries/i, "delivery table required");
  assert.match(migration, /create table if not exists public\.notification_preferences/i, "preferences table required");
  assert.match(migration, /create table if not exists public\.telegram_connections/i, "Telegram connections table required");
  assert.match(migration, /create table if not exists public\.notification_templates/i, "notification templates table required");
  assert.match(migration, /status text not null[\s\S]*pending[\s\S]*connected[\s\S]*disabled[\s\S]*failed/i, "Telegram status policy required");
  assert.match(migration, /idempotency_key text not null[\s\S]*unique \(idempotency_key\)/i, "delivery idempotency key required");
  assert.match(phase2Migration, /create table if not exists public\.notification_user_states/i, "notification center state table required");
  assert.match(phase2Migration, /read_at/i, "notification center must support read state");
  assert.match(phase2Migration, /archived_at/i, "notification center must preserve optional archive state");

  assert.match(inAppSource, /markInAppNotificationRead/, "notification center must support mark-as-read");
  assert.match(inAppSource, /markAllInAppNotificationsRead/, "notification center must support mark-all-read");
  assert.match(bellSource, /moduleFilter/, "notification center must support module filtering");
  assert.match(bellSource, /unreadCount/, "notification center must show unread count");
  assert.match(bellSource, /priority/, "notification center must display priority");

  assert.match(recipientsSource, /"recruitment"/, "recruitment notifications must be visible in the personal bell");
  assert.match(recipientsSource, /"excuse"/, "excuse notifications must be visible in the personal bell");
  assert.doesNotMatch(source("src/lib/excuses/service.ts"), /"excuse_request"/, "excuse producers must not use hidden category excuse_request");
  assert.match(configSource, /isForceTestingDelivery/, "email testing redirection must be env-controlled via isForceTestingDelivery");

  const migratedProducerFiles = [
    "app/api/payroll/[id]/workflow/route.ts",
    "app/api/payroll/upload/route.ts",
    "app/api/imports/employees/confirm/route.ts",
    "app/api/notifications/birthdays/route.ts",
    "app/api/notifications/contract-renewals/route.ts",
    "src/lib/auth/password-setup.ts",
    "src/lib/contracts/service.ts",
    "src/lib/excuses/service.ts",
    "src/lib/internal-messages/service.ts",
    "src/lib/marketing-requests/service.ts",
    "src/lib/probation/service.ts",
    "src/lib/resignations/service.ts",
    "src/lib/vacation/service.ts",
  ];
  for (const file of migratedProducerFiles) {
    // REC-032: an approval notice reaches createSystemNotification through the one door, raiseApproval.
    assert.match(source(file), /createSystemNotification|raiseApproval\(/, `${file} must route automated notification through createSystemNotification`);
    assert.doesNotMatch(source(file), /from "@\/lib\/notifications\/email"/, `${file} must not import legacy notification email helper directly`);
  }

  const sourceFiles = [
    ...walk(fileURLToPath(new URL("../src", import.meta.url))),
    ...walk(fileURLToPath(new URL("../app", import.meta.url))),
  ].filter((file) => /\.(ts|tsx)$/.test(file));

  const forbidden = sourceFiles
    .map((file) => ({ file: relative(rootPath, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }))
    .filter(({ file }) => !file.startsWith("src/lib/notifications/"))
    .filter(({ file }) => !file.startsWith("app/api/integrations/telegram/"))
    // Actually calling the Telegram HTTP API is forbidden everywhere else, no exceptions.
    .filter(({ file, text }) => /api\.telegram\.org/.test(text) ||
      // Reading TELEGRAM_BOT_TOKEN's presence (not its value, and not calling the API with
      // it) is allowed for src/lib/observability/config-drift.ts's operator-facing drift
      // warning — it only calls the notifications module's own telegramEnvironmentStatus()
      // boolean helper, never touches process.env.TELEGRAM_BOT_TOKEN or the API directly.
      //
      // src/lib/integrations/registry.ts NAMES the variable, as data: the Integrations page (13 Nov 2026)
      // lists which variable holds each outside service's credential. It is pinned below to read no
      // variable at all and to call nothing.
      (/TELEGRAM_BOT_TOKEN/.test(text) &&
        file !== "src/lib/observability/config-drift.ts" &&
        file !== "src/lib/integrations/registry.ts"))
    .map(({ file }) => file);

  assert.deepEqual(forbidden, [], "modules must not call Telegram directly");
  assert.match(
    source("src/lib/observability/config-drift.ts"),
    /telegramEnvironmentStatus/,
    "the one allowed TELEGRAM_BOT_TOKEN mention outside notifications/ must go through the module's own boolean status helper, not a raw env read",
  );
  assert.doesNotMatch(
    stripComments(source("src/lib/integrations/registry.ts")),
    /process\.env|api\.telegram\.org|\bfetch\(|from "@\/lib\/supabase/,
    "the integration registry names variables as data: it reads no variable, calls no service and opens no database",
  );

  const webhookSource = source("app/api/integrations/telegram/webhook/route.ts");
  assert.match(webhookSource, /x-telegram-bot-api-secret-token/i, "Telegram webhook must validate the secret token header");
  assert.match(webhookSource, /linkTelegramConnection/, "Telegram webhook must link through the settings service");
  assert.doesNotMatch(webhookSource, /approve|reject/i, "Telegram webhook must not approve/reject workflow actions");

  // REGRESSION GUARD (owner report, 2026-07-17): the non-templated (general/probation-alert)
  // notification path always greeted with the generic "Dear {Brand} Team," even when the system
  // knew exactly who it was writing to — input.recipientName is set for every single-recipient
  // send (buildChannelEmailInput) but effectiveTemplate()'s greeting never read it. The templated
  // path already resolved a real name correctly; this path did not. "Dear Team," must now only
  // appear when no genuinely custom greeting is configured AND the recipient's name is unknown.
  const emailSource = source("src/lib/notifications/email.ts");
  assert.match(emailSource, /function resolveGreeting\(/, "a dedicated greeting resolver exists for the non-templated path");
  assert.match(emailSource, /if \(isGenericDefault && input\.recipientName\) \{/,
    "the generic default greeting is skipped whenever the recipient's real name is known");
  assert.match(emailSource, /return `Dear \$\{input\.recipientHonorific \?\? ""\}\$\{input\.recipientName\},`/,
    "falls back to a name-addressed greeting, not the generic team greeting");
  assert.match(emailSource, /greeting: resolveGreeting\(input, template\)/,
    "effectiveTemplate must route the greeting through the new resolver");
}
