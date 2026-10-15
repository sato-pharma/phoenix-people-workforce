#!/usr/bin/env node
// Provision the Phoenix Workforce Telegram bot as a notification channel.
//
// This is the CLI twin of provisionTelegramBot() in
// src/lib/notifications/telegram.ts. It is self-contained (no app imports) so it
// can run in CI or locally when the env vars are present. In production the same
// work is done with one click from /admin/notifications/telegram, which runs on
// the deployment that actually holds the secrets.
//
// Required env: TELEGRAM_BOT_TOKEN, and one of PHOENIX_APP_URL /
// NOTIFICATION_DASHBOARD_URL / NEXT_PUBLIC_APP_URL.
// Recommended:  NOTIFICATION_WEBHOOK_SECRET (protects the webhook).
//
// Usage:
//   node scripts/setup-telegram-bot.mjs          # validate token + set webhook + profile
//   node scripts/setup-telegram-bot.mjs --status # read-only: print getMe + webhook info

import { createHash } from "node:crypto";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "setup-telegram-bot",
  entry: import.meta.url,
  known: ["--status"],
});

const TIMEOUT_MS = Number.parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS ?? "8000", 10) || 8000;

// Mirror telegramWebhookSecretToken() in src/lib/notifications/telegram.ts: Telegram's
// setWebhook secret_token allows only [A-Za-z0-9_-]. Pass a compliant secret through
// untouched, else use its SHA-256 hex so this script registers the SAME token the app's
// inbound validator expects (otherwise the webhook would 403).
function webhookSecretToken() {
  const raw = (process.env.NOTIFICATION_WEBHOOK_SECRET ?? "").trim();
  if (!raw) return "";
  return /^[A-Za-z0-9_-]{1,256}$/.test(raw) ? raw : createHash("sha256").update(raw).digest("hex");
}

function appUrl() {
  return (process.env.PHOENIX_APP_URL || process.env.NOTIFICATION_DASHBOARD_URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function expectedWebhookUrl() {
  const base = appUrl();
  return base ? `${base}/api/integrations/telegram/webhook` : null;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function callTelegram(token, method, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      method: "POST",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const description = String(payload?.description ?? "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
      throw new Error(description || `Telegram ${method} failed with ${response.status}.`);
    }
    return payload?.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) fail("TELEGRAM_BOT_TOKEN is missing. Create the bot with @BotFather, then export the token.");

  const me = await callTelegram(token, "getMe").catch((error) => fail(`Bot token rejected: ${error.message}`));
  console.log(`\n✓ Bot reachable: @${me.username} (id ${me.id})`);

  if (statusOnly) {
    const info = await callTelegram(token, "getWebhookInfo");
    console.log(`  Webhook URL:      ${info.url || "(not set)"}`);
    console.log(`  Pending updates:  ${info.pending_update_count ?? 0}`);
    if (info.last_error_message) console.log(`  Last error:       ${info.last_error_message}`);
    console.log("");
    return;
  }

  const webhookUrl = expectedWebhookUrl();
  if (!webhookUrl) fail("PHOENIX_APP_URL (or NEXT_PUBLIC_APP_URL) is missing; cannot set the webhook.");

  const secret = (process.env.NOTIFICATION_WEBHOOK_SECRET ?? "").trim();
  await callTelegram(token, "setWebhook", {
    // Match the webhook handler and provisionTelegramBot() (src/lib/notifications/telegram.ts),
    // which both read message + edited_message. Re-provisioning via this script must not
    // silently narrow what the bot receives.
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: true,
    max_connections: 40,
    secret_token: webhookSecretToken() || undefined,
    url: webhookUrl,
  });
  console.log(`✓ Webhook set: ${webhookUrl}${secret ? " (secret-protected)" : " (NO secret — set NOTIFICATION_WEBHOOK_SECRET)"}`);

  await callTelegram(token, "setMyCommands", {
    commands: [{ command: "start", description: "Connect & receive Phoenix Workforce notifications" }],
  });
  console.log("✓ /start command registered");

  await callTelegram(token, "setMyShortDescription", { short_description: "Phoenix Workforce notifications center." }).catch(() => {});
  await callTelegram(token, "setMyDescription", {
    description:
      "Receive your Phoenix Workforce HR notifications — approvals, payroll alerts, contracts, leave, and reminders — directly in Telegram. Send /start with your personal Phoenix connect link to link your account.",
  }).catch(() => {});
  console.log("✓ Bot profile published");

  const info = await callTelegram(token, "getWebhookInfo");
  const matches = info.url === webhookUrl;
  console.log(`\n${matches ? "✓ Provisioning complete." : "⚠ Webhook URL does not match expected."} Configured: ${info.url || "(none)"}\n`);
  if (!matches) process.exit(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
