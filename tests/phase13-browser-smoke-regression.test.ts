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

  // The vacancy list and the sales-ownership classification that read position_vacancies left with
  // the retired Data Health page (23 Oct 2026). Vacant seats come from the shared workforce metrics,
  // never from a raw position_vacancies row count.
  assert.match(dataHealthSource, /vacantPositions: sharedWorkforce\.openVacancies/);
  assert.doesNotMatch(dataHealthSource, /from\("position_vacancies"\)/);

  assert.match(portalExpensesSource, /redirect\("\/employee-portals\/expense-dashboard"\)/);
  assert.doesNotMatch(portalExpensesSource, /redirect\("\/employee-portals"\)/);
  assert.match(portalLayoutSource, /href: "\/employee-portals\/expense-dashboard", label: "Expense Dashboard"/);

  const portalHomeSource = readFileSync("app/employee-portals/page.tsx", "utf8");
  assert.match(portalHomeSource, /PortalCommandCenter/);
  assert.match(portalHomeSource, /getPortalHomeSnapshot/);
  assert.doesNotMatch(portalHomeSource, /getMedicalRepPortalData/);
}
