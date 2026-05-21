import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase13BrowserSmokeRegressionTests() {
  const appShellSource = readFileSync("src/components/layout/app-shell.tsx", "utf8");
  const adminTokensSource = readFileSync("src/components/admin/admin-design-tokens.ts", "utf8");
  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  const portalExpensesSource = readFileSync("app/employee-portals/expenses/page.tsx", "utf8");
  const portalLayoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");

  assert.match(appShellSource, /admin-design-tokens/);
  assert.doesNotMatch(appShellSource, /admin-design-system/);
  assert.doesNotMatch(adminTokensSource, /"use client"/);

  assert.match(dataHealthSource, /const businessVacancyRows = vacancyRows\.filter/);
  assert.match(dataHealthSource, /const openVacancyRows = businessVacancyRows\.filter/);
  assert.match(dataHealthSource, /vacancies: openVacancyRows\.map\(vacancySignalFromRow\)/);
  assert.match(dataHealthSource, /const vacancyAudit = openVacancyRows\.map/);

  assert.match(portalExpensesSource, /redirect\("\/employee-portals\/expense-dashboard"\)/);
  assert.doesNotMatch(portalExpensesSource, /redirect\("\/employee-portals"\)/);
  assert.match(portalLayoutSource, /href: "\/employee-portals\/expense-dashboard", label: "Workload & Expense"/);
}
