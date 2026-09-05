import { hrIdForStorage } from "@/lib/hr-id";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * Access gates for Automated Payroll. Payroll is a high-sensitivity surface, so
 * every service call re-checks the caller here (defense-in-depth) rather than
 * trusting the route or sidebar. Throws `Error("Forbidden: ...")` — the
 * `Forbidden:` prefix is mapped to HTTP 403 by the shared route error handler.
 *
 * - HR actor (build + confirm the wizard): Super Admin only (HR authority).
 * - Publisher (push to payslips): Super Admin only — a deliberate, separate step.
 * - Finance viewer (locked sheet download): CEO / Financial Advisor / Finance
 *   Manager / Super Admin. Read/export only. NOTE: an explicit allow-list is used
 *   instead of getPayrollScope because Financial Advisor maps to SELF scope there
 *   and would be wrongly excluded.
 */

const HR_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>(["Super Admin"]);
const PUBLISHER_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>(["Super Admin"]);
const FINANCE_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "CEO",
  "Financial Advisor",
  "Finance Manager",
  "Super Admin",
]);

/** Roles notified when a part is confirmed (CEO + Financial Advisor + Finance Manager). */
export const AUTOMATED_PAYROLL_NOTIFY_ROLES: readonly PhoenixRole[] = [
  "CEO",
  "Financial Advisor",
  "Finance Manager",
] as const;

export function isAutomatedPayrollHrActor(access: AccessContext): boolean {
  return HR_ROLES.has(access.role);
}

export function isAutomatedPayrollPublisher(access: AccessContext): boolean {
  return PUBLISHER_ROLES.has(access.role);
}

export function isAutomatedPayrollFinanceActor(access: AccessContext): boolean {
  return FINANCE_ROLES.has(access.role);
}

export function assertAutomatedPayrollHrActor(access: AccessContext): void {
  if (!isAutomatedPayrollHrActor(access)) {
    throw new Error(`Forbidden: ${access.role} cannot manage Automated Payroll.`);
  }
}

export function assertAutomatedPayrollPublisher(access: AccessContext): void {
  if (!isAutomatedPayrollPublisher(access)) {
    throw new Error(`Forbidden: ${access.role} cannot publish payroll to payslips.`);
  }
}

export function assertAutomatedPayrollFinanceActor(access: AccessContext): void {
  if (!isAutomatedPayrollFinanceActor(access)) {
    throw new Error(`Forbidden: ${access.role} cannot access the Automated Payroll finance sheet.`);
  }
}

/**
 * Stable actor id for audit/created_by columns.
 *
 * The HR id is canonicalised; the login id and the `system` marker are NOT hr ids and are left
 * exactly as they are. This is the same shape as outstation_expenses.approved_by, and the same
 * trap: running the whole expression through hrIdForStorage would stamp SYSTEM and DEV.PREVIEW
 * into every payroll audit row and into salary_batches.approved_by.
 *
 * access.hrId is the LOWERCASE comparison key, so writing it verbatim is what splits one person
 * into two in any per-actor report — the defect this repo has now repaired in six other columns.
 */
export function actorId(access: AccessContext): string {
  return hrIdForStorage(access.hrId) ?? access.loginId ?? "system";
}
