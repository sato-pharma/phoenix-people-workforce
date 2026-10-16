import {
  adminShellEmployeeRoles,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import {
  canAccessAdminShellEmployeeWorkspacePage,
  workspaceExpenseDashboardRoles,
} from "@/lib/workspace/admin-shell-employee-roles";

/**
 * THE personal workspace tab set — what an admin-shell person can do about THEMSELVES.
 *
 * ## Why this file exists
 *
 * Admin-shell roles have no employee portal, so their own payslip, incentive, deductions, vacation
 * balance, expenses and calendar live under `/workspace/*`. Twenty of those pages exist and work.
 * Before 2026-08-30, **fourteen of them were reachable from nowhere at all** — no sidebar row, no
 * hub card, and nothing outside their own directory linking to them (measured with `git grep`, not
 * inferred). Only "Request Vacation" and "Submit Excuse" had doors, and `WorkspaceFrame` carried no
 * navigation of any kind, so even landing on one by typed URL was a dead end: there was no route to
 * a second. Fifteen working pages, two of them reachable.
 *
 * This list is what fixes that. It is the one place naming the personal pages, so the tab strip and
 * the account menu cannot drift apart about which ones exist.
 *
 * ## The rule that makes it safe
 *
 * **Every entry mirrors its page's own `requireAdminShellEmployeeWorkspaceAccess` call verbatim.**
 * That guard `redirect()`s on refusal with no message, so a tab shown to someone the page will
 * bounce does not read as "not for you" — it reads as the app throwing you out. Copy the gate; do
 * not approximate it.
 *
 * `resolvePersonalWorkspaceTabs` reproduces both halves of that guard, in the same order:
 *   1. `canAccessAdminShellEmployeeWorkspacePage(role, allowedRoles)` — Super Admin always passes,
 *      everyone else must be named in the list the page passes.
 *   2. the resource check — and `canAccess` returns TRUE unconditionally when `scope === "system"`,
 *      so this must too, or the Super Admin would be shown fewer tabs than the pages will serve him.
 *
 * Adding a page under `app/(admin)/workspace/`? Add it here with the guard it actually uses.
 * `tests/personal-workspace-nav.test.ts` reads both files and fails when they disagree.
 *
 * ## What is deliberately NOT here
 *
 * - `/workspace/marketing-requests` and its inbox and decision pages — real sidebar rows, kept on
 *   the rail on 2026-08-30, and the inbox carries a live pending badge that a tab cannot show. They
 *   are module work that happens to render in this frame, not facts about you.
 * - `/workspace/vacancies` — a company report, not your own record. It duplicates a page that
 *   already exists elsewhere in the admin shell; that duplication is a Phase 2 question, and giving
 *   it a second door here would make it harder to answer, not easier.
 * - `/workspace/organogram` — gone already. It was the THIRD mounting of one report and was retired
 *   to a redirect earlier on 2026-08-30. Its route resolves to no page component at all now, so
 *   listing it here would be a tab pointing at a redirect.
 */
export type PersonalWorkspaceTabGroup = "expenses" | "help" | "me" | "pay" | "time" | "work";

export type PersonalWorkspaceTab = {
  /** Mirrors the page's guard: the action it asks `canAccess` for. Omit for the default "read". */
  action?: PermissionAction;
  /** Mirrors the page's guard: `allowedRoles`. Omit to mean the default `adminShellEmployeeRoles`. */
  allowedRoles?: readonly PhoenixRole[];
  /** Only groups the strip visually — a hairline between groups. It gates nothing. */
  group: PersonalWorkspaceTabGroup;
  href: string;
  /** Short — the strip is one scrolling line and no label may wrap or be truncated. */
  label: string;
  /** Mirrors the page's guard: the resource it asks `canAccess` for. Omit when it asks for none. */
  resource?: PermissionResource;
};

/**
 * Order is how a person meets their own record: what am I looking at, what am I paid, what did I
 * ask for and where was I, what am I planning, what did I spend, who do I ask. `group` draws a
 * hairline between those runs so fifteen tabs stay scannable as five short ones.
 */
// Annotated, not `as const satisfies`. Both check every entry against the shape, but `as const`
// infers a union of fifteen literal object types, and `action` and `allowedRoles` are optional — so
// on that union they exist on SOME members and are therefore unreadable on the union itself
// (TS2339, which is what CI caught). `resolvePersonalWorkspaceTabs` below has to read both to
// mirror each page's guard, and so does the test that checks it against the page sources. Nothing
// consumes the literal hrefs — `personalWorkspaceEntryHref` returns `string | null` and the tests
// compare them as strings — so the annotation costs nothing and is the form the readers need.
export const personalWorkspaceTabs: readonly PersonalWorkspaceTab[] = [
  { group: "me", href: "/workspace", label: "Dashboard", resource: "employee_profile" },
  { group: "me", href: "/workspace/private-calendar", label: "My Calendar", resource: "employee_profile" },

  { group: "pay", href: "/workspace/payslips", label: "Payslips", resource: "payslips" },
  { group: "pay", href: "/workspace/incentive", label: "Incentive", resource: "incentive" },
  { group: "pay", href: "/workspace/deductions", label: "Deductions", resource: "employee_profile" },

  {
    action: "create",
    group: "time",
    href: "/workspace/leave-management/vacation-request",
    label: "Request Vacation",
    resource: "leave",
  },
  {
    group: "time",
    href: "/workspace/leave-management/vacation-report",
    label: "Vacation Report",
    resource: "leave",
  },
  { group: "time", href: "/workspace/excuses", label: "Excuses", resource: "employee_profile" },
  { group: "time", href: "/workspace/fingerprint-report", label: "Fingerprint", resource: "attendance" },

  { group: "work", href: "/workspace/plans", label: "My Plans", resource: "weekly_plans" },
  { group: "work", href: "/workspace/plans/calendar", label: "Planning Calendar", resource: "weekly_plans" },
  { group: "work", href: "/workspace/probation", label: "Probation", resource: "probation" },

  {
    action: "create",
    group: "expenses",
    href: "/workspace/submit-expense",
    label: "Submit Expense",
    resource: "outstation",
  },
  {
    allowedRoles: workspaceExpenseDashboardRoles,
    group: "expenses",
    href: "/workspace/expense-dashboard",
    label: "My Expenses",
    resource: "expenses",
  },

  {
    action: "create",
    group: "help",
    href: "/workspace/contact-hr-support",
    label: "Contact HR",
    resource: "support_requests",
  },
];

/** The `"resource:action"` lookup the app shell already builds with `buildPermissionLookup`. */
export type PersonalWorkspacePermissionLookup = Record<string, boolean | undefined>;

/**
 * Which personal tabs this viewer can actually open.
 *
 * Reproduces `requireAdminShellEmployeeWorkspaceAccess` rather than guessing at it — see the note
 * above.
 *
 * The `scope === "system"` short-circuit mirrors `canAccess`, which returns true unconditionally on
 * that scope. It is easy to misread as the Super Admin's fast path — it is not. `scopeForRole`
 * returns `"system"` for NOBODY: a signed-in Super Admin is `"company"`-scoped and reaches all
 * fifteen tabs through the matrix like everyone else. `"system"` belongs to `systemAccessContext`,
 * the identity crons and imports run as, which never renders a tab strip. The line is here so this
 * resolver and the gate it mirrors cannot give one context two different answers — not because any
 * screen depends on it. Keep it for that reason, and do not "simplify" it away as dead.
 */
export function resolvePersonalWorkspaceTabs(
  access: Pick<AccessContext, "role" | "scope">,
  lookup: PersonalWorkspacePermissionLookup,
): readonly PersonalWorkspaceTab[] {
  return personalWorkspaceTabs.filter((tab) => {
    if (!canAccessAdminShellEmployeeWorkspacePage(access.role, tab.allowedRoles ?? adminShellEmployeeRoles)) {
      return false;
    }
    if (!tab.resource) return true;
    if (access.scope === "system") return true;
    return lookup[`${tab.resource}:${tab.action ?? "read"}`] === true;
  });
}

/**
 * Where the account menu's workspace entry should point, or null when this viewer has no personal
 * workspace and the entry must not be offered at all.
 *
 * One function answers both questions on purpose. A separate "do they have one?" boolean beside a
 * hard-coded `/workspace` would be two things that can disagree, and the way they disagree is a
 * menu entry that lands on a page the guard then bounces you off — the defect this whole module
 * exists to prevent. The first tab a viewer can open is by construction a page that will admit
 * them.
 *
 * Null for the CEO by design: he is an executive account, not an employee with a payslip, and
 * `adminShellEmployeeRoles` has never included him, so every one of these pages would refuse him.
 */
export function personalWorkspaceEntryHref(
  access: Pick<AccessContext, "role" | "scope">,
  lookup: PersonalWorkspacePermissionLookup,
): string | null {
  return resolvePersonalWorkspaceTabs(access, lookup)[0]?.href ?? null;
}

/**
 * The tab a pathname belongs to, or null.
 *
 * Two rules, and each is a bug that was measured rather than imagined:
 *
 * - **The root `/workspace` matches ONLY exactly.** It is a prefix of every other entry, so prefix
 *   matching made Dashboard read as current on pages that are not tabs at all — the marketing
 *   request pages share this frame and highlighted it.
 * - **Otherwise the longest match wins**, so `/workspace/plans/calendar` is Planning Calendar and
 *   not My Plans, while `/workspace/payslips/2026-08` still resolves to Payslips.
 */
export function activePersonalWorkspaceTab(pathname: string): PersonalWorkspaceTab | null {
  let best: PersonalWorkspaceTab | null = null;
  for (const tab of personalWorkspaceTabs) {
    const hit =
      tab.href === "/workspace"
        ? pathname === tab.href
        : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (!hit) continue;
    if (!best || tab.href.length > best.href.length) best = tab;
  }
  return best;
}
