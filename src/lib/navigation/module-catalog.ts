/**
 * The MODULE catalogue — one human name per permission resource, and the map from an address to
 * the module that owns it.
 *
 * Two consumers, both of them the temporary module-lock feature:
 *   • the admin screen, which offers the system administrator a list of modules to lock, by NAME
 *     (owner's standing rule: human-readable names, never raw codes);
 *   • the two shells, which need "what module is this page" to decide whether to render the page or
 *     the lock notice.
 *
 * THE ADDRESS MAP IS DERIVED, NEVER HAND-KEPT. It is built from the navigation configuration that
 * already exists — every sidebar item in all three modes, every hub card, and the portal registry —
 * so a page added to the sidebar tomorrow is covered on the day it ships. A hand-written list of
 * paths would be correct on the day it was written and quietly wrong afterwards, and the failure
 * shape is the worst one available here: a locked person opening a page that was never mapped and
 * being let straight in.
 *
 * The mapping is UX-critical rather than security-critical, and the difference matters. Even if a
 * page is not in the map at all, its own `assertPermission` still refuses a locked module — the
 * viewer just gets a plain "Forbidden" instead of the lock sentence. The security boundary is
 * `canAccess`; this file decides how nicely the refusal is worded.
 */

import {
  getNavigationSections,
  hubPageItemGroups,
  type NavigationPermission,
} from "@/config/system-navigation";
import { PORTAL_NAV_REGISTRY } from "@/components/employee-portal/employee-portal-nav-registry";
import { permissionResources, type PermissionResource } from "@/lib/auth/permissions";
import { personalWorkspaceTabs } from "@/lib/workspace/personal-workspace-nav";

/**
 * What each module is CALLED. Every permission resource has an entry — the union and this record
 * are kept in step by tests/module-locks.test.ts at RUNTIME, because an exhaustive `Record`
 * does not gate the build in this repo (`ignoreBuildErrors`), so a missing key would compile, ship,
 * and render an empty module name in the lock picker.
 */
export const MODULE_LABELS: Record<PermissionResource, string> = {
  account_activation: "Account Activation",
  admin: "Administration",
  admin_access: "Users & Access",
  spotlight: "Spotlight",
  spotlight_self: "My Spotlight",
  performance_card_self: "My Performance Card",
  attendance: "Attendance",
  business_card_requests: "Business Card Requests",
  candidates: "Candidates",
  coaching: "Coaching",
  communication: "Email & Telegram Communication",
  // Its own label, never folded into "Candidates" above: the two are different authorities over the
  // same people — Candidates is the pool, CV Lookup is a search box for a seat that may not have the
  // pool (owner, 2026-09-30). Sharing a label would make the module lock picker offer one name for
  // two grants, so locking "Candidates" would read as locking both.
  cv_lookup: "CV Lookup",
  company_devices: "Device Custody",
  contracts: "Contracts",
  crm_contact_lists: "Doctor List Changes",
  crm_plans: "Plan Verification",
  crm_visit_entry: "Visit Entry",
  crm_visits: "CRM Visits",
  // Its own label, never folded into any of the five CRM entries above: those are iReports360's
  // data and Phoenix CRM's visit entry, while this one is the Super-Admin review of WHO IS THE SAME
  // PERSON across Phoenix CRM, marketing and direct orders. Locking one must never read as locking
  // the other. This record is exhaustive over `PermissionResource`, so the typecheck is what
  // demanded this line the moment the resource was added — and that is the guard working.
  customer_identity: "Customer Links",
  deductions: "Deductions",
  direct_orders: "Direct Orders",
  double_visit_analytics: "Double Visit Analytics",
  rep_product_achievement: "Rep Achievement by Product",
  coaching_skills_survey: "Team Coaching Skills Survey",
  early_birds: "Early Birds",
  field_absence: "Field Absence Calendar",
  employee_documents: "Employee Documents",
  employee_profile: "Employee Profile",
  employees: "Employee Records",
  expenses: "Expenses & Marketing Requests",
  hiring_interviews: "Hiring Interviews",
  hr_calendar: "HR Calendar",
  hr_reminders: "HR Reminders",
  hr_ops_reports: "HR Daily & Weekly Reports",
  imports: "Data Imports",
  internal_messages: "Messages",
  incentive: "Incentive",
  leave: "Leave & Vacations",
  mailbox_monitor: "Mailbox Monitor",
  mailbox_offboarding: "Mailbox Revocation",
  market_awareness: "Market Awareness",
  marketing_functions: "Marketing Functions",
  marketing_field_feedback: "Marketing Field Feedback",
  milestones: "Milestones",
  offers: "Offers",
  organogram: "Organogram",
  outstation: "Outstation",
  overview: "Overview & Command Centers",
  payroll: "Payroll",
  payslips: "Payslips",
  permission_admin: "Permission Administration",
  phoenix_crm: "Phoenix CRM",
  probation: "Probation",
  production_planning: "Production Planner",
  recruitment: "Recruitment",
  report_it: "Report It",
  resignations: "Resignations",
  retention: "Retention Register",
  sales: "Sales",
  support_requests: "Support Requests",
  synthetic_journeys: "Synthetic Journeys",
  system_cleanup: "System Cleanup",
  team: "My Team",
  territory: "Territory Management",
  user_activity: "User Activity",
  user_admin: "User Administration",
  vacancies: "Vacancies",
  visual_aids: "Visual Aids",
  weekly_plans: "Weekly & Monthly Plans",
  weekly_sales: "Weekly Sales",
  workflow_registry: "Workflow Registry",
};

