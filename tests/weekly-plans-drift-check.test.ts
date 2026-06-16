import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runWeeklyPlansDriftCheckTests() {
  const driftSrc = readFileSync("src/lib/weekly-planning/drift-check.ts", "utf8");
  const migrationSrc = readFileSync(
    "supabase/migrations/20260617120000_weekly_plans_drift_rpc.sql",
    "utf8",
  );
  const dailySrc = readFileSync("app/api/notifications/daily/route.ts", "utf8");

  // ── Migration contract ────────────────────────────────────────────────────────
  assert.match(
    migrationSrc,
    /phx_weekly_plans_drift_check/,
    "migration must define phx_weekly_plans_drift_check()",
  );
  assert.match(
    migrationSrc,
    /SECURITY DEFINER/,
    "RPC must be SECURITY DEFINER",
  );
  assert.match(
    migrationSrc,
    /REVOKE EXECUTE.*FROM PUBLIC/,
    "RPC must REVOKE EXECUTE from PUBLIC",
  );
  assert.match(
    migrationSrc,
    /REVOKE EXECUTE.*FROM authenticated/,
    "RPC must REVOKE EXECUTE from authenticated",
  );
  assert.match(
    migrationSrc,
    /REVOKE EXECUTE.*FROM anon/,
    "RPC must REVOKE EXECUTE from anon",
  );
  assert.match(
    migrationSrc,
    /GRANT EXECUTE.*TO service_role/,
    "RPC must GRANT EXECUTE to service_role only",
  );

  // All 6 drift queries present
  for (const code of ["D1", "D2", "D3", "D4", "D5", "D6"] as const) {
    assert.match(migrationSrc, new RegExp(`--\\s*${code}:`), `migration must contain ${code} query comment`);
  }

  // ── Service file contract ─────────────────────────────────────────────────────
  assert.match(
    driftSrc,
    /export async function runWeeklyPlansDriftCheck/,
    "drift-check.ts must export runWeeklyPlansDriftCheck",
  );
  assert.match(
    driftSrc,
    /rpc\("phx_weekly_plans_drift_check"\)/,
    "drift-check.ts must call rpc(\"phx_weekly_plans_drift_check\")",
  );
  assert.match(
    driftSrc,
    /createSystemNotification/,
    "drift-check.ts must use createSystemNotification to alert recipients",
  );
  assert.match(
    driftSrc,
    /idempotencyKey/,
    "drift-check.ts must include idempotencyKey to prevent duplicate alerts",
  );
  assert.ok(
    driftSrc.includes("anomalous.length === 0"),
    "drift-check.ts must short-circuit when no anomalies (no zero-row spam)",
  );

  // ── Daily cron wiring ─────────────────────────────────────────────────────────
  assert.match(
    dailySrc,
    /runWeeklyPlansDriftCheck/,
    "daily cron must import and call runWeeklyPlansDriftCheck",
  );
  assert.match(
    dailySrc,
    /weeklyPlansDrift/,
    "daily cron must include weeklyPlansDrift in response JSON",
  );
}
