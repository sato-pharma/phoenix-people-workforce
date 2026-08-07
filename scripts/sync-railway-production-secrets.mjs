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
  ];

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

export { resolveValue };
