import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isAllowedPhoenixOrigin, trustedOriginForRedirect } from "../src/lib/security/origins.ts";
import { systemDeployment } from "../src/config/system-settings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Regression coverage for the Vercel -> Google Cloud Run migration.
 * Guards the specific behaviours a platform change can silently break:
 * canonical URL generation, forwarded-host trust, production runtime detection,
 * and the removal of Vercel/Sentry-specific assumptions.
 */
export function runGcloudMigrationHardeningTests() {
  const canonical = systemDeployment.productionUrl;
  assert.equal(
    canonical,
    "https://phoenix-hr.satopharma.com",
    "canonical production URL must be the custom domain, not a vercel.app host",
  );

  // Forged X-Forwarded-Host must NOT poison a redirect / emailed link origin.
  // Every candidate here is an untrusted host, so the canonical production URL
  // must be returned instead (the fix behind app/api/admin/users/setup-link).
  const forgedRequest = new Request("https://evil.attacker.example/api/admin/users/setup-link", {
    headers: { "x-forwarded-host": "evil.attacker.example", "x-forwarded-proto": "https" },
  });
  assert.equal(
    trustedOriginForRedirect(forgedRequest),
    canonical,
    "an untrusted forwarded host must fall back to the canonical production origin",
  );

  // A request that legitimately arrives on the custom domain keeps that origin.
  const canonicalRequest = new Request("https://phoenix-hr.satopharma.com/api/admin/users/setup-link", {
    headers: { "x-forwarded-host": "phoenix-hr.satopharma.com", "x-forwarded-proto": "https" },
  });
  assert.equal(
    trustedOriginForRedirect(canonicalRequest),
    canonical,
    "the custom domain must be preserved as a trusted redirect origin",
  );

  // The password-setup/reset route must build its emailed link from an allow-list
  // validated origin (trustedOriginForRedirect), never the raw X-Forwarded-Host.
  const setupLinkSource = readFileSync("app/api/admin/users/setup-link/route.ts", "utf8");
  assert.match(
    setupLinkSource,
    /trustedOriginForRedirect/,
    "password-setup link origin must be allow-list validated",
  );
  assert.doesNotMatch(
    setupLinkSource,
    /headers\.get\(\s*["']x-forwarded-host["']/i,
    "password-setup route must not read the raw x-forwarded-host header directly",
  );

  // Production runtime detection must not depend solely on Vercel's VERCEL_ENV
  // (never set on Cloud Run); it must honour APP_ENV / NODE_ENV.
  const settingsSource = readFileSync("src/config/system-settings.ts", "utf8");
  assert.match(
    settingsSource,
    /process\.env\.APP_ENV/,
    "isProductionRuntime must honour APP_ENV for platform-neutral production detection",
  );

  // The strict Supabase-bridge login gate must be opt-in (must not lock out
  // privileged roles on Cloud Run where the bridge is best-effort).
  const appSessionsSource = readFileSync("src/lib/auth/app-sessions.ts", "utf8");
  assert.match(
    appSessionsSource,
    /PHOENIX_STRICT_SUPABASE_BRIDGE === "true"/,
    "strict Supabase-bridge enforcement must remain opt-in",
  );

  // CSP must not hard-code a Sentry ingest host. (Sentry came back on 2026-10-16, production only; its browser
  // host is read from the build's own NEXT_PUBLIC_SENTRY_DSN, so nothing is written into this file.)
  const nextConfigSource = readFileSync("next.config.ts", "utf8");
  assert.doesNotMatch(
    nextConfigSource,
    /ingest\.sentry\.io|ingest\.us\.sentry\.io|ingest\.de\.sentry\.io/,
    "connect-src CSP must not hard-code a Sentry ingest host",
  );

  // Synthetic-journey environment classification must NOT recognise a Cloud Run host at all.
  //
  // INVERTED on 2026-09-30, and the inversion is the point. This assertion used to require
  // `.run.app` to be PRESENT, because during the cutover a synthetic run against the Cloud Run
  // service had to be labelled `production` rather than `preview`. The cutover is complete: GCP
  // billing is closed (AGENTS.md §3 — "GCP and Vercel are DEAD", every API answers
  // BILLING_DISABLED), the services are deleted, and `phoenix-hr-897559113412.*.run.app` is a
  // hostname the company no longer controls. A dead host must never be trusted as production —
  // whoever inherits that project number would otherwise have their host labelled as the real
  // payroll app. The canonical custom domain is the only production host now, and an unrecognised
  // host correctly falls through to `preview`.
  //
  // Read through stripComments so this asserts on CODE, not prose. The removal is documented in
  // that file, and an explanation of why a host is gone naturally wants to quote the host — which
  // would fail a raw-text guard on its own documentation. That file's comment currently avoids
  // naming it (scripts/check-no-stale-domains.mjs scans it too), so today the strip changes
  // nothing; it is here so the next person to expand that comment is not punished for it.
  // See tests/support/comment-strip.ts for why the strip must be that lexer and not a regex.
  const syntheticSource = stripComments(readFileSync("src/lib/synthetic-journeys/service.ts", "utf8"));
  assert.doesNotMatch(
    syntheticSource,
    /run\.app/,
    "synthetic-journey environment detection must no longer recognise any Cloud Run (.run.app) host: " +
      "the GCP cutover is complete, the services are deleted, and a host the company does not " +
      "control must never be classified as production",
  );
  assert.match(
    syntheticSource,
    /"phoenix-hr\.satopharma\.com"/,
    "the canonical custom domain must remain the host that means production",
  );

  // --- Wave 1: legacy Vercel origins removed from the trust set ---
  for (const legacy of [
    "https://phoenix-workforce-team.vercel.app",
    "https://phoenix-workforce-git-co-c8df8e-phoenix-hr-workspace-s-projects.vercel.app",
    "https://phoenix-workforce-git-codex-41bc50-phoenix-workspace-s-projects.vercel.app",
  ]) {
    assert.equal(
      isAllowedPhoenixOrigin(legacy),
      false,
      `legacy Vercel origin must no longer be trusted: ${legacy}`,
    );
  }

  // Preview-read-only behaviour must be platform-neutral (APP_ENV), not keyed on VERCEL_ENV.
  const proxySource = readFileSync("proxy.ts", "utf8");
  assert.match(proxySource, /APP_ENV === "preview"/, "preview gate must use APP_ENV");
  assert.doesNotMatch(proxySource, /VERCEL_ENV/, "preview gate must not depend on VERCEL_ENV");

  // Cron auth must not depend on the Vercel presence flag anymore.
  const cronSource = readFileSync("app/api/notifications/daily/route.ts", "utf8");
  assert.doesNotMatch(cronSource, /process\.env\.VERCEL\b/, "cron auth must not read process.env.VERCEL");

  // Attendance agent PowerShell spawn must be guarded (never runs on Linux/Cloud Run).
  const localAgentSource = readFileSync("src/lib/attendance/local-agent.ts", "utf8");
  assert.match(
    localAgentSource,
    /canManageLocalAttendanceAgent[\s\S]*process\.platform === "win32"/,
    "local attendance agent spawn must be gated to a Windows, non-production host",
  );
  assert.match(
    localAgentSource,
    /if \(!canManageLocalAttendanceAgent\(\)\)/,
    "startLocalAttendanceAgent must refuse to spawn when unsupported",
  );

  // --- Wave 2: deliberate host posture (canonical vs .run.app vs unknown) ---
  const runAppHost = "https://phoenix-hr-897559113412.europe-west3.run.app";
  const savedAllowed = process.env.PHOENIX_ALLOWED_ORIGINS;
  try {
    // Default posture (no PHOENIX_ALLOWED_ORIGINS): only the canonical domain is trusted;
    // the raw .run.app host, unknown hosts, and forged forwarded hosts are NOT.
    delete process.env.PHOENIX_ALLOWED_ORIGINS;
    assert.equal(isAllowedPhoenixOrigin(canonical), true, "canonical host must be trusted");
    assert.equal(isAllowedPhoenixOrigin(runAppHost), false, "raw .run.app must not be trusted by default");
    assert.equal(isAllowedPhoenixOrigin("https://attacker.example"), false, "unknown host must not be trusted");
    assert.equal(isAllowedPhoenixOrigin(""), false, "empty host must not be trusted");

    // A request arriving on the .run.app host must still produce a CANONICAL redirect
    // origin — sensitive links must never carry the .run.app hostname.
    const runAppRequest = new Request(`${runAppHost}/api/auth/login`, {
      headers: { "x-forwarded-host": "phoenix-hr-897559113412.europe-west3.run.app", "x-forwarded-proto": "https" },
    });
    assert.equal(
      trustedOriginForRedirect(runAppRequest),
      canonical,
      "redirect/link origin from the .run.app host must fall back to the canonical domain",
    );

    // The .run.app host is trusted ONLY when explicitly opted-in via PHOENIX_ALLOWED_ORIGINS
    // (what the deploy workflow sets in production) — never implicitly.
    process.env.PHOENIX_ALLOWED_ORIGINS = runAppHost;
    assert.equal(
      isAllowedPhoenixOrigin(runAppHost),
      true,
      "the .run.app host is trusted only when explicitly configured via PHOENIX_ALLOWED_ORIGINS",
    );
  } finally {
    if (savedAllowed === undefined) delete process.env.PHOENIX_ALLOWED_ORIGINS;
    else process.env.PHOENIX_ALLOWED_ORIGINS = savedAllowed;
  }
}
