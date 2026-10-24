// Policy rules for Railway PRODUCTION variables — which names must be ABSENT, which must hold an
// exact value, and which must be present at all.
//
// Kept in its own module for the same reason scripts/secret-shape-rules.mjs is:
// validate-railway-production-secrets.mjs exits at IMPORT time when RAILWAY_TOKEN /
// RAILWAY_PROJECT_ID / RAILWAY_SERVICE_NAME are unset, so a test can never import the validator
// itself. Anything a test needs to assert on lives here and is imported by the validator.
//
// 🔴 EVERY RULE HERE IS PRODUCTION-ONLY, AND THAT IS NOT A DETAIL. Three of the forbidden names
// are LEGITIMATELY SET ON STAGING — PHOENIX_EMAIL_FORCE_TESTING is the single variable that stops
// staging emailing real employees — and staging's APP_ENV is "staging" by design. The validator
// reads RAILWAY_ENVIRONMENT from its own environment, so it CAN be pointed at staging; a rule
// applied there would fail a perfectly healthy staging and, worse, invite someone to "fix" it by
// unsetting the one flag protecting real inboxes. So every check below takes the environment name
// and answers with nothing unless it is production.

import { readFileSync } from "node:fs";

/**
 * The exact `@railway/cli` version every script in this repo invokes through npx.
 *
 * Pinned 2026-09-30, replacing `@railway/cli@latest` at three call sites
 * (validate-railway-production-secrets.mjs, sync-railway-production-secrets.mjs,
 * refresh-local-env.mjs). `@latest` means the secret-sync path silently changes tool version
 * between two runs of the same workflow, on a tool whose job is to write production credentials —
 * a CLI release that renames an argument or changes its JSON shape would surface as "Railway CLI
 * failed", or as a parse error on output that used to be fine, with nothing in the diff to explain
 * it.
 *
 * 5.63.1 is what `@latest` resolved to when this was pinned, so the pin is behaviour-neutral: it
 * freezes the version these scripts are ALREADY fetching rather than moving them to a new one.
 * Bump it deliberately, in its own commit, so a CLI upgrade is a reviewable event.
 */
export const RAILWAY_CLI_VERSION = "5.63.1";

/** What goes in the npx argument list — one string, so no call site can drift from another. */
export const RAILWAY_CLI_PACKAGE = `@railway/cli@${RAILWAY_CLI_VERSION}`;

/**
 * Variables that MUST be present and non-empty on production.
 *
 * Moved here from validate-railway-production-secrets.mjs so the lockstep with
 * sync-railway-production-secrets.mjs's own `required: true` set is testable —
 * tests/railway-secret-policy.test.ts fails if the two lists ever disagree. Two lists that must
 * match and cannot be compared is how they drift.
 *
 * 🔴 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is deliberately NOT here. It is read by zero lines of
 * application code (verified 2026-09-30 across src/, app/ and scripts/), so requiring it meant an
 * emergency secret sync could hard-fail over a variable whose absence changes nothing. Demoted in
 * BOTH scripts in the same change. Re-promote it the day something reads it, not before.
 */
export const REQUIRED_VARIABLES = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
  "PHOENIX_AUTH_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  // OPENAI_API_KEY left this list on 2026-10-24: every AI call goes to Claude first and OpenAI is
  // only the last resort, so production runs with any ONE of the three AI keys. checkAiKeyPresent
  // below is the rule that replaced it. Demoted in BOTH scripts in the same change.
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

/**
 * Variables that must be ABSENT on production. There was no such notion anywhere in this repo
 * before 2026-09-30, and all five are measured absent right now — this LOCKS IN a good state, it
 * does not repair a live fault. Each `why` is printed with the failure, because the damage in
 * every case is SILENT and a bare variable name would not convey it.
 */
