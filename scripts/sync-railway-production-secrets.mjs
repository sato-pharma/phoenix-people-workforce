#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { RAILWAY_CLI_PACKAGE } from "./secret-policy.mjs";

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
  name: "sync-railway-production-secrets",
  entry: import.meta.url,
  known: ["--dry-run"],
});

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
    // 🔴 DEMOTED FROM required:true ON 2026-09-30, and it must stay in lockstep with
    // scripts/secret-policy.mjs's REQUIRED_VARIABLES (tests/railway-secret-policy.test.ts fails if
    // the two disagree). Read by ZERO lines of application code — verified across src/, app/ and
    // scripts/ — so requiring it meant an emergency secret sync could abort over a variable whose
    // absence changes nothing, while the credentials that DO matter went unsynced behind it.
    // Re-promote it the day something reads it, not before.
    { railway: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", github: ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY"], required: false },
    { railway: "SUPABASE_SERVICE_ROLE_KEY", github: ["SUPABASE_SERVICE_ROLE_KEY", "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY"], required: true },
    { railway: "SUPABASE_PROJECT_ID", github: ["SUPABASE_PROJECT_ID", "SUPABASE_PROJECT_REF"], required: true },
    { railway: "SUPABASE_PROJECT_REF", github: ["SUPABASE_PROJECT_REF", "SUPABASE_PROJECT_ID"], required: true },
    { railway: "PHOENIX_AUTH_SECRET", github: ["PHOENIX_AUTH_SECRET"], required: true },
    { railway: "RESEND_API_KEY", github: ["RESEND_API_KEY"], required: true },
    { railway: "RESEND_WEBHOOK_SECRET", github: ["RESEND_WEBHOOK_SECRET"], required: true },
    // Demoted from required:true on 2026-10-24, in lockstep with secret-policy.mjs: Claude answers
    // first and OpenAI is only the last resort, so a sync must not abort when OpenAI's key is absent.
    // The validator's checkAiKeyPresent still fails a production holding none of the AI keys.
    { railway: "OPENAI_API_KEY", github: ["OPENAI_API_KEY"], required: false },
    { railway: "TELEGRAM_BOT_TOKEN", github: ["TELEGRAM_BOT_TOKEN"], required: true },
    { railway: "NOTIFICATION_WEBHOOK_SECRET", github: ["NOTIFICATION_WEBHOOK_SECRET"], required: true },
    { railway: "CRON_SECRET", github: ["CRON_SECRET"], required: true },
    { railway: "ATTENDANCE_AGENT_TOKEN", github: ["ATTENDANCE_AGENT_TOKEN"], required: true },
    // Weaker sibling of the above, handed to the browser so the admin page's "Sync Now" can reach
    // the on-prem agent directly. Optional: unset just hides the button. It must NEVER hold the
    // same value as ATTENDANCE_AGENT_TOKEN - that one authenticates attendance writes to Phoenix.
    { railway: "ATTENDANCE_AGENT_BROWSER_TOKEN", github: ["ATTENDANCE_AGENT_BROWSER_TOKEN"], required: false },
    { railway: "NOTIFICATION_DASHBOARD_URL", github: ["NOTIFICATION_DASHBOARD_URL"], required: false },
    { railway: "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", github: ["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY"], required: false },
    { railway: "GOOGLE_MAPS_SERVER_KEY", github: ["GOOGLE_MAPS_SERVER_KEY"], required: false },
    { railway: "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID", github: ["NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID"], required: false },
    { railway: "GOOGLE_CALENDAR_API_KEY", github: ["GOOGLE_CALENDAR_API_KEY"], required: false },
    { railway: "GOOGLE_HOLIDAY_CALENDAR_ID_EG", github: ["GOOGLE_HOLIDAY_CALENDAR_ID_EG"], required: false },
    { railway: "LOCATIONIQ_API_KEY", github: ["LOCATIONIQ_API_KEY"], required: false },
    { railway: "NEXT_PUBLIC_ONESIGNAL_APP_ID", github: ["NEXT_PUBLIC_ONESIGNAL_APP_ID"], required: false },
    { railway: "ONESIGNAL_REST_API_KEY", github: ["ONESIGNAL_REST_API_KEY"], required: false },
    { railway: "NEXT_PUBLIC_SENTRY_DSN", github: ["NEXT_PUBLIC_SENTRY_DSN", "SENTRY_DSN"], required: false },
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
    // The extra sending accounts (2026-10-08, Resend daily quota): optional, each switched on by its
    // own key — see src/lib/email/email-providers.ts.
    { railway: "RESEND_API_KEY_2", github: ["RESEND_API_KEY_2"], required: false },
    { railway: "RESEND_EMAIL_FROM_2", github: ["RESEND_EMAIL_FROM_2"], required: false },
    { railway: "RESEND_WEBHOOK_SECRET_2", github: ["RESEND_WEBHOOK_SECRET_2"], required: false },
    { railway: "RESEND_API_KEY_3", github: ["RESEND_API_KEY_3"], required: false },
    { railway: "RESEND_EMAIL_FROM_3", github: ["RESEND_EMAIL_FROM_3"], required: false },
    { railway: "RESEND_WEBHOOK_SECRET_3", github: ["RESEND_WEBHOOK_SECRET_3"], required: false },
    { railway: "RESEND_API_KEY_4", github: ["RESEND_API_KEY_4"], required: false },
    { railway: "RESEND_EMAIL_FROM_4", github: ["RESEND_EMAIL_FROM_4"], required: false },
    { railway: "RESEND_WEBHOOK_SECRET_4", github: ["RESEND_WEBHOOK_SECRET_4"], required: false },
    // The sales module's dedicated Resend account (owner, 2026-10-13) — src/lib/email/module-sending-accounts.ts.
    { railway: "RESEND_API_KEY_SALES", github: ["RESEND_API_KEY_SALES"], required: false },
    { railway: "RESEND_EMAIL_FROM_SALES", github: ["RESEND_EMAIL_FROM_SALES"], required: false },
    { railway: "RESEND_WEBHOOK_SECRET_SALES", github: ["RESEND_WEBHOOK_SECRET_SALES"], required: false },
    // The People module's dedicated Resend account (owner, 2026-10-13).
    { railway: "RESEND_API_KEY_PEOPLE", github: ["RESEND_API_KEY_PEOPLE"], required: false },
    { railway: "RESEND_EMAIL_FROM_PEOPLE", github: ["RESEND_EMAIL_FROM_PEOPLE"], required: false },
    { railway: "RESEND_WEBHOOK_SECRET_PEOPLE", github: ["RESEND_WEBHOOK_SECRET_PEOPLE"], required: false },
    { railway: "BREVO_API_KEY_2", github: ["BREVO_API_KEY_2"], required: false },
    { railway: "BREVO_EMAIL_FROM_2", github: ["BREVO_EMAIL_FROM_2"], required: false },
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
    // Added 2026-10-01, BEFORE any key exists, so the carrying path is in place the moment the
    // owner mints one at Google. 🔴 required:false DELIBERATELY, and it must stay that way until the
    // careers form sends a token: src/lib/security/recaptcha.ts treats an unset secret as SKIP, so
    // requiring it here would abort an emergency secret sync over a variable whose absence is the
    // current, intended state. Promoting it is a two-file change — REQUIRED_VARIABLES in
    // scripts/secret-policy.mjs moves in the same commit, or tests/railway-secret-policy.test.ts reds.
    { railway: "RECRUITMENT_APPLY_RECAPTCHA_SECRET", github: ["RECRUITMENT_APPLY_RECAPTCHA_SECRET"], required: false },
    { railway: "RECRUITMENT_EMAIL_IMPORT_SENDERS", github: ["RECRUITMENT_EMAIL_IMPORT_SENDERS"], required: false },
    { railway: "RECRUITMENT_WHATSAPP_IMPORT_SENDERS", github: ["RECRUITMENT_WHATSAPP_IMPORT_SENDERS"], required: false },
    { railway: "RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS", github: ["RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS"], required: false },
    { railway: "SHEET_REFRESH_WEBHOOK_SECRET", github: ["SHEET_REFRESH_WEBHOOK_SECRET"], required: false },
    { railway: "SHEET_REFRESH_WEBHOOK_URL", github: ["SHEET_REFRESH_WEBHOOK_URL"], required: false },
    { railway: "WHATSAPP_PHONE_NUMBER_ID", github: ["WHATSAPP_PHONE_NUMBER_ID"], required: false },
    // Added 2026-09-11: every phone number id the intake health check probes, comma separated.
    // whatsapp-health.ts falls back to the singular above when this is unset, so a second line is
    // invisible to the silence alert until it is listed here.
    { railway: "WHATSAPP_PHONE_NUMBER_IDS", github: ["WHATSAPP_PHONE_NUMBER_IDS"], required: false },
    // Added 2026-11-03: the third number, used only for approval reminders. Unset until he sets it up, and the job stays off.
    { railway: "WHATSAPP_APPROVALS_PHONE_NUMBER_ID", github: ["WHATSAPP_APPROVALS_PHONE_NUMBER_ID"], required: false },
    { railway: "WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID", github: ["WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID"], required: false },
    { railway: "WHATSAPP_WEBHOOK_VERIFY_TOKEN", github: ["WHATSAPP_WEBHOOK_VERIFY_TOKEN"], required: true },

    // Added 2026-08-08: the owner created a fresh token and both Railway and GitHub now hold
    // the clean value (the corrupted one — a second KEY=VALUE pair glued onto the end with no
    // separator — is fully resolved). required:false because nothing in this codebase or CI
    // reads this value yet; it's held for future Cloudflare DNS/cache automation.
    { railway: "CLOUDFLARE_API_TOKEN", github: ["CLOUDFLARE_API_TOKEN"], required: false },

    // Added 2026-09-05 with the CV-lifecycle sheet's weekly token rotation, so this pair is
    // recoverable the same way its two siblings above are. required:false because an unset
    // pair is a valid state the route reports as `{ rotated: false, reason: "not configured" }`
    // rather than an error — but note the asymmetry: the URL is only an endpoint, while the
    // SECRET must equal the sheet's own WEBHOOK_SECRET script property, which lives in Google
    // and nowhere in this repository. Restoring one without the other leaves every rotation
    // POST answered `denied`, which reads exactly like an unreachable sheet.
    { railway: "CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET", github: ["CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET"], required: false },
    { railway: "CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL", github: ["CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL"], required: false },
];

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const railEnv = process.env.RAILWAY_ENVIRONMENT || "production";
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim() || process.env.RAILWAY_SERVICE_ID?.trim();
  // Railway has TWO kinds of credential and the CLI treats them as different variables:
  //
  //   RAILWAY_TOKEN     — a PROJECT token, minted per project+environment
  //                       (project → Settings → Tokens). Implies its own project.
  //   RAILWAY_API_TOKEN — an ACCOUNT/team token (Account Settings → Tokens).
  //                       Works across projects; requires --project to target one.
  //
  // Putting an account token in RAILWAY_TOKEN fails in a way that reads like an expired
  // credential but is not. Verified 2026-08-09 against the CLI: a junk value yields
  // "Invalid RAILWAY_TOKEN", whereas a well-formed token with no project access yields
  // "Unauthorized ... and has access to the resource" — which is exactly what every run of this
  // workflow reported. That distinction is the whole diagnosis, and missing it cost a day: with
  // every variable failing, no secret could be rotated into production, which silently froze
  // ATTENDANCE_AGENT_TOKEN and stopped attendance data reaching payroll for ten days.
  //
  // 🔴 BOTH SECRETS, EACH UNDER ITS OWN NAME FIRST — NEVER ONE MERGED VALUE (2026-10-27). This used
  // to read `RAILWAY_API_TOKEN || RAILWAY_TOKEN` into one value, so with both secrets set the project
  // key was never tried, and the CLI refused the workspace key. The attempts and the account live in
  // scripts/lib/railway-cli-credentials.mjs, shared with the validator.
  const attempts = railwayCliAttempts(process.env);

  if (attempts.length === 0) {
    console.error("[sync-railway-production-secrets] RAILWAY_API_TOKEN or RAILWAY_TOKEN is required.");
    process.exit(1);
  }
  console.log(`[sync-railway-production-secrets] ${attempts.length} credential attempt(s); the CLI decides which is accepted`);
  if (!projectId) {
    console.error("[sync-railway-production-secrets] RAILWAY_PROJECT_ID is required.");
    process.exit(1);
  }
  if (!serviceName) {
    console.error("[sync-railway-production-secrets] RAILWAY_SERVICE_NAME or RAILWAY_SERVICE_ID is required.");
    process.exit(1);
  }

  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const cliArgsBase = ["--yes", RAILWAY_CLI_PACKAGE, "variable", "set"];
  const commonArgs = ["--skip-deploys", "--service", serviceName, "--environment", railEnv, "--project", projectId];

  // Which attempt the CLI actually accepted. Deliberately starts null: pre-seeding it would collapse
  // the retry list to one entry and defeat the fallback below. Set on the first successful command,
  // then reused — so the retries cost a few extra invocations per run, not per variable.
  let workingAttempt = null;
  const cliContext = {
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_SERVICE_NAME: serviceName,
    RAILWAY_ENVIRONMENT: railEnv,
  };

  /**
   * Runs the Railway CLI through each credential attempt until one is accepted.
   *
   * Nobody can be expected to remember which kind of key was minted, or which secret it was pasted
   * into — Railway offers both from different screens and the failure mode is indistinguishable from
   * expiry ("Unauthorized", not "Invalid"). Rather than demand the right one, try each and remember
   * which worked. Every refusal prints its first error line, never the value.
   */
  function runRailway(cliArgs) {
    const order = workingAttempt ? [workingAttempt] : attempts;
    let last = null;
    for (const attempt of order) {
      last = spawnSync(npmCommand, cliArgs, {
        cwd: process.cwd(),
        env: railwayCliEnv(attempt, cliContext),
        stdio: "pipe",
        encoding: "utf8",
      });
      if (last.status === 0) {
        if (!workingAttempt) {
          workingAttempt = attempt;
          console.log(`[sync-railway-production-secrets] credential accepted: ${describeAttempt(attempt)}`);
        }
        return last;
      }
      if (!workingAttempt) {
        console.log(`[sync-railway-production-secrets] refused: ${describeAttempt(attempt)} — ${firstErrorLine(last)}`);
      }
      // Only an auth rejection is worth another attempt. A genuine failure (bad value, missing
      // service) would fail identically every way and must not be masked.
      if (!isAuthRejection(last)) return last;
    }
    return last;
  }

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

    if (dryRun) {
      // 🔴 THE VALUE IS NEVER PRINTED. This line used to interpolate the real credential into a
      // displayed command (`NAME=VALUE`), and five of the values this script syncs arrive from
      // `vars.*` rather than `secrets.*` — GitHub masks a SECRET in a log and does NOT mask a
      // variable, so a dry run of this workflow would have written them out in clear text into a
      // log anyone with repo read access can open, and into the Actions artifact that outlives it.
      // The name and the length are enough to tell a present value from a truncated or doubled
      // one, which is all a dry run has to answer. Masked 2026-09-30.
      const maskedArgs = [...cliArgsBase, `${entry.railway}=<redacted ${value.length} chars>`, ...commonArgs];
      console.log(`[dry-run] ${[npmCommand, ...maskedArgs].join(" ")}`);
      updated += 1;
      continue;
    }

    const result = runRailway(cliArgs);

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
