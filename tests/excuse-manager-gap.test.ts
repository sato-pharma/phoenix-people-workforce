import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Detection coverage for the "stuck excuse approver" gap listing + daily drift alert (Part B).
 * The service functions hit the DB, so these are source-text invariants matching the style of
 * weekly-plans-drift-check.test.ts.
 */
export function runExcuseManagerGapTests() {
  const driftSrc = readFileSync("src/lib/excuses/drift-check.ts", "utf8");
  const dailySrc = readFileSync("app/api/cron/daily/_lib/daily-job-runners.ts", "utf8");

  assert.match(
    driftSrc,
    /export async function listExcuseManagerGapRecords/,
    "must export listExcuseManagerGapRecords",
  );
  assert.match(
    driftSrc,
    /export async function runExcuseDriftCheck/,
    "must export runExcuseDriftCheck",
  );
  assert.match(
    driftSrc,
    /\.from\("v2_excuse_requests"\)[\s\S]{0,220}\.eq\("status", "pending_manager"\)/,
    "must read v2_excuse_requests filtered to pending_manager",
  );
  assert.match(
    driftSrc,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "must cross-reference the directory including inactive to detect resigned/missing managers",
  );
  assert.match(
    driftSrc,
    /isActiveEmploymentStatus/,
    "must classify the manager's employment status (active/on_leave)",
  );
  // Same non-throwing wrapper + notification pattern as the weekly-plan drift check.
  assert.match(driftSrc, /createSystemNotification/, "must alert via createSystemNotification");
  assert.match(driftSrc, /idempotencyKey/, "must include an idempotencyKey");
  assert.match(driftSrc, /excuse_manager_gap:/, "idempotency key must be per-recipient per-day");
  assert.match(
    driftSrc,
    /gapRecords\.length === 0[\s\S]{0,140}anomalies: 0/,
    "must short-circuit with no notification when there are no gaps (no zero-row spam)",
  );
  assert.match(
    driftSrc,
    /resolveNotificationRoleRecipients\("excuse_drift_alert"\)/,
    "alert recipients must be resolved by the admin-editable role policy, matching the weekly-plan drift check's pattern",
  );
  assert.doesNotMatch(driftSrc, /"HR Manager"/, "\"HR Manager\" is a job title, not an app_auth_users.role value — it must never appear in a role-array literal");
  assert.match(
    driftSrc,
    /catch \(error\)[\s\S]{0,180}ok: false/,
    "runExcuseDriftCheck must be non-throwing (returns an error result)",
  );

  // Daily cron wiring with a catch boundary + response inclusion.
  assert.match(
    dailySrc,
    /runExcuseDriftCheck\(\)\.catch\(/,
    "daily cron must call runExcuseDriftCheck with a catch boundary",
  );
  assert.match(dailySrc, /excuseDrift/, "daily cron response must include excuseDrift");
}
