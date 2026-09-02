#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

import { variables as syncedVariables } from "./sync-railway-production-secrets.mjs";
import { checkSecretShape } from "./secret-shape-rules.mjs";

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
  // Added 2026-08-08 — code-verified to have no fallback/default, unlike the other 18 newly
  // GitHub-tracked variables (see sync-railway-production-secrets.mjs). Safe to require here
  // regardless of GitHub backfill status: this script checks Railway's live value, which is
  // already correct for all 8.
  "EMAIL_NOTIFICATIONS_ENABLED",
  "IREPORTS360_BASE_URL",
  "IREPORTS360_USERNAME",
  "IREPORTS360_PASSWORD",
  "NOTIFICATION_EMAIL_FROM",
  "PHOENIX_APP_URL",
  "PHOENIX_LIVE_CRM_POLL",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
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
} catch {
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
  if (name === "APP_URL" || name === "NEXT_PUBLIC_APP_URL" || name === "PHOENIX_APP_URL") {
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

  // Value-shape rules (scripts/secret-shape-rules.mjs). Deliberately fed the RAW value rather
  // than `trimmed`: surrounding whitespace, a stray newline and a leading BOM are themselves
  // corruption worth failing on, and trimming first would hide all three. See that module's
  // header for the 2026-09-02 incident these exist to catch.
  failures.push(...checkSecretShape(name, value));
}

// Added 2026-08-08, after CLOUDFLARE_API_TOKEN and NOTIFICATION_WEBHOOK_SECRET were found on
// Railway with a second, unrelated KEY=VALUE pair glued onto the end of the real value with no
// separator (consistent with a lost newline during a manual multi-line paste). Neither the
// presence check above nor its shape checks would have caught this — the values were non-empty
// and neither variable has a named shape rule. Runs against EVERY variable Railway returns, not
// just requiredVariables, since CLOUDFLARE_API_TOKEN isn't and won't be on that list.
//
// NO negative lookbehind, deliberately — tried one first (requiring a non-alphanumeric
// character before the match) and it was WRONG for the real failure mode: the actual
// corruption has zero separator, so the embedded key name butts directly against the previous
// token's last (alphanumeric) character, which a lookbehind would block from matching at all.
// Verified against every real variable *shape* in this system (JWTs, API keys of every
// provider in use, webhook URLs, connection strings) with none containing a literal "=" at
// all outside of this corruption — so an unqualified match here is a strong, low-noise signal.
//
// Warn, don't fail, for now — this heuristic is unverified against every one of the ~90 live
// values, and a false positive should never take down a real deploy. This matches how this
// repo already treats an unproven check (validate-env.mjs sits unwired; check-secret-pins.ts
// was kept rather than deleted). Promote the push target below from corruptionWarnings to
// failures once it's proven clean across a few real runs.
const EMBEDDED_KEY_VALUE = /[A-Z][A-Z0-9_]{3,}=/;
const corruptionWarnings = [];
for (const [name, rawValue] of valuesByName) {
  if (rawValue === undefined || rawValue === null) continue;
  const value = String(rawValue);
  const match = EMBEDDED_KEY_VALUE.exec(value);
  if (match) {
    corruptionWarnings.push(
      `${name} looks corrupted — contains an embedded "${match[0]}" at offset ${match.index} of ${value.length} chars (a second KEY=VALUE pair may be glued onto this value)`,
    );
  }
}

// Free bonus, same motivation: log any Railway variable that is tracked by neither this
// script's requiredVariables nor sync-railway-production-secrets.mjs's own variable list —
// exactly the class of drift that let 27 variables go unsynced and unnoticed for weeks.
// Informational only; a variable can legitimately be Railway-only on purpose.
const RAILWAY_PLATFORM_PREFIX = /^RAILWAY_/;
const knownNames = new Set([...requiredVariables, ...syncedVariables.map((entry) => entry.railway)]);
const untrackedNames = [...valuesByName.keys()].filter(
  (name) => !knownNames.has(name) && !RAILWAY_PLATFORM_PREFIX.test(name),
);

if (corruptionWarnings.length > 0) {
  console.warn("[validate-railway-production-secrets] possible value corruption (warning only):");
  for (const warning of corruptionWarnings) console.warn(`  - ${warning}`);
}

if (untrackedNames.length > 0) {
  console.warn("[validate-railway-production-secrets] Railway variables not tracked by any script (informational):");
  for (const name of untrackedNames) console.warn(`  - ${name}`);
}

if (failures.length > 0) {
  console.error("[validate-railway-production-secrets] FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[validate-railway-production-secrets] OK — validated ${requiredVariables.length} required variables in Railway environment ${railEnv}`);
