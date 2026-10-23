import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase19FixtureCleanupTests() {
  const phase19Source = readFileSync("scripts/phase19-fixture-cleanup-smoke.ts", "utf8");
  const fixtureHygieneSource = readFileSync("src/lib/fixture-hygiene.ts", "utf8");
  const payrollServiceSource = readFileSync("src/lib/payroll/service.ts", "utf8");

  assert.match(phase19Source, /const executeCleanup = process\.argv\.includes\("--execute"\)/);
  assert.match(phase19Source, /buildPreflight/);
  assert.match(phase19Source, /cleanup preflight report generated/);
  assert.match(phase19Source, /deleteSalaryBatch\(batch\.id\)/);
  assert.match(phase19Source, /isProtectedPayrollBatch/);
  assert.match(phase19Source, /approved, locked, or Part 1 paid payroll fixture/);
  assert.match(phase19Source, /raw PHASE audit traces for accountability/);
  assert.match(phase19Source, /getAdminCommandCenterData/);
  assert.match(phase19Source, /getDataHealthStats/);
  // The Monitoring aggregate retired on 23 Oct 2026; the security feed is read through the System
  // Audit's login-security loader now.
  assert.match(phase19Source, /loadLoginSecurityOverview/);
  assert.doesNotMatch(phase19Source, /getOperationalMonitoringStats/);
  assert.match(phase19Source, /Monitoring business activity excludes PHASE15\/16\/17 fixture actors/);
  assert.doesNotMatch(phase19Source, /locked_at:\s*null/);
  assert.doesNotMatch(phase19Source, /status:\s*"uploaded"/);
  assert.doesNotMatch(phase19Source, /\.from\("audit_logs"\)\.delete/);
  assert.doesNotMatch(phase19Source, /\.update\(/);

  assert.match(fixtureHygieneSource, /isDisposableFixtureYear/);
  assert.match(payrollServiceSource, /rpc\(\s*"phx_delete_salary_batch"/);
}