/** A module's display name, falling back to the raw key so an unknown value is still legible. */
export function moduleLabel(key: string): string {
  return MODULE_LABELS[key as PermissionResource] ?? key;
}

export type ModuleCatalogEntry = {
  key: PermissionResource;
  label: string;
};

/** Every lockable module, by name, for the admin picker. */
export function listModules(): ModuleCatalogEntry[] {
  return permissionResources
    .map((key) => ({ key, label: MODULE_LABELS[key] ?? key }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

// ── Address → module ──────────────────────────────────────────────────────────

type HrefPermissionEntry = {
  href: string;
  resources: PermissionResource[];
};

function toResources(permissions: readonly NavigationPermission[] | undefined): PermissionResource[] {
  return Array.from(new Set((permissions ?? []).map((permission) => permission.resource)));
}

let hrefIndex: HrefPermissionEntry[] | null = null;

function buildHrefIndex(): HrefPermissionEntry[] {
  const byHref = new Map<string, Set<PermissionResource>>();

  function add(href: string, resources: PermissionResource[]) {
    if (!href.startsWith("/") || resources.length === 0) return;
    // Query strings and hashes name a TAB, never a different module.
    const path = href.split("#")[0].split("?")[0];
    const existing = byHref.get(path) ?? new Set<PermissionResource>();
    resources.forEach((resource) => existing.add(resource));
    byHref.set(path, existing);
  }

  for (const mode of ["admin", "employee-portal", "hr"] as const) {
    for (const section of getNavigationSections(mode)) {
      for (const item of section.items) add(item.href, toResources(item.permissions));
    }
  }

  for (const group of hubPageItemGroups) {
    for (const item of group.items) add(item.href, toResources(item.permissions));
  }

  for (const entry of PORTAL_NAV_REGISTRY) {
    add(entry.href, toResources(entry.permission ? [entry.permission] : undefined));
  }

  // The admin shell's personal workspace (/workspace/incentive, /workspace/payslips, …). Those pages
  // have no sidebar row of their own — they are tabs inside the workspace frame — so without this
  // they inherit the bare /workspace address and a locked person is redirected away without ever
  // reading the lock sentence. The root tab is skipped: it is a prefix of every other workspace
  // page, so mapping it would only dilute the OR rule for the whole subtree.
  for (const tab of personalWorkspaceTabs) {
    if (tab.href === "/workspace") continue;
    add(tab.href, tab.resource ? [tab.resource] : []);
  }

  return Array.from(byHref.entries()).map(([href, resources]) => ({
    href,
    resources: Array.from(resources),
  }));
}

function getHrefIndex(): HrefPermissionEntry[] {
  if (!hrefIndex) hrefIndex = buildHrefIndex();
  return hrefIndex;
}

/**
 * Which modules own this address — the DEEPEST matching navigation entry wins, so
 * `/employee-portals/direct-orders/report` resolves to the report's own module rather than the
 * portal root's. A page with no navigation entry of its own inherits its nearest ancestor's, which
 * is what detail pages want: `/employees/A-12` is the Employee Records module.
 *
 * Returns [] for an address no navigation entry covers.
 */
export function resolveModulesForPath(pathname: string): PermissionResource[] {
  const path = String(pathname ?? "").split("#")[0].split("?")[0];
  if (!path.startsWith("/")) return [];

  let best: HrefPermissionEntry | null = null;
  for (const entry of getHrefIndex()) {
    const matches = path === entry.href || path.startsWith(`${entry.href}/`);
    if (!matches) continue;
    if (!best || entry.href.length > best.href.length) best = entry;
  }
  return best ? best.resources : [];
}

/**
 * The module standing between this viewer and this address, given the set of modules locked for
 * them. Null when the page is not locked.
 *
 * A page gated by SEVERAL resources is offered on an OR — `permissionAllowed` in active-path.ts
 * admits a viewer who holds any one of them — so it is only closed when every one of them is
 * locked. Locking `overview` alone must not close a page the viewer can still reach through
 * `admin`.
 */
export function resolveLockedModuleForPath(
  pathname: string,
  lockedModuleKeys: readonly string[],
): PermissionResource | null {
  if (lockedModuleKeys.length === 0) return null;
  const modules = resolveModulesForPath(pathname);
  if (modules.length === 0) return null;

  const locked = new Set(lockedModuleKeys);
  if (!modules.every((module) => locked.has(module))) return null;
  return modules[0];
}

/**
 * Is this navigation ROW's module locked? The padlock rule, kept here beside the address map rather
 * than in the React context that consumes it — a `.tsx` file cannot be imported by the Node test
 * harness, and this is the rule most worth pinning.
 *
 * A row gated by SEVERAL permissions is offered on an OR (`permissionAllowed` in active-path.ts),
 * so it is padlocked only when EVERY one of them is locked — the same rule the page-level check
 * uses, kept identical on purpose so a padlock never appears on a tab that still opens.
 *
 * A row carrying no permissions falls back to its ADDRESS. Two whole surfaces need that: every
 * employee-portal row is built from visibility flags and carries no permission metadata at all, and
 * a few admin rows are gated by role alone. Without the fallback those tabs would look open and
 * then land on the lock notice.
 */
export function isNavItemLockedFor(
  item: { href?: string; permissions?: readonly NavigationPermission[] },
  lockedModuleKeys: readonly string[],
): boolean {
  if (lockedModuleKeys.length === 0) return false;
  const permissions = item.permissions;
  if (permissions && permissions.length > 0) {
    const locked = new Set(lockedModuleKeys);
    return permissions.every((permission) => locked.has(permission.resource));
  }
  if (!item.href) return false;
  return resolveLockedModuleForPath(item.href, lockedModuleKeys) !== null;
}
