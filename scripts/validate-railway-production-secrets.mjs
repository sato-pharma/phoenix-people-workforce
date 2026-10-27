#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

import { variables as syncedVariables } from "./sync-railway-production-secrets.mjs";
import { checkSecretShape } from "./secret-shape-rules.mjs";
import {
  EXPECTED_VALUES,
  FORBIDDEN_VARIABLES,
  RAILWAY_CLI_PACKAGE,
  REQUIRED_VARIABLES,
  checkAiKeyPresent,
  checkCanonicalOrigins,
  checkExpectedValues,
  checkForbiddenVariables,
} from "./secret-policy.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import {
  describeAttempt,
  firstErrorLine,
  isAuthRejection,
  railwayCliAttempts,
  railwayCliEnv,
} from "./lib/railway-cli-credentials.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "validate-railway-production-secrets",
  entry: import.meta.url,
  known: ["--dry-run"],
});

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const railEnv = process.env.RAILWAY_ENVIRONMENT || "production";
const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_ID?.trim();
// 🔴 BOTH SECRETS, EACH UNDER ITS OWN NAME FIRST — NEVER ONE MERGED VALUE (2026-10-27).
// Railway mints PROJECT tokens (RAILWAY_TOKEN) and ACCOUNT/workspace tokens (RAILWAY_API_TOKEN), and
// the CLI reads them under different names. This script used to read `RAILWAY_API_TOKEN ||
// RAILWAY_TOKEN` into one value, so with both secrets set the project key was never tried, and the
// two keys broke each other for a week. The attempts and the account live in
// scripts/lib/railway-cli-credentials.mjs, shared with the sync script.
const attempts = railwayCliAttempts(process.env);

if (attempts.length === 0) {
  console.error("[validate-railway-production-secrets] RAILWAY_API_TOKEN or RAILWAY_TOKEN is required.");
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

// The 23 names that must be present and non-empty. Moved into scripts/secret-policy.mjs on
// 2026-09-30 so a test can compare it against sync-railway-production-secrets.mjs's own
// `required: true` set — this script exits at import time, so nothing could import the list while
// it lived here, and two lists that must agree and cannot be compared is how they drift.
const requiredVariables = REQUIRED_VARIABLES;

const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const cliArgs = ["--yes", RAILWAY_CLI_PACKAGE, "variable", "list", "--json", "--service", serviceName, "--environment", railEnv, "--project", projectId];

if (dryRun) {
  console.log(
    `[validate-railway-production-secrets] dry-run: would validate ${requiredVariables.length} required Railway variables,`
      + ` assert ${FORBIDDEN_VARIABLES.length} forbidden names are absent and ${EXPECTED_VALUES.length} exact-value rules,`
      + ` in environment ${railEnv}. No Railway call is made and no value is read.`,
  );
  process.exit(0);
}

/**
 * Run the Railway CLI through each attempt in turn until one is accepted.
 *
 * 🔴 THE RETRY IS THE WHOLE POINT. Nobody can be expected to remember which kind of key was minted,
 * or which secret it was pasted into: Railway offers both from different screens and the
 * rejection reads like expiry ("Unauthorized", not "Invalid"). Each refused attempt prints its first
 * error line, so a run that fails every way says which secret was refused and how — never its value.
 */
function runRailway() {
  let last = null;
  for (const attempt of attempts) {
    last = spawnSync(npmCommand, cliArgs, {
      cwd: process.cwd(),
      env: railwayCliEnv(attempt, {
        RAILWAY_PROJECT_ID: projectId,
        RAILWAY_SERVICE_NAME: serviceName,
        RAILWAY_ENVIRONMENT: railEnv,
      }),
      stdio: "pipe",
      encoding: "utf8",
    });
    if (last.status === 0) {
      console.log(`[validate-railway-production-secrets] credential accepted: ${describeAttempt(attempt)}`);
      return last;
    }
    console.log(`[validate-railway-production-secrets] refused: ${describeAttempt(attempt)} — ${firstErrorLine(last)}`);
    // Only an auth rejection is worth another attempt. A genuine failure — a bad project id, a
    // missing service — fails identically every way, and retrying it would bury the real message.
    if (!isAuthRejection(last)) return last;
  }
  return last;
}

const result = runRailway();

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
}

// Value-shape rules (scripts/secret-shape-rules.mjs), over EVERY variable Railway returns.
//
// 🔴 THIS USED TO SIT INSIDE THE requiredVariables LOOP ABOVE, WHICH MADE PART OF IT DEAD CODE.
// GROQ_API_KEY is not a required variable — an unset one is a supported state, it only turns the
// Firefox voice note off — so its gsk_… rule, registered on 2026-09-25 specifically because that
// key is pasted into Railway by hand exactly the way OPENAI_API_KEY's masked paste was, could
// never fire on the real value. The same was true of every future rule for an optional variable.
// Hoisted 2026-09-30. Still a HARD failure, as it was: both rules in that module are
// deterministic, not heuristic, which is the distinction between this and the warn-only
// EMBEDDED_KEY_VALUE guess below.
//
// Deliberately fed the RAW value rather than a trimmed copy: surrounding whitespace, a stray
// newline and a leading BOM are themselves corruption worth failing on, and trimming first would
// hide all three. See that module's header for the 2026-09-02 incident these exist to catch.
for (const [name, rawValue] of valuesByName) {
  failures.push(...checkSecretShape(name, rawValue));
}

// Production-only policy: names that must be ABSENT, and values that must be EXACT.
// scripts/secret-policy.mjs holds all three lists and the reason for each; every one of these
// checks answers with nothing unless railEnv is production, because three of the forbidden names
// are legitimately set on staging and staging's APP_ENV is "staging" by design.
failures.push(...checkForbiddenVariables(valuesByName, railEnv));
failures.push(...checkExpectedValues(valuesByName, railEnv));
// Folded in from scripts/validate-env.mjs, which has never been able to run: it needs the real
// values and is in no workflow, no ci.yml step and no npm script, so it exits 1 with nothing set.
// This is the one place that HAS the values.
failures.push(...checkCanonicalOrigins(valuesByName, railEnv));
// At least ONE of the three AI keys (2026-10-24). None is required on its own any more.
failures.push(...checkAiKeyPresent(valuesByName, railEnv));

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

console.log(
  `[validate-railway-production-secrets] OK — validated ${requiredVariables.length} required variables,`
    + ` ${FORBIDDEN_VARIABLES.length} forbidden names absent, ${EXPECTED_VALUES.length} exact-value rules,`
    + ` and the value shape of all ${valuesByName.size} variables in Railway environment ${railEnv}`,
);
