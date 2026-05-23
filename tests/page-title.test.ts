import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { documentTitleForPathname, pageTitleForPathname } from "../src/lib/page-title.ts";

export function runPageTitleTests() {
  assert.equal(documentTitleForPathname("/"), "Phoenix Workforce");
  assert.equal(documentTitleForPathname("/payslips"), "Payslips | Phoenix Workforce");
  assert.equal(documentTitleForPathname("/employee-portals/team-performance"), "Team Performance | Phoenix Workforce");
  assert.equal(documentTitleForPathname("/admin/payslips-center"), "Payslips Center | Phoenix Workforce");
  assert.equal(documentTitleForPathname("/payroll/expenses/dashboard"), "Expenses Dashboard | Phoenix Workforce");

  assert.equal(pageTitleForPathname("/coaching/123"), "Coaching Report");
  assert.equal(pageTitleForPathname("/employee-portals/training-manager/field-coaching/123"), "Field Coaching Report");
  assert.equal(pageTitleForPathname("/admin/custom-workspace"), "Admin Custom Workspace");

  const titleSyncSource = readFileSync("src/components/layout/page-title-sync.tsx", "utf8");
  assert.match(titleSyncSource, /useLayoutEffect/);
  assert.match(titleSyncSource, /MutationObserver/);
  assert.match(titleSyncSource, /document\.title !== expectedTitle/);
}
