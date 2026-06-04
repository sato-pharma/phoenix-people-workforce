import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const csrfProtectedMutationRoutes = [
  "../app/api/admin/outstation/[id]/route.ts",
  "../app/api/admin/outstation/calculate-manager-distance/route.ts",
  "../app/api/admin/outstation/manager-expenses/[id]/route.ts",
  "../app/api/admin/outstation/manager-expenses/route.ts",
  "../app/api/contracts/[id]/workflow/route.ts",
  "../app/api/contracts/route.ts",
  "../app/api/employees/[hrId]/resign/route.ts",
  "../app/api/employees/route.ts",
  "../app/api/outstation/calculate/route.ts",
  "../app/api/outstation/capture-location/route.ts",
  "../app/api/outstation/medical-rep-expenses/route.ts",
  "../app/api/outstation/policy/route.ts",
  "../app/api/outstation/reverse-geocode/route.ts",
  "../app/api/outstation/submit/route.ts",
  "../app/api/outstation/sync-offline/route.ts",
  "../app/api/payroll/[id]/replace/route.ts",
  "../app/api/payroll/[id]/route.ts",
  "../app/api/payroll/[id]/workflow/route.ts",
  "../app/api/payroll/expenses/analyze/route.ts",
  "../app/api/payroll/expenses/import/route.ts",
  "../app/api/payroll/expenses/reports/[id]/route.ts",
  "../app/api/payroll/expenses/route.ts",
  "../app/api/payroll/upload/route.ts",
  "../app/api/payroll/validate/route.ts",
  "../app/api/probation/[id]/workflow/route.ts",
  "../app/api/probation/route.ts",
  "../app/api/recruitment/applications/[id]/convert/route.ts",
  "../app/api/recruitment/applications/[id]/offer/route.ts",
  "../app/api/recruitment/applications/[id]/workflow/route.ts",
  "../app/api/recruitment/applications/route.ts",
  "../app/api/recruitment/candidates/import/route.ts",
  "../app/api/recruitment/candidates/route.ts",
  "../app/api/recruitment/requisitions/[id]/workflow/route.ts",
  "../app/api/recruitment/requisitions/route.ts",
  "../app/api/resignations/[id]/dates/route.ts",
  "../app/api/resignations/[id]/workflow/route.ts",
  "../app/api/resignations/route.ts",
];

export function runCsrfRouteCoverageTests() {
  for (const route of csrfProtectedMutationRoutes) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    const mutationHandlers = source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
    const guardCalls = source.match(/assertSameOriginMutation\(request\)/g) ?? [];

    assert.match(
      source,
      /assertSameOriginMutation/,
      `${route} must call the same-origin CSRF guard before mutation handling.`,
    );
    assert.ok(
      guardCalls.length >= mutationHandlers.length,
      `${route} must guard every POST/PATCH/PUT/DELETE handler.`,
    );
  }
}
