import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isAllowedPhoenixOrigin, trustedOriginForRedirect } from "../src/lib/security/origins.ts";
import { systemDeployment } from "../src/config/system-settings.ts";

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

  // CSP must not reference the removed Sentry ingest hosts.
  const nextConfigSource = readFileSync("next.config.ts", "utf8");
  assert.doesNotMatch(
    nextConfigSource,
    /ingest\.sentry\.io|ingest\.us\.sentry\.io|ingest\.de\.sentry\.io/,
    "connect-src CSP must not whitelist Sentry after its removal",
  );

  // Synthetic-journey environment classification must treat the Cloud Run host as
  // production (not 'preview').
  const syntheticSource = readFileSync("src/lib/synthetic-journeys/service.ts", "utf8");
  assert.match(
    syntheticSource,
    /\.run\.app/,
    "synthetic-journey environment detection must recognise the Cloud Run host as production",
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
}
