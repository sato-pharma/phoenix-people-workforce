import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase20ProductionReadinessTests() {
  const phase20Source = readFileSync("scripts/phase20-production-readiness-smoke.ts", "utf8");
  const phase19Source = readFileSync("scripts/phase19-fixture-cleanup-smoke.ts", "utf8");
  const scorecardSource = readFileSync("docs/system-production-build-scorecard.md", "utf8");

  assert.match(phase20Source, /phase20\.production\.readiness\.readonly/);
  assert.match(phase20Source, /buildProtectedFixtureReport/);
  assert.match(phase20Source, /getAdminCommandCenterData/);
  assert.match(phase20Source, /getDataHealthStats/);
  // The Monitoring aggregate retired on 23 Oct 2026; the security feed is read through the System
  // Audit's login-security loader now.
  assert.match(phase20Source, /loadLoginSecurityOverview/);
  assert.doesNotMatch(phase20Source, /getOperationalMonitoringStats/);
  assert.match(phase20Source, /getOperationalRecentActivity/);
  assert.match(phase20Source, /getPlatformMetrics/);
  assert.match(phase20Source, /protected PHASE payroll fixtures are approved, locked, or Part 1 paid/);
  assert.match(phase20Source, /Raw Audit Logs may retain PHASE traces for accountability/);
  assert.match(phase20Source, /Monitoring business activity excludes retained PHASE fixture actors/);
  assert.match(phase20Source, /no cleanup-safe PHASE payroll batches remain after Phase 19/);
  assert.match(phase20Source, /Platform payroll latest batch ignores protected disposable fixture years/);
  assert.match(phase20Source, /Command Center, Data Health, and Platform share active employee totals/);
  assert.match(phase20Source, /Command Center, Data Health, and Platform share workforce structure totals/);

  assert.doesNotMatch(phase20Source, /--execute/);
  assert.doesNotMatch(phase20Source, /deleteSalaryBatch/);
  assert.doesNotMatch(phase20Source, /\.delete\(/);
  assert.doesNotMatch(phase20Source, /\.update\(/);
  assert.doesNotMatch(phase20Source, /\.insert\(/);
  assert.doesNotMatch(phase20Source, /locked_at:\s*null/);
  assert.doesNotMatch(phase20Source, /status:\s*"uploaded"/);

  assert.match(phase19Source, /raw PHASE audit traces for accountability/);
  assert.match(scorecardSource, /Phase 20 Completion Update/);
  assert.match(scorecardSource, /Protected Fixture Retention Policy/);
  assert.match(scorecardSource, /Final Sidebar Module Scores/);
}
