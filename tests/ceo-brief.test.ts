import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifySignal, computeTrendDirection } from "../src/lib/ceo/brief.ts";
import { buildStrategicRiskRegister, compareRisk, resolveRiskOwner, type RiskRow } from "../src/lib/ceo/risk.ts";
import { computeCompanyHealth } from "../src/lib/ceo/health-score.ts";

export function runCeoBriefTests() {
  // ---- computeTrendDirection: never fabricates a delta ----
  assert.equal(computeTrendDirection([]).direction, "unavailable");
  assert.equal(computeTrendDirection([5]).direction, "unavailable", "single point cannot yield a direction");
  assert.equal(computeTrendDirection([null, 5]).direction, "unavailable", "needs >=2 real points");
  const up = computeTrendDirection([100, 120]);
  assert.equal(up.direction, "up");
  assert.equal(up.latest, 120);
  assert.equal(up.previous, 100);
  assert.equal(Math.round(up.deltaPct ?? 0), 20);
  assert.equal(computeTrendDirection([120, 100]).direction, "down");
  assert.equal(computeTrendDirection([100, 100]).direction, "flat");
  assert.equal(computeTrendDirection([0, 5]).deltaPct, null, "previous=0 must not fabricate a percentage");

  // ---- classifySignal: polarity-aware verdict ----
  assert.equal(classifySignal({ direction: "up", positiveIsUp: true }), "improved");
  assert.equal(classifySignal({ direction: "down", positiveIsUp: true }), "worse");
  assert.equal(classifySignal({ direction: "up", positiveIsUp: false }), "worse"); // cost rising = worse
  assert.equal(classifySignal({ direction: "down", positiveIsUp: false }), "improved"); // cost falling = improved
  assert.equal(classifySignal({ direction: "flat", positiveIsUp: true }), "flat");
  assert.equal(classifySignal({ direction: "unavailable", positiveIsUp: true }), "unavailable");

  // ---- risk register: sorting + severity + owner ----
  const register = buildStrategicRiskRegister({
    alertsAvailable: true,
    alerts: [
      { type: "contract", name: "Late contract", date: "2026-07-01", days: 25 }, // warning
      { type: "probation", name: "Urgent prob", date: "2026-06-02", days: 3 }, // critical
      { type: "contract", name: "Far contract", date: "2026-08-01", days: 50 }, // watch
    ],
    payrollFlags: 2,
    pendingLeave: 1,
    pendingOffers: 0,
    dataUnavailable: ["Sales data unavailable."],
    failureCount24h: 0,
    staleSources: [],
  });
  assert.equal(register.rows[0].severity, "critical", "critical risk must sort first");
  assert.equal(register.rows[0].entity, "Urgent prob");
  const rank: Record<string, number> = { critical: 0, warning: 1, watch: 2 };
  for (let i = 1; i < register.rows.length; i += 1) {
    assert.ok(rank[register.rows[i - 1].severity] <= rank[register.rows[i].severity], "register is severity-ordered");
  }
  assert.ok(register.rows.some((row) => row.category === "Data Integrity"), "dataUnavailable becomes a register row");
  assert.equal(resolveRiskOwner("Payroll"), "Finance / Payroll");
  assert.equal(resolveRiskOwner("Workforce"), "HR / People Ops");

  // alertsAvailable=false -> unavailable source, no fabricated rows
  const noAlerts = buildStrategicRiskRegister({ alertsAvailable: false });
  assert.ok(noAlerts.unavailableSources.includes("Lifecycle risk alerts"));
  assert.equal(noAlerts.rows.length, 0);

  // compareRisk: same severity -> fewer days first
  const a: RiskRow = { id: "a", title: "A", category: "System", severity: "warning", entity: null, dueDate: null, days: 5, impact: "", owner: "", source: "" };
  const b: RiskRow = { id: "b", title: "B", category: "System", severity: "warning", entity: null, dueDate: null, days: 1, impact: "", owner: "", source: "" };
  assert.ok(compareRisk(a, b) > 0, "fewer days remaining sorts earlier");

  // ---- company health: transparent + coverage-gated ----
  const full = computeCompanyHealth({
    employeeHealthRate: 90,
    payrollFlags: 0,
    payrollEmployees: 100,
    salesAchievementPct: 80,
    criticalRiskCount: 0,
    dataUnavailableCount: 0,
    salesLinkageRate: 100,
  });
  assert.equal(full.available, true);
  assert.equal(full.coveragePct, 100);
  assert.ok(full.overall !== null && full.overall >= 0 && full.overall <= 100);

  // Sparse inputs -> baseline pending (coverage below threshold)
  const sparse = computeCompanyHealth({ employeeHealthRate: 90 });
  assert.equal(sparse.available, false);
  assert.equal(sparse.overall, null);

  // payroll pillar unavailable when employees=0 (no divide-by-zero, no fabrication)
  const noPayroll = computeCompanyHealth({
    employeeHealthRate: 90,
    payrollFlags: 5,
    payrollEmployees: 0,
    salesAchievementPct: 50,
    criticalRiskCount: 0,
    salesLinkageRate: 100,
  });
  assert.equal(noPayroll.pillars.find((pillar) => pillar.key === "payroll")?.available, false);

  // ---- read-only contract + no sensitive strings in CEO components ----
  for (const path of ["src/components/admin/ceo-weekly-brief.tsx", "src/components/admin/ceo-risk-register.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /"use client"/, `${path} must stay a server component`);
    assert.doesNotMatch(source, /<button/, `${path} must not render action buttons`);
    assert.doesNotMatch(source, /onClick/, `${path} must not have click handlers`);
    assert.doesNotMatch(source, /<form/, `${path} must not render forms`);
    assert.doesNotMatch(source, /salary|payslip/i, `${path} must not reference individual salary/payslip data`);
    assert.doesNotMatch(source, /[+-]\d{1,3}\.\d%/, `${path} must not contain hardcoded demo deltas`);
  }

  // brief lib must declare weekly snapshot unavailable (no fake weekly deltas)
  const briefSource = readFileSync("src/lib/ceo/brief.ts", "utf8");
  assert.match(briefSource, /weeklySnapshotAvailable: false/, "weekly snapshot baseline must be flagged unavailable");
}
