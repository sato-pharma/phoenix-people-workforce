import { resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who may open the Performance Review. Its page, the route the page re-reads from and the route
 * behind its Export button all ask this one function, so the file can never reach someone the
 * screen turns away.
 *
 * Super Admin and system scope, plus the SFE Manager, who already reads the Monthly Closing matrix
 * (owner decision, 2026-08-05). Everyone else reaches the closing through the employee portal.
 *
 * Asked of the ROLE, never of `sales:export`. That permission reaches down to Medical Rep, and the
 * review reads every line, region and rep company-wide, for whatever month a request names —
 * published or not. Until 2026-09-16 the export asked that permission and nothing else, so every
 * role holding it could download the company-wide rep ranking this page refuses them.
 *
 * Each caller still asserts `sales:import` beside it: this says who the screen is FOR, and the
 * permission says whether an override has since taken the key away from that role.
 */
export function canOpenClosingPerformanceReview(access: AccessContext): boolean {
  if (resolveNavigationMode(access) === "employee-portal") return false;
  return access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager";
}

/** The refusal both routes give anyone the check above turns away. */
export const CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE =
  "The Performance Review is available to the Super Admin and the SFE Manager only.";