export const FORBIDDEN_VARIABLES = [
  {
    name: "PHOENIX_EMAIL_FORCE_TESTING",
    why:
      "any truthy value redirects EVERY outgoing employee email to the test recipients "
      + "(src/config/system-settings.ts, isForceTestingDelivery) — an explicit value always beats the "
      + "production default, so one paste silences payroll, probation, offer and approval mail with no "
      + "error anywhere. It is legitimately SET on staging, which is why this rule is production-only",
  },
  {
    name: "NOTIFICATION_TEST_MODE",
    why: 'it prefixes every notification email subject with "[TEST]", so real recipients are told the message is a drill',
  },
  {
    name: "PHOENIX_EMAIL_DELIVERY_MODE",
    why:
      'a value of "log" stops sending altogether and prints the mail to the container log instead — '
      + "delivery looks perfect from inside the app and nothing arrives",
  },
  {
    name: "PHOENIX_ENABLE_DEV_AUTH_HEADERS",
    why:
      "it turns x-phoenix-role / x-phoenix-hr-id request headers into an accepted identity, i.e. anyone "
      + "who can reach the app can choose to be Super Admin. It exists for local role sweeps only — "
      + "scripts/refresh-local-env.mjs writes it into a LOCAL env file and never into Railway",
  },
  {
    name: "COMMIT_SHA",
    why:
      "it OUTRANKS the platform's own RAILWAY_GIT_COMMIT_SHA in src/lib/observability/deploy-identity.ts, "
      + "so a stale value makes /api/healthz, every drift check and every shipped-verification report name "
      + "a revision production is not running — the one fact those tools exist to establish",
  },
];

/**
 * Variables whose VALUE is checked, not just its presence.
 *
 * APP_ENV is the whole reason this category exists. It is synced into production from an
 * UNENCRYPTED GitHub repo variable (`vars.APP_ENV || secrets.APP_ENV`), which anyone with repo
 * write access can edit with no review, and nothing checked the value. Set it to "staging" and
 * isProductionRuntime() answers false, which flips isForceTestingDelivery() ON for every email in
 * production — the same silent outcome as PHOENIX_EMAIL_FORCE_TESTING above, reached through a
 * variable that reads like harmless metadata.
 *
 * `requirePresent: true` because production is measured holding it today, and an absent value would
 * leave production's identity resting on NODE_ENV alone — which a production BUILD also sets on
 * staging, so it is not a distinction worth relying on.
 */
export const EXPECTED_VALUES = [
  {
    name: "APP_ENV",
    expected: "production",
    requirePresent: true,
    why:
      "anything else turns isProductionRuntime() false, which redirects every outgoing email to the "
      + "test recipients and relaxes the production-only guards",
  },
];

/** True only for the one environment these rules describe. */
function isProductionEnvironment(environment) {
  return String(environment ?? "").trim().toLowerCase() === "production";
}

/** Accepts the validator's Map, or any iterable of [name, value] pairs, and normalises it. */
function asMap(valuesByName) {
  if (valuesByName instanceof Map) return valuesByName;
  return new Map(valuesByName ?? []);
}

/**
 * Failures for every forbidden name that is present with a non-empty value.
 *
 * A name present but EMPTY is not reported: Railway keeps the variable after a value is cleared,
 * and the app itself treats an empty PHOENIX_EMAIL_FORCE_TESTING as unset.
 */
export function checkForbiddenVariables(valuesByName, environment = "production") {
  if (!isProductionEnvironment(environment)) return [];
  const values = asMap(valuesByName);
  const failures = [];
  for (const entry of FORBIDDEN_VARIABLES) {
    const value = values.get(entry.name);
    if (value === undefined || value === null || String(value).trim() === "") continue;
    failures.push(`${entry.name} must NOT be set on production — ${entry.why}`);
  }
  return failures;
}

/**
 * Failures for every expected-value rule.
 *
 * The value IS quoted back here, unlike everywhere else in this pipeline. That is deliberate and
 * confined to this list: APP_ENV is not a credential — it arrives from an unencrypted repo
 * variable — and the wrong value is the entire diagnosis. Never add a secret-bearing name here.
 */
export function checkExpectedValues(valuesByName, environment = "production") {
  if (!isProductionEnvironment(environment)) return [];
  const values = asMap(valuesByName);
  const failures = [];
  for (const rule of EXPECTED_VALUES) {
    const raw = values.get(rule.name);
    const value = raw === undefined || raw === null ? "" : String(raw).trim();
    if (value === "") {
      if (rule.requirePresent) {
        failures.push(`${rule.name} is missing on production — it must be exactly "${rule.expected}": ${rule.why}`);
      }
      continue;
    }
    if (value !== rule.expected) {
      failures.push(`${rule.name} is "${value}" on production — it must be exactly "${rule.expected}": ${rule.why}`);
    }
  }
  return failures;
}

