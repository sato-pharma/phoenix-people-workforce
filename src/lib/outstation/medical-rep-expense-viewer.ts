import { isMedicalRep, normalizeRole, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who the employee portal treats as a Medical Rep for outstation expenses — the ONE answer both
 * portal expense pages read, so they can never hand a viewer back and forth.
 *
 * The portal has two expense pages. `/employee-portals/expenses` is the Medical Rep's simple
 * submit-and-list workspace; `/employee-portals/expense-dashboard` is everyone else's. Each page
 * used to decide on its own whether the viewer belonged on the other one, and they asked two
 * DIFFERENT sources:
 *
 *   - the dashboard read the SESSION role (`app_auth_users.role`, the permission key every
 *     `assertPermission` call uses) and sent a Medical Rep to the workspace;
 *   - the workspace's service read the EMPLOYEE RECORD — `resolveJobFunctionRole(job_title)` from
 *     the employee directory — refused anyone whose title is not a Medical Rep, and the page sent
 *     that refusal to the dashboard.
 *
 * A viewer whose login role is Medical Rep while their job title is something else met BOTH
 * conditions, so the two pages redirected to each other forever. The client router follows a
 * server-component redirect without the browser's 20-hop limit, so every hop was a full server
 * render: on 2026-09-21 one preview tab rendered the pair about 1,350 times in 80 minutes and the
 * local dev server grew to 9.9 GB and starved the laptop.
 *
 * The rule now: the dashboard hands a viewer to the workspace only when `isMedicalRepExpenseViewer`
 * says so, and the workspace hands a refused viewer to the dashboard only when it says NOT — so the
 * two redirects can never both fire for the same person. A viewer the workspace refuses but the
 * dashboard would send back stays on the workspace's own "unavailable" empty state, which names the
 * refusal: a login role that disagrees with the HR job title is a data fix, not a page to route to.
 *
 * This decides ROUTING only. Whether a person's record may use the simple workspace — and so which
 * allowance policy prices the claim — is still the job-title rule in `assertMedicalRepExpenseRole`,
 * unchanged. An acting District Manager (DM login role, Medical Representative title) keeps
 * submitting through the workspace exactly as before.
 */

/**
 * The refusal the simple workspace raises for an employee record that is not a Medical Rep. One
 * constant for the service that throws it and the page that recognises it: a reworded message would
 * otherwise leave every non-rep on the workspace's error state instead of their dashboard, with
 * nothing failing anywhere.
 */
export const MEDICAL_REP_ONLY_EXPENSE_REFUSAL =
  "Forbidden: only Medical Rep users can use simple expense submission.";

/**
 * The simple workspace's own gate, on the job function `getEmployeeIdentity` resolves from the
 * employee record (`resolveJobFunctionRole(job_title ?? session role)`). Moved here unchanged from
 * src/lib/outstation/service.ts so the refusal and its reader live together.
 */
export function assertMedicalRepExpenseRole(employeeRole: string | null | undefined): void {
  if (normalizeRole(employeeRole) !== "Medical Rep") {
    throw new Error(MEDICAL_REP_ONLY_EXPENSE_REFUSAL);
  }
}

function isMedicalRepOnlyExpenseRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes(MEDICAL_REP_ONLY_EXPENSE_REFUSAL.toLowerCase())
  );
}

/**
 * Is this viewer a Medical Rep for the portal's expense pages? Read from the SESSION role — the one
 * every permission check, the portal sidebar (`resolvePortalRole` tries it first) and the dashboard
 * have always used — so no viewer's route changes except the one that looped.
 */
export function isMedicalRepExpenseViewer(access: Pick<AccessContext, "role">): boolean {
  return isMedicalRep(access.role);
}

/**
 * The workspace failed to load: should it send this viewer to the expense dashboard?
 *
 * Only for its own "not a Medical Rep" refusal, and never for a viewer `isMedicalRepExpenseViewer`
 * claims — the dashboard would send that viewer straight back. Every other case renders the
 * workspace's empty state.
 */
export function shouldBounceToExpenseDashboard(
  access: Pick<AccessContext, "role">,
  loadError: unknown,
): boolean {
  return isMedicalRepOnlyExpenseRefusal(loadError) && !isMedicalRepExpenseViewer(access);
}
