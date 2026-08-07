#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const railEnv = process.env.RAILWAY_ENVIRONMENT || "production";
const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_ID?.trim();
const railwayToken = process.env.RAILWAY_TOKEN?.trim();

if (!railwayToken) {
  console.error("[validate-railway-production-secrets] RAILWAY_TOKEN is required.");
  process.exit(1);
}
if (!projectId) {
  console.error("[validate-railway-production-secrets] RAILWAY_PROJECT_ID is required.");
  process.exit(1);
}
if (!serviceName) {
  console.error("[validate-railway-production-secrets] RAILWAY_SERVICE_NAME or RAILWAY_SERVICE_ID is required.");
  process.exit(1);
}

const requiredVariables = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
  "PHOENIX_AUTH_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "NOTIFICATION_WEBHOOK_SECRET",
  "CRON_SECRET",
  "ATTENDANCE_AGENT_TOKEN",
];

const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const cliArgs = ["--yes", "@railway/cli@latest", "variable", "list", "--json", "--service", serviceName, "--environment", railEnv, "--project", projectId];

if (dryRun) {
  console.log(`[validate-railway-production-secrets] dry-run: would validate ${requiredVariables.length} required Railway variables`);
  process.exit(0);
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
  console.error("[validate-railway-production-secrets] Railway CLI failed:");
  console.error(stderr || stdout || "unknown railway cli error");
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(result.stdout || "{}")
} catch (error) {
  console.error("[validate-railway-production-secrets] Failed to parse Railway CLI JSON output.");
  process.exit(1);
}

function normalizeVariables(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    if (Array.isArray(input.variables)) return input.variables;
    if (input.variables && typeof input.variables === "object") {
      return Object.entries(input.variables).map(([name, value]) => ({ name, value }));
    }
    return Object.entries(input).map(([name, value]) => ({ name, value }));
  }
  return [];
}

const variables = normalizeVariables(payload);
const valuesByName = new Map();
for (const variable of variables) {
  const name = variable?.name ?? variable?.key;
  const value = variable?.value ?? variable?.value ?? variable?.rawValue;
  if (typeof name === "string") valuesByName.set(name, value);
}

const failures = [];
for (const name of requiredVariables) {
  const value = valuesByName.get(name);
  if (value === undefined || String(value).trim() === "") {
    failures.push(`${name} is missing in Railway`);
    continue;
  }

  const trimmed = String(value).trim();
  if (name === "APP_URL" || name === "NEXT_PUBLIC_APP_URL") {
    if (!/^https:\/\//i.test(trimmed)) failures.push(`${name} must be an https URL`);
    if (/vercel\.app/i.test(trimmed)) failures.push(`${name} must not use a vercel.app host`);
  }

  if (name === "NEXT_PUBLIC_SUPABASE_URL") {
    if (!/^https:\/\/[^/\s]+\.supabase\.co\/?$/i.test(trimmed)) {
      failures.push(`${name} must look like https://<project>.supabase.co`);
    }
  }

  if (name === "NEXT_PUBLIC_SUPABASE_ANON_KEY" || name === "SUPABASE_SERVICE_ROLE_KEY") {
    if (trimmed.length < 20) failures.push(`${name} looks too short`);
  }
}

if (failures.length > 0) {
  console.error("[validate-railway-production-secrets] FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[validate-railway-production-secrets] OK — validated ${requiredVariables.length} required variables in Railway environment ${railEnv}`);
