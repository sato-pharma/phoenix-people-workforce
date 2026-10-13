import { resolveNavigationMode, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";

/**
 * Who may open the Performance Review UNBOUNDED — every line, region and rep company-wide, for
 * whatever month a request names, published or not.
 *
 * Its page, the route the page re-reads from and the route behind its Export button all ask this one
 * function, so the file can never reach someone the screen turns away.
 *
 * Super Admin and system scope, plus the SFE Manager, who already reads the Monthly Closing matrix
 * (owner decision, 2026-08-05). Since 2026-10-13 each sales manager reads the same review BOUNDED to
 * his own territory, in his own portal — see `canOpenPortalClosingPerformanceReview` below.
 *
 * Asked of the ROLE, never of `sales:export`. That permission reaches down to Medical Rep. Until
 * 2026-09-16 the export asked that permission and nothing else, so every role holding it could
 * download the company-wide rep ranking this page refuses them.
 *
 * Each caller still asserts a `sales` permission beside it — `performanceReviewSalesAction` below
 * decides which one: this says who the screen is FOR, and the permission says whether an override
 * has since taken the key away from that role.
 */
export function canOpenClosingPerformanceReview(access: AccessContext): boolean {
  if (resolveNavigationMode(access) === "employee-portal") return false;
  return access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager";
}

/**
 * The sales management roles that read the Performance Review in their OWN portal, each BOUNDED to
 * his own territory.
 *
 * Owner, 2026-10-13: "show performance review tab in each district manager account … and of course,
 * everyone sees only his scope." He confirmed the three tiers the same day — a District Manager over
 * his own areas, a Regional Manager over his region, a National Sales Manager over his line.
 *
 * 🔴 **A MEDICAL REP IS NOT HERE, AND IS NOT ADDED WITHOUT HIS WORD.** The review is a RANKING of
 * reps against each other: a rep's own portal closing is bounded to his own area precisely so he
 * cannot read his siblings' numbers, and admitting him here would hand him the table that bound was
 * built to withhold. The bound would not save him either — a one-area ranking is a league of one.
 *
 * Narrower than `PORTAL_CLOSING_ROLES` by that one role and by the three non-territory roles
 * (Product, Group Product and Marketing Manager), who read the closing but were not named for this.
 */
export const PORTAL_PERFORMANCE_REVIEW_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
]);

/**
 * Whether this viewer reads the review in his own portal, scoped to his territory.
 *
 * Asked of the role alone, exactly as `canAccessPortalClosing` is — the scope is what bounds him, and
 * it is resolved and applied server-side by closing-performance-review-scope.ts.
 *
 * 🔴 **THE TWO AUDIENCES ARE DISJOINT BY CONSTRUCTION**, and every caller must check the unbounded
 * gate FIRST: none of these three roles passes it, and no role it admits is listed here. That is what
 * keeps one reader from being handed both the bounded and the unbounded answer depending on which
 * branch ran.
 */
export function canOpenPortalClosingPerformanceReview(access: Pick<AccessContext, "role">): boolean {
  return PORTAL_PERFORMANCE_REVIEW_ROLES.has(access.role);
}

/**
 * The `sales` action each audience's callers assert — the ONE place it is decided, for the page and
 * both routes.
 *
 * 🔴 **THE PORTAL AUDIENCE ASKS `read`, NOT `import`, AND THAT IS NOT A RELAXATION — `import` IS A
 * KEY NONE OF THE THREE ROLES HOLDS.** Measured from the committed matrix: District, Regional and
 * National Sales Manager each have `sales:read` and `sales:export` and **not** `sales:import`. The
 * routes were cloned from the admin screen, which asserts `import` because its audience is Super
 * Admin / SFE Manager / system — so a manager's page server-rendered (it only needs `read`) and then
 * every month change, every filter and every Export press came back 403 "You do not have permission
 * to view this report". Fail-closed, so nothing leaked; it simply did not work for the audience it
 * was built for, which reads to a manager as a broken report.
 *
 * `read` is what every other portal sales surface asks (weekly sales, weekly stock, targets, sales
 * vs target, source of sales, territory drilldown), and the admin closing already relaxes the same
 * way for its read-only audience (`access.role === "CEO" ? "read" : "import"`). The export route
 * asserts `sales:export` beside this one, which all three roles hold.
 *
 * Pinned by `tests/closing-performance-review-export-gate.test.ts`, which asserts every role in each
 * audience actually holds what its own audience asserts.
 */
export function performanceReviewSalesAction(isAdminAudience: boolean): "import" | "read" {
  return isAdminAudience ? "import" : "read";
}

/** The refusal both routes give anyone neither gate admits. */
export const CLOSING_PERFORMANCE_REVIEW_AUDIENCE_MESSAGE =
  "The Performance Review is available to the Super Admin, the SFE Manager, and each sales manager "
  + "for their own territory.";
