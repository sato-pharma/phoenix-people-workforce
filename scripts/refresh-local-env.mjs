#!/usr/bin/env node
// Refreshes .env.local from Railway's current production variables, for the primary
// checkout only (see scripts/sync-worktree-env.mjs for populating a NEW worktree from an
// existing .env.local — this script is the one that regenerates the source copy).
//
// Never prints a value — only variable names and byte counts — so a secret can never land in
// a terminal transcript or log. Developer-machine-only: never wire this into a GitHub Actions
// workflow, since it needs a human's own `railway login` session.
//
// Usage:
//   node scripts/refresh-local-env.mjs            # back up the old file, write a fresh one
//   node scripts/refresh-local-env.mjs --dry-run   # print what would happen, change nothing
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { RAILWAY_CLI_PACKAGE } from "./secret-policy.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "refresh-local-env",
  entry: import.meta.url,
  known: ["--dry-run"],
  hints: [
    "--dry-run prints what would happen and changes nothing",
  ],
});

// Deliberately a small exclude-list + small override-map, NOT an exhaustive per-variable
// bucket list — an exhaustive list needs updating every time Railway gains a variable, which
// is exactly the maintenance gap that let 27 variables go unsynced elsewhere in this repo.
// Defaulting new/unlisted Railway variables to "mirror as-is" means this script can't silently
// miss one.

// Railway's own platform-injected variables (RAILWAY_*) are meaningless for local dev.
const RAILWAY_PLATFORM_PREFIX = /^RAILWAY_/;

// Never copy these locally, even though Railway has them.
const EXCLUDE = new Set([
  // src/lib/crm/live-poller.ts: this must never be set in a local env file — it would let a
  // dev machine start a SECOND writer against production's CRM sync.
  "PHOENIX_LIVE_CRM_POLL",
  // A production-specific CORS allow-list; copying it locally risks confusing CORS behavior
  // for a local dev server that isn't running on any of those origins anyway.
  "PHOENIX_ALLOWED_ORIGINS",
  // Multiple routes branch on APP_ENV === "production" for prod-only behavior (preview
  // read-only guards, dev-auth gating). Local dev must never inherit "production" here.
  "APP_ENV",
  // Corrupted on Railway as of 2026-08-08 (see the audit PR) and not read by any app code
  // today — don't copy known-bad or currently-unused data into a fresh local file.
  "CLOUDFLARE_API_TOKEN",
]);

// Copy the NAME from Railway (so the key exists locally) but write this value instead.
const OVERRIDE = {
  APP_URL: () => "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: () => "http://localhost:3000",
  PHOENIX_APP_URL: () => "http://localhost:3000",
  NOTIFICATION_DASHBOARD_URL: () => "http://localhost:3000",
  // Freshly generated, NEVER the pulled production value — a local session cookie must never
  // double as a valid production one.
  PHOENIX_AUTH_SECRET: () => randomBytes(32).toString("hex"),
};

// Dev-only variables that Railway does NOT have (production must never set these) — see
// docs/environment.md's "Dev-Only Variables" table.
const APPEND_DEV_ONLY = {
  PHOENIX_ENABLE_DEV_AUTH_HEADERS: "true",
  PHOENIX_PORTAL_SHOW_BETA_NAV: "true",
};

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

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const railEnv = process.env.RAILWAY_ENVIRONMENT || "production";
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_ID?.trim();

  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const cliArgs = [
    "--yes",
    RAILWAY_CLI_PACKAGE,
    "variable",
    "list",
    "--json",
    ...(serviceName ? ["--service", serviceName] : []),
    ...(railEnv ? ["--environment", railEnv] : []),
    ...(projectId ? ["--project", projectId] : []),
  ];

  const result = spawnSync(npmCommand, cliArgs, { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    console.error("[refresh-local-env] Railway CLI failed (are you logged in? try `railway login`):");
    console.error(stderr || stdout || "unknown railway cli error");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    console.error("[refresh-local-env] Failed to parse Railway CLI JSON output.");
    process.exit(1);
  }

  const variables = normalizeVariables(payload);
  const lines = [
    "# Generated by scripts/refresh-local-env.mjs — do not hand-edit shared values here.",
    "# Overrides and dev-only additions are applied by that script; re-run it to refresh.",
    "",
  ];
  const mirrored = [];
  const overridden = [];
  const excluded = [];

  for (const variable of variables) {
    const name = variable?.name ?? variable?.key;
    if (typeof name !== "string") continue;
    if (RAILWAY_PLATFORM_PREFIX.test(name) || EXCLUDE.has(name)) {
      excluded.push(name);
      continue;
    }

    if (OVERRIDE[name]) {
      lines.push(`${name}=${OVERRIDE[name]()}`);
      overridden.push(name);
      continue;
    }

    const rawValue = variable?.value ?? variable?.rawValue ?? "";
    lines.push(`${name}=${rawValue}`);
    mirrored.push(name);
  }

  lines.push("", "# Dev-only — never set these in production (see docs/environment.md).");
  for (const [name, value] of Object.entries(APPEND_DEV_ONLY)) {
    lines.push(`${name}=${value}`);
  }

  const content = lines.join("\n") + "\n";
  const byteCount = Buffer.byteLength(content, "utf8");

  console.log(`[refresh-local-env] mirrored ${mirrored.length} variables as-is: ${mirrored.join(", ")}`);
  console.log(`[refresh-local-env] overrode ${overridden.length} for local dev: ${overridden.join(", ")}`);
  console.log(`[refresh-local-env] excluded ${excluded.length} (platform/unsafe-locally): ${excluded.join(", ")}`);
  console.log(`[refresh-local-env] appended ${Object.keys(APPEND_DEV_ONLY).length} dev-only variables`);

  if (dryRun) {
    console.log(`[refresh-local-env] dry-run: would write ${byteCount} bytes to .env.local (not written)`);
    return;
  }

  if (existsSync(".env.local")) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `.env.local.bak-${stamp}`;
    renameSync(".env.local", backupName);
    console.log(`[refresh-local-env] backed up existing .env.local -> ${backupName}`);
  }

  writeFileSync(".env.local", content, "utf8");
  console.log(`[refresh-local-env] wrote ${byteCount} bytes to .env.local`);
}

main();
