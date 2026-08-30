import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import type { PhoenixRole } from "@/lib/auth/permissions";

/**
 * Workforce Compliance eligibility.
 *
 * Only the field commercial workforce appears in the Workforce Compliance report:
 * the **Sales** force (and its line management), **Marketing**, and the
 * **Training Manager**. Everyone else — CEO, HR, Finance, R&D, Regulatory/QPPV,
 * admin/support, system accounts, blank-title rows — is excluded.
 *
 * Department columns are not populated in the employee directory (`department_id`
 * is null for every employee), so eligibility is decided from the descriptive job
 * title. This is a non-security business rule (who shows up in an attendance report),
 * exactly the kind of job-function classification that `resolveJobFunctionRole` is
 * intended for — it must never be used to grant permissions.
 *
 * Decision = (title is in the explicit eligible set) OR (its job-function role is a
 * Sales/Marketing role). The explicit set also covers "Marketing Manager" and
 * "Training Manager", which do not map to a canonical sales/marketing PhoenixRole.
 *
 * NOTE: the SFE Manager APPEARS in the Workforce Compliance report (listed below), but
 * must NOT be subject to deductions. That deduction-side exclusion is enforced separately
 * in the deductions module's CRM connector (src/lib/deductions/connectors/crm.ts, which
 * re-applies isFieldWorkforceComplianceEligibleTitle) — this helper only controls who shows
 * up in the compliance report.
 */

const ELIGIBLE_TITLES = new Set<string>([
  // Sales department (field sales force + line management)
  "medical representative",
  "medical rep",
  "employee medical rep",
  "district sales manager",
  "district manager",
  "dsm",
  "regional sales manager",
  "regional manager",
  "national sales manager",
  "nsm",
  // Marketing department
  "product manager",
  "group product manager",
  "marketing manager",
  // Training
  "training manager",
  // SFE — appears in the compliance report; excluded from deductions separately.
  "sfe manager",
]);

// Canonical Sales + Marketing job-function roles (per src/lib/employees/job-function.ts).
// Catches future descriptive title variants that resolve to one of these roles.
const ELIGIBLE_ROLES = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
]);

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns true when ANY of the provided title fields (e.g. job title, position title)
 * identifies an employee eligible to appear in Workforce Compliance.
 */
export function isFieldWorkforceComplianceEligibleTitle(
  ...titles: Array<string | null | undefined>
): boolean {
  for (const title of titles) {
    const normalized = normalizeTitle(title);
    if (!normalized) continue;
    if (ELIGIBLE_TITLES.has(normalized)) return true;
    if (ELIGIBLE_ROLES.has(resolveJobFunctionRole(title))) return true;
  }
  return false;
}

const SFE_MANAGER_TITLE = "sfe manager";

/**
 * The single source of truth for the SFE Manager deduction exclusion promised in the module
 * comment above: SFE Manager appears in the Workforce Compliance report (it's in
 * ELIGIBLE_TITLES) but must never generate a payroll-deduction recommendation. Callers building
 * the no-activity -> payroll_deduction recommendation should skip it when this returns true.
 */
export function isSfeManagerTitle(...titles: Array<string | null | undefined>): boolean {
  return titles.some((title) => normalizeTitle(title) === SFE_MANAGER_TITLE);
}

/**
 * Titles that OWN a CRM contact list and log their own visits.
 *
 * This is deliberately narrower than isFieldWorkforceComplianceEligibleTitle, and the
 * difference decides who a CRM no-activity deduction can honestly apply to.
 *
 * A Medical Rep owns contacts and enters visits, so a day with no visit is that rep's
 * own signal. **A manager has no contact list and does not hand-enter visits** — the rep
 * submits the visit and TAGS the manager, so a manager appears in CRM only when someone
 * else remembered to tag them. Their absence measures the rep's data entry, not the
 * manager's work, and they have no mechanism to correct it.
 *
 * Measured on July 2026 production: 16 managers/PMs carried 131,741.94 EGP — 77% of the
 * whole CRM category — and on 35 of those charged days the person had CLOCKED IN on the
 * fingerprint device (53,258.06 EGP). One Product Manager was at work on every single day
 * he was charged for; a National Sales Manager lost 35% of a 90,000 base over 11 days no
 * rep tagged him.
 *
 * 🔴 `field-workforce-compliance/types.ts` says a fingerprint punch CORROBORATES a
 * no-activity day rather than cancelling it. That is correct FOR REPS, who are not on
 * fingerprint devices at all — it was never written about office-based managers, for whom
 * the punch proves attendance and the missing CRM row proves only that nobody tagged them.
 * Do not cite that comment to put managers back in scope.
 */
const OWN_CRM_VISIT_LOGGER_TITLES = new Set<string>([
  "medical representative",
  "medical rep",
  "employee medical rep",
]);

export function logsOwnCrmVisitsTitle(...titles: Array<string | null | undefined>): boolean {
  for (const title of titles) {
    const normalized = normalizeTitle(title);
    if (!normalized) continue;
    if (OWN_CRM_VISIT_LOGGER_TITLES.has(normalized)) return true;
    if (resolveJobFunctionRole(title) === "Medical Rep") return true;
  }
  return false;
}
