#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

function resolveValue(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function detectLegacyAlternatives() {
  const legacyMap = [
    { used: ["APP_URL", "NEXT_PUBLIC_APP_URL"], legacy: ["APP_URL", "NEXT_PUBLIC_APP_URL"] },
    { used: ["NEXT_PUBLIC_SUPABASE_URL"], legacy: ["SUPABASE_URL"] },
    { used: ["NEXT_PUBLIC_SUPABASE_ANON_KEY"], legacy: ["SUPABASE_ANON_KEY"] },
    { used: ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"], legacy: ["SUPABASE_PUBLISHABLE_KEY"] },
    { used: ["SUPABASE_SERVICE_ROLE_KEY"], legacy: ["PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"] },
    { used: ["SUPABASE_PROJECT_ID", "SUPABASE_PROJECT_REF"], legacy: ["SUPABASE_PROJECT_REF", "SUPABASE_PROJECT_ID"] },
  ];

  const warnings = [];
  for (const entry of legacyMap) {
    const primaryNames = entry.used;
    const legacyNames = entry.legacy;
    const isUsingPrimary = primaryNames.some((name) => process.env[name]?.trim());
    const legacyPresent = legacyNames.some((name) => process.env[name]?.trim());

    if (!isUsingPrimary && legacyPresent) {
      warnings.push(`legacy values detected but not used: ${legacyNames.join(", ")}`);
    }
  }

  return warnings;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

// Hoisted out of main() and exported (2026-08-08) so validate-railway-production-secrets.mjs
// can compare Railway's live variable list against this one, without duplicating ~50 names in
// a second file — a second copy is exactly the kind of drift that let 27 variables go unsynced
// and unnoticed for weeks.
const variables = [
    { railway: "APP_URL", github: ["APP_URL", "NEXT_PUBLIC_APP_URL"], required: true },
    { railway: "NEXT_PUBLIC_APP_URL", github: ["NEXT_PUBLIC_APP_URL", "APP_URL"], required: true },
    { railway: "NEXT_PUBLIC_SUPABASE_URL", github: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"], required: true },
    { railway: "NEXT_PUBLIC_SUPABASE_ANON_KEY", github: ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"], required: true },
    { railway: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", github: ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY"], required: true },
    { railway: "SUPABASE_SERVICE_ROLE_KEY", github: ["SUPABASE_SERVICE_ROLE_KEY", "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"], required: true },
    { railway: "SUPABASE_PROJECT_ID", github: ["SUPABASE_PROJECT_ID", "SUPABASE_PROJECT_REF"], required: true },
    { railway: "SUPABASE_PROJECT_REF", github: ["SUPABASE_PROJECT_REF", "SUPABASE_PROJECT_ID"], required: true },
    { railway: "PHOENIX_AUTH_SECRET", github: ["PHOENIX_AUTH_SECRET"], required: true },
    { railway: "RESEND_API_KEY", github: ["RESEND_API_KEY"], required: true },
    { railway: "RESEND_WEBHOOK_SECRET", github: ["RESEND_WEBHOOK_SECRET"], required: true },
    { railway: "OPENAI_API_KEY", github: ["OPENAI_API_KEY"], required: true },
    { railway: "TELEGRAM_BOT_TOKEN", github: ["TELEGRAM_BOT_TOKEN"], required: true },
    { railway: "NOTIFICATION_WEBHOOK_SECRET", github: ["NOTIFICATION_WEBHOOK_SECRET"], required: true },
    { railway: "CRON_SECRET", github: ["CRON_SECRET"], required: true },
    { railway: "ATTENDANCE_AGENT_TOKEN", github: ["ATTENDANCE_AGENT_TOKEN"], required: true },
    { railway: "NOTIFICATION_DASHBOARD_URL", github: ["NOTIFICATION_DASHBOARD_URL"], required: false },
    { railway: "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", github: ["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY"], required: false },
    { railway: "GOOGLE_MAPS_SERVER_KEY", github: ["GOOGLE_MAPS_SERVER_KEY"], required: false },
    { railway: "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID", github: ["NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID"], required: false },
    { railway: "GOOGLE_CALENDAR_API_KEY", github: ["GOOGLE_CALENDAR_API_KEY"], required: false },
    { railway: "GOOGLE_HOLIDAY_CALENDAR_ID_EG", github: ["GOOGLE_HOLIDAY_CALENDAR_ID_EG"], required: false },
    { railway: "LOCATIONIQ_API_KEY", github: ["LOCATIONIQ_API_KEY"], required: false },
    { railway: "NEXT_PUBLIC_ONESIGNAL_APP_ID", github: ["NEXT_PUBLIC_ONESIGNAL_APP_ID"], required: false },
    { railway: "ONESIGNAL_REST_API_KEY", github: ["ONESIGNAL_REST_API_KEY"], required: false },
    { railway: "SENTRY_DSN", github: ["SENTRY_DSN"], required: false },
    { railway: "SENTRY_AUTH_TOKEN", github: ["SENTRY_AUTH_TOKEN"], required: false },

    // Added 2026-08-08: these 26 Railway variables previously had no GitHub secret/variable
    // backing them at all — if Railway ever lost them there was no automated recovery path.
    // Backfilled to GitHub by the owner the same day (verified via `gh secret list`). The 8
    // marked required:true below are code-verified to have no fallback/default; the rest stay
    // required:false because the consuming code treats their absence as a normal, valid state.
    { railway: "APP_ENV", github: ["APP_ENV"], required: false },
    { railway: "BREVO_API_KEY", github: ["BREVO_API_KEY"], required: false },
    { railway: "BREVO_EMAIL_FROM", github: ["BREVO_EMAIL_FROM"], required: false },
    { railway: "EMAIL_NOTIFICATIONS_ENABLED", github: ["EMAIL_NOTIFICATIONS_ENABLED"], required: true },
    // GitHub rejects any Actions secret name starting with "GITHUB_" (HTTP 422, reserved for
    // its own auto-provided secrets like GITHUB_TOKEN) — confirmed live 2026-08-08. The
    // Railway variable keeps its original name (no app-code change needed); only the GitHub
    // secret name differs, same pattern already used for the legacy SUPABASE_* fallbacks above.
    { railway: "GITHUB_ACTIONS_DISPATCH_TOKEN", github: ["PHOENIX_ACTIONS_DISPATCH_TOKEN"], required: false },
    { railway: "HEALTHCHECKS_PING_KEY", github: ["HEALTHCHECKS_PING_KEY"], required: false },
    { railway: "HR_NOTIFICATION_EMAILS", github: ["HR_NOTIFICATION_EMAILS"], required: false },
    { railway: "IREPORTS360_BASE_URL", github: ["IREPORTS360_BASE_URL"], required: true },
    { railway: "IREPORTS360_PASSWORD", github: ["IREPORTS360_PASSWORD"], required: true },
    { railway: "IREPORTS360_TIMEOUT_MS", github: ["IREPORTS360_TIMEOUT_MS"], required: false },
    { railway: "IREPORTS360_USERNAME", github: ["IREPORTS360_USERNAME"], required: true },
    { railway: "JOB_OFFER_EMAIL_FROM", github: ["JOB_OFFER_EMAIL_FROM"], required: false },
    { railway: "MARKETING_SHEET_REFRESH_WEBHOOK_SECRET", github: ["MARKETING_SHEET_REFRESH_WEBHOOK_SECRET"], required: false },
    { railway: "MARKETING_SHEET_REFRESH_WEBHOOK_URL", github: ["MARKETING_SHEET_REFRESH_WEBHOOK_URL"], required: false },
    { railway: "NOTIFICATION_EMAIL_FROM", github: ["NOTIFICATION_EMAIL_FROM"], required: true },
    { railway: "PHOENIX_ALLOWED_ORIGINS", github: ["PHOENIX_ALLOWED_ORIGINS"], required: false },
    { railway: "PHOENIX_APP_URL", github: ["PHOENIX_APP_URL"], required: true },
    { railway: "PHOENIX_LIVE_CRM_POLL", github: ["PHOENIX_LIVE_CRM_POLL"], required: true },
    { railway: "PHOENIX_STRICT_SUPABASE_BRIDGE", github: ["PHOENIX_STRICT_SUPABASE_BRIDGE"], required: false },
    { railway: "RECRUITMENT_EMAIL_IMPORT_SENDERS", github: ["RECRUITMENT_EMAIL_IMPORT_SENDERS"], required: false },
    { railway: "RECRUITMENT_WHATSAPP_IMPORT_SENDERS", github: ["RECRUITMENT_WHATSAPP_IMPORT_SENDERS"], required: false },
    { railway: "RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS", github: ["RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS"], required: false },
    { railway: "SHEET_REFRESH_WEBHOOK_SECRET", github: ["SHEET_REFRESH_WEBHOOK_SECRET"], required: false },
    { railway: "SHEET_REFRESH_WEBHOOK_URL", github: ["SHEET_REFRESH_WEBHOOK_URL"], required: false },
    { railway: "WHATSAPP_PHONE_NUMBER_ID", github: ["WHATSAPP_PHONE_NUMBER_ID"], required: false },
    { railway: "WHATSAPP_WEBHOOK_VERIFY_TOKEN", github: ["WHATSAPP_WEBHOOK_VERIFY_TOKEN"], required: true },

    // Added 2026-08-08: the owner created a fresh token and both Railway and GitHub now hold
    // the clean value (the corrupted one — a second KEY=VALUE pair glued onto the end with no
    // separator — is fully resolved). required:false because nothing in this codebase or CI
    // reads this value yet; it's held for future Cloudflare DNS/cache automation.
    { railway: "CLOUDFLARE_API_TOKEN", github: ["CLOUDFLARE_API_TOKEN"], required: false },
];

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const railEnv = process.env.RAILWAY_ENVIRONMENT || "production";
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_ID?.trim();
  const railwayToken = process.env.RAILWAY_TOKEN?.trim();

  if (!railwayToken) {
    console.error("[sync-railway-production-secrets] RAILWAY_TOKEN is required.");
    process.exit(1);
  }
  if (!projectId) {
    console.error("[sync-railway-production-secrets] RAILWAY_PROJECT_ID is required.");
    process.exit(1);
  }
  if (!serviceName) {
    console.error("[sync-railway-production-secrets] RAILWAY_SERVICE_NAME or RAILWAY_SERVICE_ID is required.");
    process.exit(1);
  }

  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const cliArgsBase = ["--yes", "@railway/cli@latest", "variable", "set"];
  const commonArgs = ["--skip-deploys", "--service", serviceName, "--environment", railEnv, "--project", projectId];

  let updated = 0;
  let skipped = 0;
  const failures = [];

  const legacyWarnings = detectLegacyAlternatives();
  if (legacyWarnings.length > 0) {
    console.warn("[sync-railway-production-secrets] legacy values detected:");
    for (const warning of legacyWarnings) console.warn(`  - ${warning}`);
  }

  for (const entry of variables) {
    const value = resolveValue(entry.github);

    if (!value) {
      if (entry.required) {
        failures.push(`${entry.github.join(" or ")} is missing`);
      } else {
        skipped += 1;
        console.log(`[sync-railway-production-secrets] skipping optional ${entry.railway} because ${entry.github.join(" or ")} is empty`);
      }
      continue;
    }

    const cliArgs = [...cliArgsBase, `${entry.railway}=${value}`, ...commonArgs];
    const commandDisplay = [npmCommand, ...cliArgs].join(" ");

    if (dryRun) {
      console.log(`[dry-run] ${commandDisplay}`);
      updated += 1;
      continue;
    }

    const result = spawnSync(npmCommand, cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAILWAY_TOKEN: railwayToken,
        RAILWAY_PROJECT_ID: projectId,
        RAILWAY_SERVICE_NAME: serviceName,
        RAILWAY_ENVIRONMENT: railEnv,
      },
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      failures.push(`${entry.railway} failed: ${stderr || stdout || "unknown railway cli error"}`);
      continue;
    }

    updated += 1;
    console.log(`[sync-railway-production-secrets] synced ${entry.railway}`);
  }

  if (failures.length > 0) {
    console.error("[sync-railway-production-secrets] FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`[sync-railway-production-secrets] completed: updated=${updated}, skipped=${skipped}, environment=${railEnv}`);
}

if (isMainModule()) {
  main();
}

export { resolveValue, variables };