/**
 * The three AI account keys, in the order every AI call tries them: the first Claude account, the
 * second Claude account, then OpenAI as the last resort (src/lib/ai/anthropic-fallback.ts).
 */
export const AI_KEY_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_2", "OPENAI_API_KEY"];

/**
 * One failure when production holds none of the three AI keys — then every AI feature is dead.
 *
 * None of the three is required on its own (2026-10-24): demanding OPENAI_API_KEY made the setup
 * scripts refuse a production that runs on Claude alone, which is the normal state now. Only the
 * names are ever printed, never a value.
 */
export function checkAiKeyPresent(valuesByName, environment = "production") {
  if (!isProductionEnvironment(environment)) return [];
  const values = asMap(valuesByName);
  const present = AI_KEY_VARIABLES.some((name) => {
    const value = values.get(name);
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
  if (present) return [];
  return [
    `none of the AI keys is set on production (${AI_KEY_VARIABLES.join(", ")}) — every AI feature answers "not configured" until at least one is`,
  ];
}

/**
 * The canonical production origin, single-sourced from the app's own config so this gate can never
 * drift from what the app believes it is. Read lazily, so importing this module stays free.
 *
 * Resolved against this file's own URL rather than process.cwd(), so a test or a script invoked
 * from anywhere in the repo reads the same file.
 */
export function canonicalProductionOrigin() {
  const source = readFileSync(new URL("../src/config/system-settings.ts", import.meta.url), "utf8");
  const match = source.match(/productionUrl:\s*"([^"]+)"/);
  if (!match) return null;
  return match[1].replace(/\/+$/, "");
}

/** Every variable that holds the app's own origin, and must therefore never name a dead host. */
export const URL_VARIABLES = ["APP_URL", "NEXT_PUBLIC_APP_URL", "PHOENIX_APP_URL"];

/** The one that must EQUAL the canonical origin — the variable whose wrong value broke every link. */
export const CANONICAL_ORIGIN_VARIABLE = "NEXT_PUBLIC_APP_URL";

/**
 * The assertions folded in from scripts/validate-env.mjs (2026-09-30).
 *
 * That script is sound and has never been able to fire: it needs the REAL values in process.env,
 * so as a bare CI step it exits 1 with nothing set, and it sits in no workflow, no ci.yml step and
 * no npm script. The Railway validator is the one place that HAS the values, so the two checks it
 * made over and above what the validator already did move here:
 *
 *   1. a `.run.app` value is rejected — the dead Cloud Run platform, retired 2026-08-01;
 *   2. NEXT_PUBLIC_APP_URL must EQUAL the canonical origin, not merely be an https non-vercel URL.
 *      That is the variable whose wrong value once broke every email and Telegram link.
 *
 * Held to exactly those names, deliberately: APP_URL and PHOENIX_APP_URL get the `.run.app`
 * rejection (a dead host is wrong in any variable) but NOT the equality check, because widening a
 * gate on values nobody has measured is how a validator starts hard-failing a healthy production.
 */
export function checkCanonicalOrigins(valuesByName, environment = "production") {
  if (!isProductionEnvironment(environment)) return [];
  const values = asMap(valuesByName);
  const failures = [];

  for (const name of URL_VARIABLES) {
    const raw = values.get(name);
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    if (/\.run\.app/i.test(String(raw).trim())) {
      failures.push(`${name} must be the custom domain, not the dead Cloud Run .run.app host`);
    }
  }

  const canonical = canonicalProductionOrigin();
  if (!canonical) {
    failures.push("could not read systemDeployment.productionUrl from src/config/system-settings.ts");
    return failures;
  }

  const raw = values.get(CANONICAL_ORIGIN_VARIABLE);
  const value = raw === undefined || raw === null ? "" : String(raw).trim();
  // Absence is the presence check's job — this name is in REQUIRED_VARIABLES — not this one's.
  if (value !== "" && value.replace(/\/+$/, "") !== canonical) {
    failures.push(`${CANONICAL_ORIGIN_VARIABLE} must equal the canonical origin (${canonical})`);
  }

  return failures;
}
