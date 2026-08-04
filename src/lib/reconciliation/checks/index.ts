import { crmSalesReconciliationChecks } from "@/lib/reconciliation/checks/crm-sales";
import { deductionsAttendanceReconciliationChecks } from "@/lib/reconciliation/checks/deductions-attendance";
import { notificationsIntegrityReconciliationChecks } from "@/lib/reconciliation/checks/notifications-integrity";
import { payrollReconciliationChecks } from "@/lib/reconciliation/checks/payroll";
import type { ReconciliationCheck } from "@/lib/reconciliation/types";

/**
 * The whole registry, in one place, so adding a check is a single edit and nothing can be
 * registered twice under one id — an alert deduplicated on a duplicated id would silently hide
 * one of the two checks sharing it.
 */
export const reconciliationChecks: ReconciliationCheck[] = [
  ...payrollReconciliationChecks,
  ...deductionsAttendanceReconciliationChecks,
  ...crmSalesReconciliationChecks,
  ...notificationsIntegrityReconciliationChecks,
];
