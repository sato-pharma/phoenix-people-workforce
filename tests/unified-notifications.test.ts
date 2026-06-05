import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

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
  const migration = source("supabase/migrations/20260605050234_unified_notification_engine_phase1.sql");
  const recipientsSource = source("src/lib/notifications/recipients.ts");
  const configSource = source("src/config/system-settings.ts");

  assert.match(systemSource, /export async function createSystemNotification/, "central notification API must exist");
  assert.match(systemSource, /SystemNotificationChannel = "in_app" \| "email" \| "telegram"/, "engine must support in-app, email, and Telegram");
  assert.match(systemSource, /safeSendNotificationEmail/, "engine must reuse existing email outbox delivery");
  assert.match(systemSource, /sendTelegramNotification/, "engine must be the Telegram caller");
  assert.match(systemSource, /notification_deliveries/, "engine must record per-channel delivery status");
  assert.match(systemSource, /idempotencyKey/, "engine must use per-channel idempotency");
  assert.match(systemSource, /fallbackFrom: "telegram"/, "Telegram failure must fall back through governed channels");
  assert.match(systemSource, /Your payslip is available\./, "payroll Telegram messages must stay generic");

  assert.match(telegramSource, /api\.telegram\.org/, "Telegram adapter should be the only raw Telegram API client");
  assert.match(telegramSource, /Open in Phoenix/, "Telegram messages must have one Phoenix action button");
  assert.doesNotMatch(telegramSource, /approve|reject/i, "Telegram phase 1 must not expose approve/reject actions");

  assert.match(settingsSource, /randomBytes\(32\)\.toString\("base64url"\)/, "Telegram connect token must be strong");
  assert.match(settingsSource, /connect_token_hash/, "Telegram token must be stored as a hash");
  assert.match(settingsSource, /used_at/, "Telegram token must be single-use");
  assert.match(settingsSource, /expires_at/, "Telegram token must expire");

  assert.match(migration, /create table if not exists public\.notification_deliveries/i, "delivery table required");
  assert.match(migration, /create table if not exists public\.notification_preferences/i, "preferences table required");
  assert.match(migration, /create table if not exists public\.telegram_connections/i, "Telegram connections table required");
  assert.match(migration, /create table if not exists public\.notification_templates/i, "notification templates table required");
  assert.match(migration, /status text not null[\s\S]*pending[\s\S]*connected[\s\S]*disabled[\s\S]*failed/i, "Telegram status policy required");
  assert.match(migration, /idempotency_key text not null[\s\S]*unique \(idempotency_key\)/i, "delivery idempotency key required");

  assert.match(recipientsSource, /"recruitment"/, "recruitment notifications must be visible in the personal bell");
  assert.match(recipientsSource, /"excuse"/, "excuse notifications must be visible in the personal bell");
  assert.doesNotMatch(source("src/lib/excuses/service.ts"), /"excuse_request"/, "excuse producers must not use hidden category excuse_request");
  assert.match(configSource, /forceTestingDelivery:\s*true/, "email testing redirection must remain hard-coded on");

  const sourceFiles = [
    ...walk(fileURLToPath(new URL("../src", import.meta.url))),
    ...walk(fileURLToPath(new URL("../app", import.meta.url))),
  ].filter((file) => /\.(ts|tsx)$/.test(file));

  const forbidden = sourceFiles
    .map((file) => ({ file, text: readFileSync(file, "utf8") }))
    .filter(({ file }) => !relative(rootPath, file).replace(/\\/g, "/").startsWith("src/lib/notifications/"))
    .filter(({ file }) => !relative(rootPath, file).replace(/\\/g, "/").startsWith("app/api/integrations/telegram/"))
    .filter(({ text }) => /api\.telegram\.org|TELEGRAM_BOT_TOKEN/.test(text))
    .map(({ file }) => relative(rootPath, file).replace(/\\/g, "/"));

  assert.deepEqual(forbidden, [], "modules must not call Telegram directly");

  const webhookSource = source("app/api/integrations/telegram/webhook/route.ts");
  assert.match(webhookSource, /x-telegram-bot-api-secret-token/i, "Telegram webhook must validate the secret token header");
  assert.match(webhookSource, /linkTelegramConnection/, "Telegram webhook must link through the settings service");
  assert.doesNotMatch(webhookSource, /approve|reject/i, "Telegram webhook must not approve/reject workflow actions");
}
