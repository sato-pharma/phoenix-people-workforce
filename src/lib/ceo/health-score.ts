/**
 * Company Health Score — TRANSPARENT, weighted composite of real aggregate pillars.
 * Every pillar is a clearly-defined transform of an existing metric. If too few
 * pillars have data (coverage below MIN_COVERAGE), no overall score is published —
 * a "baseline pending" state is shown instead. Never fabricated, never over-precise.
 */
export type HealthPillar = {
  key: string;
  label: string;
  weight: number;
  score: number | null;
  available: boolean;
  detail: string;
};

export type CompanyHealth = {
  overall: number | null;
  pillars: HealthPillar[];
  coveragePct: number;
  available: boolean;
};

/** Need at least 60% of weighted pillars present to publish an overall score. */
export const MIN_HEALTH_COVERAGE = 0.6;

export type CompanyHealthInput = {
  employeeHealthRate?: number | null; // 0..100 (directory completeness)
  payrollFlags?: number | null;
  payrollEmployees?: number | null;
  salesAchievementPct?: number | null; // 0..100 (already converted from fraction)
  criticalRiskCount?: number | null;
  dataUnavailableCount?: number | null;
  salesLinkageRate?: number | null; // 0..100
};

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function pillar(key: string, label: string, weight: number, score: number | null, detail: string): HealthPillar {
  return { key, label, weight, score, available: score !== null, detail };
}

export function computeCompanyHealth(input: CompanyHealthInput): CompanyHealth {
  const pillars: HealthPillar[] = [];

  pillars.push(
    pillar(
      "workforce",
      "Workforce stability",
      0.25,
      isFiniteNumber(input.employeeHealthRate) ? clampScore(input.employeeHealthRate) : null,
      "Directory completeness (manager + role present)",
    ),
  );

  let payrollScore: number | null = null;
  if (isFiniteNumber(input.payrollFlags) && isFiniteNumber(input.payrollEmployees) && input.payrollEmployees > 0) {
    payrollScore = clampScore(100 - (input.payrollFlags / input.payrollEmployees) * 100);
  }
  pillars.push(pillar("payroll", "Payroll health", 0.2, payrollScore, "Share of the latest batch without flags"));

  pillars.push(
    pillar(
      "sales",
      "Sales achievement",
      0.2,
      isFiniteNumber(input.salesAchievementPct) ? clampScore(input.salesAchievementPct) : null,
      "Latest achievement vs target (capped at 100)",
    ),
  );

  pillars.push(
    pillar(
      "risk",
      "Risk pressure",
      0.2,
      isFiniteNumber(input.criticalRiskCount) ? clampScore(100 - Math.min(input.criticalRiskCount * 10, 100)) : null,
      "Lower is better — 10 points deducted per critical lifecycle risk",
    ),
  );

  let dataScore: number | null = null;
  if (isFiniteNumber(input.salesLinkageRate) || isFiniteNumber(input.dataUnavailableCount)) {
    const base = isFiniteNumber(input.salesLinkageRate) ? clampScore(input.salesLinkageRate) : 100;
    const penalty = Math.min((input.dataUnavailableCount ?? 0) * 10, 100);
    dataScore = clampScore(base - penalty);
  }
  pillars.push(pillar("data", "Data integrity", 0.15, dataScore, "Sales linkage minus unavailable feeds"));

  const availablePillars = pillars.filter((entry) => entry.available);
  const availableWeight = availablePillars.reduce((sum, entry) => sum + entry.weight, 0);
  const coveragePct = Math.round(availableWeight * 100);
  const available = availableWeight >= MIN_HEALTH_COVERAGE;
  const overall = available
    ? Math.round(
        availablePillars.reduce((sum, entry) => sum + (entry.score ?? 0) * entry.weight, 0) / availableWeight,
      )
    : null;

  return { overall, pillars, coveragePct, available };
}
