import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase17WorkflowUiActionClosureTests() {
  const outstationRouteSource = readFileSync("app/api/admin/outstation/[id]/route.ts", "utf8");
  const outstationUiSource = readFileSync("src/components/outstation/outstation-requests-admin.tsx", "utf8");
  const outstationServiceSource = readFileSync("src/lib/outstation/service.ts", "utf8");
  const salesServiceSource = readFileSync("src/lib/sales/service.ts", "utf8");
  const vacationServiceSource = readFileSync("src/lib/vacation/service.ts", "utf8");
  const operationsSource = readFileSync("src/lib/operations/events.ts", "utf8");
  const phase17SmokeSource = readFileSync("scripts/phase17-disposable-fixture-smoke.ts", "utf8");

  assert.match(outstationRouteSource, /export async function POST/);
  assert.match(outstationRouteSource, /assertOutstationAdminAccess\(access,\s*"approve"\)/);
  assert.match(outstationRouteSource, /approveOutstationRequestForPayroll/);
  assert.match(outstationUiSource, /Accept for payroll/);
  assert.match(outstationUiSource, /fetch\(`\/api\/admin\/outstation\/\$\{selectedRequest\.id\}`/);
  assert.match(outstationUiSource, /setLocalRequests/);
  assert.match(outstationServiceSource, /savePayrollExpenseApprovals/);
  assert.match(outstationServiceSource, /entityType:\s*"outstation_request"/);

  assert.match(vacationServiceSource, /payment_status:\s*balance\.paymentStatus/);
  assert.match(vacationServiceSource, /usedPaidDays:\s*updated\.usedPaidDays/);
  assert.match(vacationServiceSource, /entityType:\s*"vacation_request"/);

  assert.match(salesServiceSource, /\.eq\("status", currentStatus\)/);
  assert.match(salesServiceSource, /Sales batch state changed\. Refresh and retry\./);
  assert.match(salesServiceSource, /oldValues:\s*\{ status: currentStatus \}/);
  assert.match(salesServiceSource, /from\("sales_audit_logs"\)\.insert/);

  assert.match(operationsSource, /isDisposablePayrollFixture/);
  assert.match(operationsSource, /isDisposableSalesFixture/);
  // isDisposableOfferFixture left with the dropped job_offer_audit_logs source (23 Oct 2026).
  assert.doesNotMatch(operationsSource, /job_offer_audit_logs/);

  assert.match(
    phase17SmokeSource,
    /const fixture = `PHASE17_\$\{suffix\}`\.toUpperCase\(\)/,
    "Phase 17 smoke fixtures must be clearly PHASE17-prefixed.",
  );
  assert.match(phase17SmokeSource, /finally\s*\{\s*await cleanup\(\);/);
  assert.match(phase17SmokeSource, /approveOutstationRequestForPayroll/);
  assert.match(phase17SmokeSource, /createVacationRequest[\s\S]*decideVacationRequest/);
  assert.match(phase17SmokeSource, /updateSalesBatchStatus[\s\S]*replaceSalesBatch[\s\S]*deleteSalesBatch/);
  assert.doesNotMatch(
    phase17SmokeSource,
    /locked_at:\s*null|status:\s*"uploaded"[\s\S]*salary_batches/,
    "Phase 17 smoke must document locked payroll cleanup readiness without weakening payroll locks.",
  );
}
