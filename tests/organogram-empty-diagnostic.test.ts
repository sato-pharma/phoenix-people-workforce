import { strict as assert } from "node:assert";

import {
  scopeOrganogramReportData,
  type OrganogramScopeMode,
} from "../src/lib/reports/organogram.ts";
import type { VacancyReportData } from "../src/lib/reports/vacancies.ts";

function emptyVacancyReport(): VacancyReportData {
  return {
    organogramRows: [],
    rows: [],
    summary: {
      areasAffected: 0,
      linesAffected: 0,
      openVacancies: 0,
      positionsAffected: 0,
      totalVacancies: 0,
    },
  };
}

export function runOrganogramEmptyDiagnosticTests() {
  // ── line scope with missing line_name surfaces a diagnostic instead of looking like "0 vacancies" ──
  const lineMode: OrganogramScopeMode = "line";
  const lineMissing = scopeOrganogramReportData(emptyVacancyReport(), {
    lineName: null,
    mode: lineMode,
  });
  assert.equal(lineMissing.summary.openVacancies, 0, "missing line_name returns no rows");
  assert.ok(lineMissing.diagnostic, "missing line_name must populate a diagnostic");
  assert.equal(
    lineMissing.diagnostic?.code,
    "line_unresolved",
    "missing line_name diagnostic code must be line_unresolved so the UI can branch on it",
  );
  assert.match(
    lineMissing.diagnostic?.message ?? "",
    /line/i,
    "diagnostic message should mention the line scope so the user knows what failed",
  );

  // ── empty-string line_name is still treated as unresolved ────────────────────────────────────────
  const lineEmpty = scopeOrganogramReportData(emptyVacancyReport(), {
    lineName: "",
    mode: lineMode,
  });
  assert.equal(
    lineEmpty.diagnostic?.code,
    "line_unresolved",
    "empty-string line_name must also produce a line_unresolved diagnostic",
  );

  // ── company-mode pass-through still omits the diagnostic ────────────────────────────────────────
  const companyMode: OrganogramScopeMode = "company";
  const companyPassthrough = scopeOrganogramReportData(emptyVacancyReport(), {
    mode: companyMode,
  });
  assert.equal(
    companyPassthrough.diagnostic,
    undefined,
    "company-mode pass-through must not set a diagnostic (no failure to surface)",
  );

  // ── happy line path with a real line_name and matching rows also omits the diagnostic ─────────
  const happyLine = scopeOrganogramReportData(emptyVacancyReport(), {
    lineName: "Cardio",
    mode: lineMode,
  });
  assert.equal(
    happyLine.diagnostic,
    undefined,
    "a resolved line scope must not set a diagnostic, even when there are zero rows",
  );
}
