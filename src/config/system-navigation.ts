import {
  Activity,
  Archive,
  BellRing,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  ClipboardList,
  Download,
  Columns3,
  Database,
  FileCheck2,
  FilePlus2,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  HeartPulse,
  Hourglass,
  IdCard,
  Inbox,
  Package,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MailCheck,
  MousePointerClick,
  MapPinned,
  Megaphone,
  MessageSquareText,
  Network,
  PlusCircle,
  Radar,
  ReceiptText,
  Scale,
  ScrollText,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Tags,
  Target,
  TriangleAlert,
  Trash2,
  UserCog,
  UsersRound,
  Waypoints,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  type NavigationMode,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";

export type NavigationPermission = {
  action?: PermissionAction;
  resource: PermissionResource;
};

export type NavigationSectionItem = {
  href: `/${string}`;
  icon: LucideIcon;
  label: string;
  moduleId: string;
  excludedRoles?: readonly PhoenixRole[];
  roles?: readonly PhoenixRole[];
  permissions?: readonly NavigationPermission[];
  /**
   * Active-route matching hints (consumed by `isActivePath` in
   * `@/lib/navigation/active-path`). `exact` highlights the item ONLY when the
   * pathname equals its href base (prevents a parent route from staying active on
   * its children, e.g. `/sales` vs `/sales/import`). `activeTab` highlights the
   * item only when the sidebar's active query-param tab matches (for two items
   * that share the same path but differ by `?tab=`/`?action=`).
   */
  exact?: boolean;
  activeTab?: string;
  navBadge?: "approvals-hub-pending" | "vacation-approvals-pending" | "excuse-approvals-pending" | "plan-approvals-pending";
};

export type NavigationSection = {
  id: string;
  items: readonly NavigationSectionItem[];
  label: string;
};

type NavigationSectionItemSeed = Omit<NavigationSectionItem, "moduleId"> & {
  moduleId?: string;
};

type NavigationSectionSeed = Omit<NavigationSection, "items"> & {
  items: readonly NavigationSectionItemSeed[];
};

function moduleIdPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function defaultModuleId(mode: NavigationMode, section: NavigationSectionSeed, item: NavigationSectionItemSeed) {
  const prefix = mode === "employee-portal" ? "portal" : "admin";
  const labelPart = moduleIdPart(item.label);
  const hrefPart = moduleIdPart(item.href);
  const tabPart = item.activeTab ? `_${moduleIdPart(item.activeTab)}` : "";
  return `${prefix}.${moduleIdPart(section.id)}.${labelPart}.${hrefPart}${tabPart}`;
}

function withModuleIds(
  mode: NavigationMode,
  sections: readonly NavigationSectionSeed[],
): readonly NavigationSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({
      ...item,
      moduleId: item.moduleId ?? defaultModuleId(mode, section, item),
    })),
  }));
}

const hrAuthorityNavigationRoles = ["Super Admin", "Talent Acquisition"] as const satisfies readonly PhoenixRole[];
const companyPayrollNavigationRoles = ["Super Admin", "Finance Manager"] as const satisfies readonly PhoenixRole[];
const systemAdministratorNavigationRoles = ["Super Admin"] as const satisfies readonly PhoenixRole[];
// Confirmed Vacation/Excuse approver roles that land in the ADMIN shell. Portal-shell
// approvers (District/Regional/National Sales Manager, PM/GPM, Marketing Manager, Manager)
// see the same two links via the portal sidebar (employee-portal-layout.tsx flags).
const leaveExcuseApproverAdminNavigationRoles = [
  "Super Admin",
  "CEO",
  "Finance Manager",
  "Financial Advisor",
] as const satisfies readonly PhoenixRole[];
const vacationApproverPortalNavigationRoles = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Manager",
] as const satisfies readonly PhoenixRole[];
// Excuse is deliberately its own list, NOT shared with vacation above: it drops National Sales
// Manager, District Manager and Regional Manager. Excuse is a Head-Office / fingerprint-attendance
// module and is direct-manager-only, so no field-ladder role ever has anything to decide here.
// DSM/RM removed by owner decision 2026-07-30 — enforced server-side by EXCUSE_EXCLUDED_ROLES in
// src/lib/excuses/service.ts; this list only controls the sidebar link. Keep the two lists split so
// a future vacation change can never silently re-grant excuse (or vice versa).
const excuseApproverPortalNavigationRoles = [
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Manager",
] as const satisfies readonly PhoenixRole[];
// Weekly / Monthly Plan Approvals — admin shell: only the CEO (stage-2 approver) and Super Admin
// (HR acknowledge). Finance Manager / Financial Advisor are NOT plan approvers.
const planApproverAdminNavigationRoles = ["Super Admin", "CEO"] as const satisfies readonly PhoenixRole[];
// Portal shell: plan submitters + their managers (mirrors the plan builder link's roles). Q4 —
// pure submitters (e.g. a District Manager) get the link too, for their own "My Requests" tab.
const planApproverPortalNavigationRoles = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Manager",
] as const satisfies readonly PhoenixRole[];

export const navigationHomePathByMode: Record<NavigationMode, `/${string}`> = {
  admin: "/admin/access",
  "employee-portal": "/employee-portals",
};

const adminNavigationSectionSeeds = [
  // ── Tier 1: Executive overview ────────────────────────────────────────────────
  // Items ordered: primary dashboard → intelligence → monitoring → audit → admin tools → destructive
  {
    id: "command-center",
    items: [
      { href: "/admin/ceo-command-center", icon: LayoutDashboard, label: "CEO Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["CEO"] },
      { href: "/admin/sfe-command-center", icon: LayoutDashboard, label: "SFE Manager Overview", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["SFE Manager"] },
      { href: "/business-review-s1", icon: LayoutDashboard, label: "S1 Business Review", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["CEO", "SFE Manager", "Super Admin"] },
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }], roles: ["CEO"] },
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], excludedRoles: ["CEO"] },
    ],
    label: "Command Center",
  },
  {
    id: "ceo-probation",
    items: [
      { href: "/admin/ceo-probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["CEO"] },
    ],
    label: "Probation",
  },
  {
    id: "ceo-company-calendar",
    items: [
      { href: "/admin/weekly-plans/calendar", icon: CalendarRange, label: "Company Calendar", permissions: [{ resource: "weekly_plans", action: "read" }], roles: ["CEO"] },
    ],
    label: "Company Calendar",
  },
  {
    id: "ceo-recruitment-candidates",
    items: [
      { href: "/recruitment/candidates", icon: BriefcaseBusiness, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["CEO"] },
    ],
    label: "Hiring",
  },

  // ── Employee 360: one consolidated, scoreable view per employee. v1 surfaces
  // field visits, campaign-vs-regular balance, and GPS check-in timing. Gated by
  // employee_profile:read (held broadly, incl. managers/HR); the page itself
  // enforces per-row visibility via canSeeEmployee, so a manager only opens their
  // own reports and Super Admin/CEO see their scope — sidebar visibility is UX only.
  {
    id: "employee-360",
    items: [
      {
        href: "/employee-360",
        icon: IdCard,
        label: "Employee 360",
        permissions: [{ resource: "employee_profile", action: "read" }],
      },
      {
        href: "/admin/pm-products",
        icon: Package,
        label: "PM Product Master",
        permissions: [{ resource: "employee_profile", action: "read" }],
        roles: ["Super Admin", "CEO", "SFE Manager"],
      },
    ],
    label: "Employee 360",
  },

  // ── Approvals Hub: consolidated per-module approval surfaces (near the top —
  // responding to approvals is frequent daily work). Phase 1: Vacation + Excuse.
  // "Other Approvals" (resignation/outstation/contract/plan combined inbox) was
  // moved here from the People Management hub page so all approval surfaces are
  // reachable from one sidebar group.
  {
    id: "approvals-hub",
    items: [
      { href: "/admin/approvals/vacation", icon: CalendarCheck, label: "Vacation Approvals", permissions: [{ resource: "leave", action: "read" }], roles: leaveExcuseApproverAdminNavigationRoles, navBadge: "vacation-approvals-pending" },
      { href: "/admin/approvals/excuse", icon: CalendarClock, label: "Excuse Approvals", permissions: [{ resource: "leave", action: "read" }], roles: leaveExcuseApproverAdminNavigationRoles, navBadge: "excuse-approvals-pending" },
      { href: "/admin/approvals/plan", icon: CalendarRange, label: "Weekly / Monthly Plan Approvals", permissions: [{ resource: "weekly_plans", action: "read" }], roles: planApproverAdminNavigationRoles, navBadge: "plan-approvals-pending" },
      { href: "/admin/approvals/direct-orders", icon: ReceiptText, label: "Direct Orders Approvals", permissions: [{ resource: "direct_orders", action: "approve" }] },
      { href: "/admin/approvals-hub", icon: Inbox, label: "Other Approvals", permissions: [{ resource: "leave", action: "read" }], navBadge: "approvals-hub-pending" },
    ],
    label: "Approvals Hub",
  },

  // ── Tier 1b: Admin Tools ──────────────────────────────────────────────────────
  // Collapsed to a single sidebar entry that opens the Admin Tools hub
  // (app/(admin)/admin/admin-tools/page.tsx), which renders the individual tools
  // below (`adminToolsPageItems`) as cards. The gate here is the least-restrictive
  // of those tools' own gates so the button shows whenever any tool would be
  // reachable; the hub page re-filters per-tool with the exact same permission/role
  // fields, and every destination page still enforces its own access check
  // server-side (sidebar/hub visibility is UX, never the security boundary).
  {
    id: "admin-tools",
    items: [
      // Hardcoded role (not permissions:[{resource:"admin"}]) — matches the strictest of the
      // tools it replaces (System Cleanup/Data Backup/Modules Control/Workflow Control were
      // always Super-Admin-only, never override-eligible) and keeps the entry point robust to
      // a stale permission-cache read even without the isSystemAdministratorWorkspace bypass
      // (see the "navigation active path" test suite).
      { href: "/admin/admin-tools", icon: Wrench, label: "Admin Tools", roles: ["Super Admin"] },
    ],
    label: "Admin Tools",
  },

  // ── Tier 3: Role-specific workspaces (Marketing Manager / SFE / Finance) ────
  // Collapsed to a single standalone sidebar button that opens the Marketing &
  // ROI hub (app/(admin)/admin/marketing-roi/page.tsx, items in
  // marketingRoiPageItems below) — same pattern as the other consolidated
  // sections above. roles is the union of every card's own role (none of these
  // items had a permissions field, only roles); the hub re-filters per-card.
  {
    id: "workspace-marketing-requests",
    items: [
      { href: "/admin/marketing-roi", icon: Megaphone, label: "Marketing & ROI", roles: ["Super Admin", "CEO", "SFE Manager", "District Manager"] },
      // ROI Tracker is pulled OUT of the hub and onto the sidebar directly: it is the ROI source
      // of truth, and burying it one click inside a hub of four competing ROI cards was the
      // discoverability problem this module set out to fix. The role list mirrors
      // assertMarketingAdminPageAccess({ allowCompanyOversight: true }) exactly — note the hub
      // button above admits neither Finance Manager nor Financial Advisor, so before this entry
      // the finance roles the guard allows had no sidebar route to the page at all. Row-level
      // visibility is still scoped per viewer inside getMarketingRoiReport; this widens nothing.
      {
        href: "/admin/marketing-roi-tracker",
        icon: Target,
        label: "ROI Tracker",
        roles: [
          "Super Admin",
          "CEO",
          "SFE Manager",
          "Marketing Manager",
          "Product Manager",
          "Group Product Manager",
          "Finance Manager",
          "Financial Advisor",
        ],
      },
    ],
    label: "Marketing & ROI",
  },

  // ── Tier 4: HR & People ───────────────────────────────────────────────────────
  // Items ordered: time-sensitive actions → headcount records → lifecycle events → compliance
  // Mostly collapsed to a single standalone sidebar button that opens the People
  // Management hub (app/(admin)/admin/people-management/page.tsx, items in
  // peopleManagementPageItems below) — same pattern as the other consolidated
  // sections above. Organogram/Probation/Workforce Compliance were pulled back
  // out to direct sidebar links (frequent, standalone lookups), so the button's
  // permission union only covers the cards still living inside the hub; its
  // navBadge is a general "something's due" indicator (contract renewals /
  // resignations), not tied to any single card.
  {
    id: "people-management",
    items: [
      {
        href: "/admin/people-management",
        icon: UsersRound,
        label: "People Management",
        navBadge: "approvals-hub-pending",
        permissions: [
          { resource: "leave", action: "read" },
          { resource: "employees" },
          { resource: "vacancies" },
          { resource: "contracts" },
          { resource: "resignations" },
          { resource: "weekly_plans" },
          { resource: "support_requests" },
        ],
      },
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }], excludedRoles: ["Marketing Manager", "CEO"] },
      { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }], excludedRoles: ["Marketing Manager", "CEO"] },
      // Decision-intelligence surfaces. Dashboard + Analytics require company-wide probation read
      // (canReadAllProbation → Super Admin / CEO / Training Manager / Marketing Manager); Settings is
      // administrator-only (isProbationAdministrator → Super Admin). Roles kept in sync with the page gates
      // so managers/reps who'd be redirected never see a dead link.
      { href: "/probation/dashboard", icon: LayoutDashboard, label: "Probation Dashboard", permissions: [{ resource: "probation", action: "read" }], roles: ["Super Admin", "Training Manager", "Marketing Manager"] },
      { href: "/probation/analytics", icon: Activity, label: "Probation Analytics", permissions: [{ resource: "probation", action: "read" }], roles: ["Super Admin", "Training Manager", "Marketing Manager"] },
      { href: "/admin/probation-settings", icon: Settings2, label: "Probation Settings", permissions: [{ resource: "probation", action: "update" }], roles: ["Super Admin"] },
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }] },
    ],
    label: "People Management",
  },
  // Collapsed to a single standalone sidebar button that opens the Recruitment &
  // Hiring hub (app/(admin)/admin/recruitment-hiring/page.tsx, items in
  // recruitmentHiringPageItems below) — same pattern as the other consolidated
  // sections above. All four items share the exact same roles, so the button's
  // gate is just that same role list.
  {
    id: "recruitment-hiring",
    items: [
      { href: "/admin/recruitment-hiring", icon: BriefcaseBusiness, label: "Recruitment & Hiring", roles: hrAuthorityNavigationRoles },
    ],
    label: "Recruitment & Hiring",
  },
  // Collapsed to a single sidebar entry that opens the Attendance Management hub
  // (app/(admin)/attendance/page.tsx), which renders the individual tools below
  // (attendanceManagementPageItems) as cards — same pattern as Admin Tools /
  // Access & Communication / Weekly Sales / Customers Database above. permissions
  // is the union of every card's own gate (employees:read/update, attendance:read,
  // hr_calendar:read) so the button shows whenever any card would be reachable;
  // the hub re-filters per-card with each card's real gate.
  {
    id: "attendance-management",
    items: [
      {
        href: "/attendance",
        icon: Fingerprint,
        label: "Attendance Management",
        permissions: [
          { resource: "employees" },
          { resource: "employees", action: "update" },
          { resource: "attendance", action: "read" },
          { resource: "hr_calendar" },
        ],
      },
    ],
    label: "Attendance Management",
  },
  // Collapsed to a single standalone sidebar button that opens the Leave
  // Management hub (app/(admin)/leave-management/page.tsx, items in
  // leaveManagementPageItems below) — same pattern as the other consolidated
  // sections above. roles is the union of the three cards' own roles
  // (hrAuthorityNavigationRoles ∪ ["Super Admin","CEO"]); the hub re-filters
  // per-card with each card's real gate.
  {
    id: "leave-management",
    items: [
      { href: "/leave-management", icon: CalendarDays, label: "Leave Management", roles: ["Super Admin", "CEO", "Talent Acquisition"] },
      // Vacation Action Center removed — replaced by the Approvals Hub › Vacation Approvals surface.
    ],
    label: "Leave Management",
  },
  // Collapsed to a single standalone sidebar button that opens the Payroll
  // Management hub (app/(admin)/admin/payroll-management/page.tsx, items in
  // payrollManagementPageItems below) — same pattern as the other consolidated
  // sections above. No roles field here (unlike Admin Tools) because Deductions
  // Governance has no role restriction of its own; permissions is the union of
  // every card's own gate so the button shows whenever any card would be
  // reachable, and the hub re-filters per-card with each card's real gate.
  // Employee-portal payroll (Payslips/Deductions under employeePortalNavigation
  // SectionSeeds) is a separate, unrelated section and is intentionally untouched.
  {
    id: "payroll",
    items: [
      {
        href: "/admin/payroll-management",
        icon: FileSpreadsheet,
        label: "Payroll Management",
        permissions: [{ resource: "payroll" }, { resource: "payslips" }, { resource: "deductions", action: "read" }],
      },
    ],
    label: "Payroll Management",
  },

  // Automated Payroll — the HR-owned stepped monthly-salary wizard (Part 1 / Part 2 /
  // publish). The wizard is Super Admin (HR) only; the Finance tab is a read/export-only
  // locked-sheet download for CEO / Financial Advisor / Finance Manager. Role-gated per
  // item; server routes + pages re-enforce (sidebar visibility is UX, never the boundary).
  {
    id: "automated-payroll",
    items: [
      {
        href: "/admin/automated-payroll",
        icon: FileSpreadsheet,
        label: "Automated Payroll",
        roles: ["Super Admin"],
      },
      {
        href: "/admin/automated-payroll/finance",
        icon: ScrollText,
        label: "Payroll — Finance",
        roles: ["CEO", "Financial Advisor", "Finance Manager", "Super Admin"],
      },
    ],
    label: "Automated Payroll",
  },

  // ── Tier 5: Field operations ──────────────────────────────────────────────────
  // Items ordered: overview → active queue → data entry → historical → config
  // Collapsed to a single standalone sidebar button that opens the Outstation
  // Expenses hub (app/(admin)/admin/outstation-expenses/page.tsx, items in
  // outstationExpensesPageItems below) — same pattern as the other consolidated
  // sections above. All six items shared roles drawn from the same three-role
  // set (Super Admin / Finance Manager / CEO), so the button's gate is that union.
  {
    id: "expenses-outstation",
    items: [
      { href: "/admin/outstation-expenses", icon: Radar, label: "Outstation Expenses", roles: ["Super Admin", "Finance Manager", "CEO"] },
    ],
    label: "Outstation Expenses",
  },
  // Collapsed to a single standalone sidebar button that opens the Field
  // Coaching hub (app/(admin)/admin/field-coaching/page.tsx, items in
  // fieldCoachingPageItems below) — same pattern as the other consolidated
  // sections above. permissions is the union of every card's own gate (coaching
  // read/create, double_visit_analytics:read); the Super-Admin-only cards
  // (Double Visit Data Integrity, Visits Report, CRM Integrity) still gate
  // themselves via their own roles field on the hub.
  {
    id: "field-coaching",
    items: [
      {
        href: "/admin/field-coaching",
        icon: ClipboardCheck,
        label: "Field Coaching",
        permissions: [
          { resource: "coaching" },
          { resource: "coaching", action: "create" },
          { resource: "double_visit_analytics", action: "read" },
        ],
      },
    ],
    label: "Field Coaching",
  },
  // Single Super-Admin-only sidebar button opening the CRM hub
  // (app/(admin)/admin/crm/page.tsx, cards in crmPageItems below). The hub is the one
  // home for all CRM (iReports360) data — sync health, manual pull, the raw master table,
  // unmapped-identity resolution, and recovered-chains review all live on the page itself
  // (via its own tab bar), plus CRM Integrity / Double Visit Data Integrity as linked-out cards.
  {
    id: "crm",
    items: [{ href: "/admin/crm", icon: Database, label: "CRM", roles: ["Super Admin"] }],
    label: "CRM",
  },

  // ── Tier 6: Sales operations ──────────────────────────────────────────────────
  // Items ordered: dashboards → data entry → upload → data management → QA/diagnostics
  {
    id: "sales-source-of-sales",
    items: [
      // Collapsed to a single standalone sidebar button that opens the Source of
      // Sales hub (app/(admin)/sales/source-of-sales-tools/page.tsx, items in
      // sourceOfSalesPageItems below). permissions:[{resource:"sales"}] (default
      // "read") is the broadest of the 11 cards' own gates. Marketing Manager
      // lacks sales:import and is excluded from every card, so stays excluded
      // here too. CEO now reaches "Source of Sales Dash" (its own excludedRoles
      // no longer lists CEO) even though the other 10 cards still block CEO
      // (Achievement Dash explicitly, the remaining 9 via requiring sales:import,
      // which only Super Admin/SFE Manager hold) — so CEO must NOT be excluded
      // at the button level, or they'd never reach the one card they can open.
      { href: "/sales/source-of-sales-tools", icon: ChartNoAxesColumnIncreasing, label: "Source of Sales", permissions: [{ resource: "sales" }], excludedRoles: ["Marketing Manager"] },
    ],
    label: "Source of Sales",
  },
  // Collapsed to a single standalone sidebar button that opens the Direct
  // Orders hub (app/(admin)/sales/direct-orders-tools/page.tsx, cards in
  // directOrdersPageItems below) — same pattern as Source of Sales / Weekly
  // Sales / CRM. permissions:[{resource:"direct_orders",action:"read"}] is the
  // least-restrictive of the 5 cards' own gates (every role with direct_orders
  // access holds at least read).
  {
    id: "sales-direct-orders",
    items: [
      { href: "/sales/direct-orders-tools", icon: ReceiptText, label: "Direct Orders", permissions: [{ resource: "direct_orders", action: "read" }] },
    ],
    label: "Direct Orders",
  },
  // Collapsed to a single standalone sidebar button that opens the Weekly Sales
  // hub (app/(admin)/sales/weekly-tools/page.tsx, items in
  // weeklySalesToolsPageItems below), which now includes the Dashboard as its
  // first card alongside Upload/Mapping/Distributor Column Editor/Product Access.
  // permissions/excludedRoles here matches the Dashboard's original (broadest)
  // gate — the hub re-filters per-card with each card's real gate.
  {
    id: "sales-weekly-module",
    items: [
      { href: "/sales/weekly-tools", icon: Settings2, label: "Weekly Sales", permissions: [{ resource: "weekly_sales" }], excludedRoles: ["Marketing Manager"] },
    ],
    label: "Weekly Sales",
  },
  {
    id: "sales-queue-module",
    items: [
      { href: "/sales/queue", icon: ClipboardList, label: "Sales Queue", permissions: [{ action: "import", resource: "sales" }] },
    ],
    label: "Sales Queue",
  },
  {
    id: "sales-targets-module",
    items: [
      { href: "/sales/targets", icon: Target, label: "Targets", permissions: [{ action: "import", resource: "sales" }] },
    ],
    label: "Targets",
  },
  {
    id: "sales-territory-management",
    items: [
      // District Manager / Regional Manager / National Sales Manager land in the employee-portal
      // shell (resolveNavigationMode) — their entry point is /employee-portals/territory-management
      // just above. Restricting `roles` here to the admin-shell roles keeps this link from being
      // shown to someone who would just be redirected straight past it.
      { href: "/sales/territory-management", icon: Waypoints, label: "Territory Management", permissions: [{ resource: "sales" }], roles: ["CEO", "SFE Manager", "Super Admin"] },
    ],
    label: "Territory Management",
  },
  {
    id: "sales-analytics",
    items: [
      // Collapsed to a single standalone sidebar button. Unlike every other
      // consolidated section, this one needs NO new hub page — "Analytics Hub"
      // already pointed at /admin/analytics, a bespoke landing page with its own
      // module-card grid (app/(analytics)/admin/analytics/page.tsx). That page's
      // MODULES list has been extended with the 4 field-dashboard cards and now
      // filters cards per-role, so it doubles as this section's hub directly.
      { href: "/admin/analytics", icon: ChartColumnBig, label: "Sales Analytics", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO", "SFE Manager"] },
    ],
    label: "Sales Analytics",
  },

  // ── Tier 7b: Master data governance ──────────────────────────────────────────
  // Standalone read-only master-data page. Deliberately NOT nested under the Marketing
  // Requests or Customer Validation surfaces — it governs the customer↔pharmacy relationship
  // on its own route. The page's two cards still grant CEO oversight, but the
  // sidebar link is Super Admin + SFE Manager only: CEO is hidden from the
  // sidebar by owner request (see the roles list below).
  {
    id: "master-data",
    items: [
      // Collapsed to a single standalone sidebar button that opens the Master
      // Data hub (app/(admin)/admin/master-data/page.tsx, items in
      // masterDataPageItems below). One of its two cards ("Customers Database")
      // is itself another consolidated hub (app/(admin)/admin/customers-
      // database/page.tsx) — nesting a hub-card inside a hub is fine, it still
      // navigates to that page's own real destination. The hub cards still grant
      // CEO (see masterDataPageItems), but the sidebar link is deliberately
      // narrowed to Super Admin + SFE Manager: CEO is hidden from the sidebar by
      // owner request, so this list is intentionally NOT the union of the cards.
      { href: "/admin/master-data", icon: Network, label: "Master Data", roles: ["Super Admin", "SFE Manager"] },
    ],
    label: "Master Data",
  },

  // ── Tier 8: System administration ────────────────────────────────────────────
  // Collapsed to a single sidebar entry that opens the Access & Communication hub
  // (app/(admin)/admin/access-communication/page.tsx), which renders the individual
  // tools below (`accessCommunicationPageItems`) as cards. Same pattern as Admin
  // Tools above: the gate here is the least-restrictive of those tools' own gates,
  // the hub re-filters per-tool with the exact same permission/role fields, and
  // every destination page still enforces its own access check server-side.
  {
    id: "access-communication",
    items: [
      { href: "/admin/access-communication", icon: ShieldCheck, label: "Access & Communication", permissions: [{ resource: "admin_access" }, { resource: "communication" }], excludedRoles: ["CEO"] },
    ],
    label: "Access & Communication",
  },
  // Collapsed to a single standalone sidebar button that opens the
  // Pharmacovigilance hub (app/(admin)/admin/pharmacovigilance/page.tsx, items
  // in pharmacovigilancePageItems below). "Report It" has no restriction of its
  // own, so the union of its gate with "Reports Dashboard" (Super Admin only)
  // is "no gate" — every admin-shell viewer reaches the button and hub, and the
  // hub re-filters per-card with each card's real gate.
  {
    id: "pharmacovigilance",
    items: [{ href: "/admin/pharmacovigilance", icon: ShieldAlert, label: "Pharmacovigilance" }],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSectionSeed[];

const employeePortalNavigationSectionSeeds = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/employee-360", icon: IdCard, label: "Employee 360", permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/private-calendar", icon: CalendarDays, label: "Private Calendar", permissions: [{ resource: "employee_profile" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] },
      { href: "/employee-portals/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram", action: "read" }], roles: ["National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies", action: "read" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/recruitment-candidates", icon: UsersRound, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/employee-portals/contact-hr-support", icon: LifeBuoy, label: "HR Support", permissions: [{ resource: "support_requests", action: "create" }] },
      { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Outstation Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expense Dashboard", permissions: [{ resource: "expenses" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/team-expenses", icon: ReceiptText, label: "Team Expenses", permissions: [{ resource: "expenses" }], roles: ["National Sales Manager"] },
    ],
    label: "Medical Rep Portal",
  },
  // ── Approvals Hub: consolidated per-module approval surfaces, mirroring the
  // admin sidebar's Approvals Hub section. "Other Approvals" (resignation/
  // outstation/contract/plan combined inbox) moved here from the flat
  // "Medical Rep Portal" list.
  {
    id: "approvals-hub",
    items: [
      { href: "/employee-portals/approvals/vacation", icon: CalendarCheck, label: "Vacation Approvals", permissions: [{ resource: "leave", action: "read" }], roles: vacationApproverPortalNavigationRoles, navBadge: "vacation-approvals-pending" },
      { href: "/employee-portals/approvals/excuse", icon: CalendarClock, label: "Excuse Approvals", permissions: [{ resource: "leave", action: "read" }], roles: excuseApproverPortalNavigationRoles, navBadge: "excuse-approvals-pending" },
      { href: "/employee-portals/approvals/plan", icon: CalendarRange, label: "Weekly / Monthly Plan Approvals", permissions: [{ resource: "weekly_plans", action: "read" }], roles: planApproverPortalNavigationRoles, navBadge: "plan-approvals-pending" },
      { href: "/employee-portals/approvals/direct-orders", icon: ReceiptText, label: "Direct Orders Approvals", permissions: [{ resource: "direct_orders", action: "approve" }] },
      { href: "/employee-portals/approvals-hub", icon: Inbox, label: "Other Approvals", permissions: [{ resource: "leave", action: "read" }], navBadge: "approvals-hub-pending" },
    ],
    label: "Approvals Hub",
  },
  {
    id: "payroll",
    items: [
      { href: "/payslips", icon: ScrollText, label: "Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }], exact: true },
      { href: "/employee-portals/deductions", icon: ReceiptText, label: "Deductions", permissions: [{ resource: "employee_profile" }], exact: true },
    ],
    label: "Payroll",
  },
  // ── Recruitment & Hiring: Talent Acquisition's portal-side mirror of the
  // admin-shell hrAuthorityNavigationRoles tools (app/(admin)/recruitment,
  // /cv-database, /hiring-documents, /leave-management/vacation-control,
  // /admin/support-requests). Super Admin never sees this — resolveNavigationMode
  // keeps Super Admin on the admin shell, where the originals still live.
  {
    id: "recruitment-hiring",
    items: [
      { href: "/employee-portals/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/support-requests", icon: LifeBuoy, label: "HR Support Requests", permissions: [{ resource: "support_requests", action: "read" }], roles: ["Talent Acquisition"] },
    ],
    label: "Recruitment & Hiring",
  },
  // ── People Management: Talent Acquisition's company-wide HR tooling, separate
  // from the Recruitment & Hiring pipeline tools above (app/employee-portals/
  // {employees,contracts,resignations}/page.tsx). Vacancies Report reuses the
  // href already catalogued above (line ~605) for the field-management roles.
  {
    id: "people-management",
    items: [
      { href: "/employee-portals/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations", action: "read" }], roles: ["Talent Acquisition"] },
      { href: "/employee-portals/account-activation", icon: UserCog, label: "Account Activation", permissions: [{ resource: "account_activation", action: "read" }], roles: ["Talent Acquisition"] },
    ],
    label: "People Management",
  },
  {
    id: "sales-operations",
    items: [
      { href: "/employee-portals/source-of-sales", icon: ChartNoAxesColumnIncreasing, label: "Source of Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/direct-orders", icon: ReceiptText, label: "Direct Orders", permissions: [{ resource: "direct_orders", action: "create" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
      { href: "/employee-portals/direct-orders/report", icon: FileSpreadsheet, label: "Direct Orders Report", permissions: [{ resource: "direct_orders", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
      { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/sales-analytics", icon: Activity, label: "Sales Analytics", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // All four sales roles now shipped (Medical Rep, District Manager, Regional Manager,
      // National Sales Manager) — see TERRITORY_DRILLDOWN_ROLES in
      // src/lib/sales/territory/service.ts, the server-side gate this list must match.
      { href: "/employee-portals/territory-drilldown", icon: MapPinned, label: "Territory & Sales Drilldown", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] },
      // Portal-shell counterpart of /sales/territory-management — same component, own-scope data.
      // Medical Rep is deliberately excluded: this compares MULTIPLE areas' bricks against each
      // other, which is a District-Manager-and-up decision, not a single rep's own area view.
      { href: "/employee-portals/territory-management", icon: Waypoints, label: "Territory Management", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
    ],
    label: "Sales Operations",
  },
  {
    id: "coaching",
    items: [
      { href: "/employee-portals/double-visit-analytics", icon: Activity, label: "Double-Visit Analytics", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/dv-planner", icon: CalendarDays, label: "DV Planner", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Training Manager"] },
      { href: "/employee-portals/double-visit-report", icon: FileSpreadsheet, label: "Double Visit Report", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Training Manager"] },
      { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
    ],
    label: "Coaching",
  },
  {
    id: "employee-marketing-requests",
    items: [
      {
        href: "/employee-portals/marketing-requests/validation",
        icon: ShieldCheck,
        label: "Customer Validation",
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "SFE Manager",
          "CEO",
          "Super Admin",
        ],
      },
      {
        href: "/employee-portals/marketing-requests",
        icon: Megaphone,
        label: "Marketing Requests",
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "SFE Manager",
          "CEO",
          "Super Admin",
        ],
      },
      {
        href: "/employee-portals/marketing-requests/inbox",
        icon: Inbox,
        label: "Approval Inbox",
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "SFE Manager",
          "CEO",
          "Super Admin",
        ],
      },
      {
        href: "/employee-portals/marketing-requests/control",
        icon: Settings2,
        label: "Marketing Control",
        roles: ["SFE Manager", "Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/customer-database",
        icon: Database,
        label: "Customer Database",
        roles: ["Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/coverage-report",
        icon: MapPinned,
        label: "Marketing Coverage Report",
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "SFE Manager",
          "Finance Manager",
          "Financial Advisor",
          "CEO",
          "Super Admin",
        ],
      },
      // Mirrors canUseEmployeePortalMarketingRoiTracking exactly. Its own URL rather than a
      // shared page with /admin/marketing-roi-tracker — owner rule, 2026-07-28.
      {
        href: "/employee-portals/roi-tracker",
        icon: Target,
        label: "ROI Tracker",
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "SFE Manager",
          "CEO",
          "Super Admin",
        ],
      },
      { href: "/employee-portals/roi", icon: Target, label: "ROI Dashboard", permissions: [{ resource: "sales" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
    ],
    label: "Marketing Requests",
  },
  {
    id: "leave-management",
    items: [
      { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
      { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }], roles: hrAuthorityNavigationRoles },
      // Vacation Action Center removed — replaced by the Approvals Hub › Vacation Approvals surface.
      { href: "/employee-portals/attendance", icon: Fingerprint, label: "Fingerprint Report", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/employee-portals/visits", icon: MapPinned, label: "My Visits", permissions: [{ resource: "crm_visits", action: "read" }] },
    ],
    label: "Leave Management",
  },
  {
    id: "pharmacovigilance",
    items: [
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Reports Dashboard", roles: ["Manager"] },
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Report It", excludedRoles: ["Manager"] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSectionSeed[];

export const adminNavigationSections = withModuleIds("admin", adminNavigationSectionSeeds);
export const employeePortalNavigationSections = withModuleIds("employee-portal", employeePortalNavigationSectionSeeds);

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  return mode === "employee-portal" ? employeePortalNavigationSections : adminNavigationSections;
}

// ── Admin Tools hub (app/(admin)/admin/admin-tools/page.tsx) ────────────────────
// The tools formerly listed individually under the sidebar's "Admin Tools" section
// (see adminNavigationSectionSeeds above, now collapsed to one link). The hub page
// renders these as cards, filtered with the exact same permission/role/excludedRoles
// fields the sidebar used to apply per item.
export type AdminToolsPageItem = {
  description: string;
  excludedRoles?: readonly PhoenixRole[];
  href: `/${string}`;
  icon: LucideIcon;
  label: string;
  permissions?: readonly NavigationPermission[];
  roles?: readonly PhoenixRole[];
};

// ── Leave Management hub (app/(admin)/leave-management/page.tsx) ────────────────
// The tools formerly listed individually under the sidebar's "Leave Management"
// section (see adminNavigationSectionSeeds above, now collapsed to one link).
export const leaveManagementPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/leave-management/vacation-request",
    icon: CalendarDays,
    label: "Vacation Request",
    description: "Submit a vacation request (self-service).",
    permissions: [{ resource: "leave", action: "create" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/leave-management/vacation-report",
    icon: FileSpreadsheet,
    label: "Vacation Report",
    description: "View vacation balances and history.",
    permissions: [{ resource: "leave" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/leave-management/vacation-control",
    icon: Settings2,
    label: "Vacation Control",
    description: "Configure vacation policy and entitlement rules.",
    permissions: [{ resource: "leave", action: "update" }],
    roles: hrAuthorityNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Source of Sales hub (app/(admin)/sales/source-of-sales-tools/page.tsx) ──────
// The tools formerly listed individually under the sidebar's "Source of Sales"
// section (see adminNavigationSectionSeeds above, now collapsed to one link).
export const sourceOfSalesPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/sales",
    icon: ChartNoAxesColumnIncreasing,
    label: "Source of Sales Dash",
    description: "Distributor invoice sell-out dashboard.",
    permissions: [{ resource: "sales" }],
    excludedRoles: ["Marketing Manager"],
  },
  {
    href: "/sales/monthly-dashboard",
    icon: CalendarRange,
    label: "Achievement Dash",
    description: "Monthly closing achievement dashboard.",
    permissions: [{ resource: "sales" }],
    excludedRoles: ["CEO", "Marketing Manager"],
  },
  {
    href: "/sales/monthly-closing",
    icon: ChartColumnBig,
    label: "Monthly Closing",
    description: "Enter and manage monthly closing sales data.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/upload",
    icon: FileUp,
    label: "Sales Upload",
    description: "Upload distributor sales files.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/import",
    icon: FileSpreadsheet,
    label: "Sales Import (Advanced)",
    description: "Advanced sales import tooling.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/mapping-database",
    icon: Database,
    label: "SoS Mapping",
    description: "Manage Source of Sales mapping reference data.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/database-mapping",
    icon: Database,
    label: "Master Database",
    description: "Manage master sales reference database.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/distributor-profiles",
    icon: Tags,
    label: "Distributor Profiles",
    description: "Manage distributor profile records.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/missing-data",
    icon: TriangleAlert,
    label: "Missing Data",
    description: "Review sales rows with missing or unresolved data.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/normalizer",
    icon: Sparkles,
    label: "SoS Magic",
    description: "AI-assisted sales data normalization.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/diagnostics",
    icon: Stethoscope,
    label: "Sales Diagnostics",
    description: "Diagnose Source of Sales pipeline issues.",
    permissions: [{ action: "import", resource: "sales" }],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Sales Analytics cards (app/(analytics)/admin/analytics/page.tsx) ────────────────
// The tools formerly listed individually under the sidebar's "Sales Analytics"
// section (see adminNavigationSectionSeeds above, now collapsed to one link
// pointing directly at the pre-existing /admin/analytics landing page — see the
// comment there). "Analytics Hub" itself is omitted here since its destination
// IS that page; this array exists purely so the command palette can still find
// every module by name (see hubPageItemGroups below).
//
// Roles reflect who can actually reach AND pass the analytics company-scope gate today: Super
// Admin, CEO, SFE Manager (Exec/Recon stay CEO/Super-Admin-only). National Sales Manager /
// Product Manager / Group Product Manager are the intended FUTURE audience but are portal-nav +
// line-scoped, so they are gated out — do NOT re-add them here until per-viewer scoping + admin
// routing land (see docs/analytics/role-security.md § Roadmap).
export const salesAnalyticsPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/analytics/source-sales",
    icon: ChartColumnBig,
    label: "SoS Analytics",
    description: "Source of Sales analytics dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/analytics/monthly-closing",
    icon: CalendarRange,
    label: "Closing Analytics",
    description: "Monthly closing analytics dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/analytics/weekly-sales",
    icon: ChartNoAxesColumnIncreasing,
    label: "Weekly Analytics",
    description: "Weekly sales analytics dashboard.",
    permissions: [{ resource: "weekly_sales" }],
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/analytics/executive-comparison",
    icon: ChartColumnBig,
    label: "Executive Comparison",
    description: "Side-by-side executive KPI comparison.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/analytics/reconciliation",
    icon: ChartColumnBig,
    label: "Reconciliation",
    description: "Cross-source sales reconciliation.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/field-sales/weekly-sales",
    icon: ChartNoAxesColumnIncreasing,
    label: "Field Weekly Sales",
    description: "Company-scope re-host of the field weekly sales dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/field-sales/source-of-sales",
    icon: ChartColumnBig,
    label: "Field Source of Sales",
    description: "Company-scope re-host of the field Source of Sales dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/field-sales/dsm-performance",
    icon: ChartColumnBig,
    label: "DSM Performance",
    description: "Company-scope DSM performance dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/field-sales/med-reps-performance",
    icon: ChartNoAxesColumnIncreasing,
    label: "Med-Rep Performance",
    description: "Company-scope Med-Rep performance dashboard.",
    permissions: [{ resource: "sales" }],
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Master Data hub (app/(admin)/admin/master-data/page.tsx) ────────────────────
// The tools formerly listed individually under the sidebar's "Master Data"
// section (see adminNavigationSectionSeeds above, now collapsed to one link).
export const masterDataPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/customer-pharmacy-mapping",
    icon: Network,
    label: "Customer Pharmacy Mapping",
    description: "Company-wide customer ↔ pharmacy relationship oversight.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/customers-database",
    icon: Building2,
    label: "Customers Database",
    description: "Customer directory, mapping, pharmacy master, and marketing's customer database — in one place.",
    roles: ["Super Admin", "SFE Manager", "CEO"],
  },
] as const satisfies readonly AdminToolsPageItem[];

export const adminToolsPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/monitoring",
    icon: Radar,
    label: "Monitoring",
    description: "Authentication signals and email/notification delivery telemetry.",
    permissions: [{ resource: "admin" }],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/logs",
    icon: ScrollText,
    label: "Audit Logs",
    description: "Full audit trail of administrative actions across the platform.",
    permissions: [{ resource: "admin" }],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/system-issues",
    icon: TriangleAlert,
    label: "System Issues",
    description: "Supabase + GCP Cloud Logging errors, and per-employee error/failed-login attempt counts.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/cron-control",
    icon: CalendarClock,
    label: "Cron Control",
    description: "View, pause/resume, run now, and reschedule the GCP Cloud Scheduler jobs behind this system's automation.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/email-control-center",
    icon: SlidersHorizontal,
    label: "Email Control Center",
    description: "Every automated email in one place: turn any one off, or fine-tune exactly which roles receive it. Viewing is Super Admin + CEO; changes are Super Admin only.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/data-health",
    icon: Database,
    label: "Data Health",
    description: "Data integrity checks across core tables and pipelines.",
    permissions: [{ resource: "admin" }],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/activity-control",
    icon: Activity,
    label: "Activity Control",
    description: "Employee activity monitoring center.",
    permissions: [{ resource: "user_activity", action: "read" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/synthetic-journeys",
    icon: HeartPulse,
    label: "Synthetic Journeys",
    description: "Automated synthetic checks across critical user journeys.",
    permissions: [{ resource: "synthetic_journeys" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/data-backup",
    icon: Download,
    label: "Data Backup",
    description: "Trigger and manage database backups.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/system-cleanup",
    icon: Trash2,
    label: "System Cleanup",
    description: "Bulk cleanup utilities for stale or orphaned data.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/modules-control",
    icon: Settings2,
    label: "Modules Control",
    description: "Curate sidebar modules per user, role, position, or line.",
    permissions: [{ resource: "module_control", action: "read" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/workflow-control",
    icon: Settings2,
    label: "Workflow Control",
    description: "Configure approval workflow statuses and transitions.",
    permissions: [{ resource: "workflow_registry" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/notifications/email",
    icon: MailCheck,
    label: "Email Delivery",
    description: "See which notification emails have sent vs. not sent, and why.",
    permissions: [{ resource: "communication" }],
  },
  {
    href: "/admin/notifications/email-tracking",
    icon: MousePointerClick,
    label: "Email Activity",
    description: "Each email's exact situation — sent, delivered, opened, clicked (Resend + Brevo).",
    permissions: [{ resource: "communication" }],
  },
  {
    href: "/admin/dev-preview",
    icon: UserCog,
    label: "Dev Preview (Real Data)",
    description:
      "Pick a role and line, auto-select a real active employee, and browse the app as them with their genuine data. Local development only — not available in this environment.",
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Access & Communication hub (app/(admin)/admin/access-communication/page.tsx) ─
// The tools formerly listed individually under the sidebar's "Access & Communication"
// section (see adminNavigationSectionSeeds above, now collapsed to one link). Reuses
// the same AdminToolsPageItem shape — the hub page renders these as cards, filtered
// with the exact same permission/role/excludedRoles fields the sidebar used to apply.
export const accessCommunicationPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/access",
    icon: ShieldCheck,
    label: "Users & Access",
    description: "Manage user accounts, roles, and permission assignments.",
    permissions: [{ resource: "admin_access" }],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/scope-visibility",
    icon: ShieldAlert,
    label: "Scope & Visibility",
    description: "Review role-based data scope and visibility rules.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/email-reply-composer",
    icon: Mail,
    label: "Email Composer",
    description: "Compose and send ad-hoc emails to employees or groups.",
    permissions: [{ resource: "communication" }],
  },
  {
    href: "/admin/email-templates",
    icon: BellRing,
    label: "Email Templates",
    description: "Manage the email templates used across notifications.",
    permissions: [{ resource: "communication" }],
  },
  {
    href: "/admin/notifications/telegram",
    icon: Send,
    label: "Telegram",
    description: "Telegram bot notification settings and delivery.",
    permissions: [{ resource: "communication" }],
  },
  {
    href: "/admin/notification-confidence",
    icon: ShieldAlert,
    label: "Notification Confidence Center",
    description: "Every automated email's pre-send validation checks, confidence score, and any held for review.",
    permissions: [{ resource: "communication" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/notifications/telegram/templates",
    icon: MessageSquareText,
    label: "Telegram Templates",
    description: "Manage the Telegram message templates used across notifications.",
    permissions: [{ resource: "communication" }],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Weekly Sales tools hub (app/(admin)/sales/weekly-tools/page.tsx) ────────────
// The tools formerly listed individually under the sidebar's "Weekly Sales" section
// (see adminNavigationSectionSeeds above), now fully collapsed behind one button.
export const weeklySalesToolsPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/sales/weekly/dashboard",
    icon: ChartNoAxesColumnIncreasing,
    label: "Weekly Sales Dashboard",
    description: "Weekly distributor sell-out and stock position dashboard.",
    permissions: [{ resource: "weekly_sales" }],
    excludedRoles: ["Marketing Manager"],
  },
  {
    href: "/sales/weekly",
    icon: FileUp,
    label: "Weekly Sales Upload",
    description: "Upload weekly distributor sell-out and stock files.",
    permissions: [{ action: "import", resource: "weekly_sales" }],
  },
  {
    href: "/sales/weekly/mapping",
    icon: Tags,
    label: "Weekly Mapping",
    description: "Branch/region and product mapping, plus missing-data tools.",
    permissions: [{ action: "update", resource: "weekly_sales" }],
  },
  {
    href: "/sales/weekly/distributor-editor",
    icon: Columns3,
    label: "Weekly Distributor Column Editor",
    description: "Edit distributor column layouts used during weekly import.",
    permissions: [{ action: "import", resource: "weekly_sales" }],
  },
  {
    href: "/sales/weekly/assignments",
    icon: UsersRound,
    label: "Weekly Product Access",
    description: "Manage which products each distributor upload can access.",
    permissions: [{ action: "update", resource: "weekly_sales" }],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Customers Database hub (app/(admin)/admin/customers-database/page.tsx) ──────
// Four previously-scattered customer/pharmacy reference surfaces (Source of Sales'
// Customer Directory + Customer Mapping, Master Data's Pharmacy Master, and
// Marketing & ROI's Customer Database) consolidated behind one sidebar button
// (see the "master-data" section above). Each card keeps its original gate.
export const customersDatabasePageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/sales/customer-directory",
    icon: UsersRound,
    label: "Customer Directory",
    description: "Browse and filter every customer across all distributors.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/customer-mapping",
    icon: MapPinned,
    label: "Customer Mapping",
    description: "Map raw distributor customer records to canonical customer/brick codes.",
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/admin/pharmacy-master",
    icon: Building2,
    label: "Pharmacy Master",
    description: "Review pharmacies possibly duplicated across distributors under different names.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/marketing-requests/customer-database",
    icon: Database,
    label: "Customer Database",
    description: "Validation view of customer, pharmacy, and distributor-code rows for marketing requests.",
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Attendance Management hub (app/(admin)/attendance/page.tsx) ─────────────────
// The tools formerly listed individually under the sidebar's "Attendance
// Management" section (see adminNavigationSectionSeeds above, now collapsed to
// one link). The hub page renders these as cards, filtered with the exact same
// permission/role/excludedRoles fields the sidebar used to apply per item.
export const attendanceManagementPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/attendance/fingerprint-report",
    icon: FileSpreadsheet,
    label: "Fingerprint Report",
    description: "Raw fingerprint clock-in/clock-out punches per employee.",
    permissions: [{ resource: "employees" }],
    roles: ["CEO", "Super Admin"],
  },
  {
    href: "/attendance/employee-day-report",
    icon: Fingerprint,
    label: "Employee Day-by-Day Report",
    description: "One employee, any date range — every calendar day with full detail, and confirm or reject that day's fingerprint deduction directly.",
    permissions: [{ resource: "attendance", action: "read" }],
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/attendance/monthly-summary",
    icon: CalendarCheck,
    label: "Monthly Summary",
    description: "Monthly attendance summary and totals per employee.",
    permissions: [{ resource: "employees" }],
    roles: ["CEO", "Super Admin"],
  },
  {
    href: "/attendance/analytics",
    icon: ChartColumnBig,
    label: "Attendance Analytics",
    description: "Attendance trends and patterns across the organization.",
    permissions: [{ resource: "attendance", action: "read" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/weekly-plans/calendar",
    icon: CalendarRange,
    label: "Company Planning Calendar",
    description: "Company-wide submitted weekly and monthly plans, holidays, and conflicts.",
    permissions: [{ resource: "weekly_plans", action: "read" }],
    roles: ["CEO", "Super Admin"],
  },
  {
    href: "/hr-calendar",
    icon: CalendarDays,
    label: "Company Calendar",
    description: "Company-wide events, holidays, and leave calendar.",
    permissions: [{ resource: "hr_calendar" }],
  },
  {
    href: "/admin/company-calendar",
    icon: CalendarDays,
    label: "Events Calendar",
    description: "Admin host of the portal events calendar — events, holidays, leave, and birthdays.",
    permissions: [{ resource: "attendance", action: "read" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/private-calendars",
    icon: CalendarDays,
    label: "Private Calendars",
    description: "Executive private calendar management.",
    permissions: [{ resource: "attendance", action: "read" }],
    roles: ["CEO", "Super Admin"],
  },
  {
    href: "/attendance/exceptions",
    icon: ShieldCheck,
    label: "Attendance Exceptions",
    description: "Review and resolve attendance exception cases.",
    permissions: [{ resource: "attendance", action: "read" }],
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/attendance/device-user-mapping",
    icon: Fingerprint,
    label: "Device User Mapping",
    description: "Map fingerprint device users to employee records.",
    permissions: [{ resource: "employees", action: "update" }],
  },
  {
    href: "/attendance/policies",
    icon: CalendarClock,
    label: "Attendance Policies",
    description: "Configure attendance policies and rules.",
    permissions: [{ resource: "employees", action: "update" }],
  },
  {
    href: "/attendance/holiday-calendar",
    icon: CalendarClock,
    label: "Holiday Calendar",
    description: "Manage the company holiday calendar.",
    permissions: [{ resource: "employees", action: "read" }],
    roles: systemAdministratorNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Payroll Management hub (app/(admin)/admin/payroll-management/page.tsx) ──────
// The tools formerly listed individually under the admin sidebar's "Payroll
// Management" section (see adminNavigationSectionSeeds above, now collapsed to
// one link). Employee-portal payroll (Payslips/Deductions) is unrelated and
// untouched.
export const payrollManagementPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/payroll",
    icon: FileSpreadsheet,
    label: "Payroll Report",
    description: "Company payroll report — gross, net, and deductions per employee.",
    permissions: [{ resource: "payroll" }],
    roles: companyPayrollNavigationRoles,
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/m-payroll",
    icon: ScrollText,
    label: "CEO Payroll View",
    description: "Executive read-only payroll console.",
    permissions: [{ resource: "payroll" }],
    roles: ["CEO", "Super Admin"],
  },
  {
    href: "/admin/payroll-copilot",
    icon: Sparkles,
    label: "Payroll Copilot",
    description: "AI-assisted payroll assembly, review, and deduction recommendations.",
    permissions: [{ resource: "payroll" }],
    roles: ["CEO", "Super Admin"],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/payroll-copilot/insurance-wages",
    icon: ReceiptText,
    label: "Insurance Wages",
    description: "Manage insurance wage bases used in statutory calculations.",
    permissions: [{ resource: "payroll" }],
    roles: ["CEO", "Super Admin"],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/payslips-center",
    icon: ScrollText,
    label: "Payslips Center",
    description: "Generate and manage employee payslips.",
    permissions: [{ resource: "payslips" }],
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/deductions-governance",
    icon: ShieldCheck,
    label: "Deductions Governance",
    description: "Review and govern payroll deduction decisions.",
    permissions: [{ resource: "deductions", action: "read" }],
    excludedRoles: ["CEO"],
  },
  {
    href: "/admin/no-activity-days",
    icon: CalendarX2,
    label: "No Activity Days",
    description: "Company-wide No Activity Recorded days — clarifications and payroll deduction decisions.",
    permissions: [{ resource: "deductions", action: "read" }],
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Marketing & ROI hub (app/(admin)/admin/marketing-roi/page.tsx) ──────────────
// The tools formerly listed individually under the admin sidebar's "Marketing &
// ROI" section (see adminNavigationSectionSeeds above, now collapsed to one
// link). Employee-portal marketing/ROI navigation (Marketing Manager/PM/GPM's
// own workspace) is a separate, unrelated section and is untouched.
/**
 * Archived Marketing Requests — a SEPARATE module from the live marketing one.
 *
 * Owner decision 2026-07-28: from 2026-08-01 every marketing request is submitted in Phoenix, and
 * Phoenix data is materially more accurate because it is validated at entry. The historical
 * Excel-imported set is kept in its own module with its own ROI so legacy data quality can never
 * drag down live performance. Split at the data layer by marketing_requests.origin.
 *
 * NOTE: "Archived" here is PROVENANCE (came from Excel), not the status='archived' lifecycle state.
 */
export const archivedMarketingPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/archived-marketing-requests",
    icon: Archive,
    label: "Archived ROI Tracking",
    description: "Historical marketing requests imported from Excel, with their own ROI tracking — kept apart from live Phoenix performance.",
    roles: ["Super Admin", "CEO", "SFE Manager", "Finance Manager", "Financial Advisor"],
  },
];

export const marketingRoiPageItems: readonly AdminToolsPageItem[] = [
  // Listed first deliberately: this is the intended single source of truth for marketing ROI.
  // It composes the same authoritative engine as ROI Tracking (getMarketingRoiReport) rather than
  // adding a fifth opinion, and additionally surfaces the pharmacy code-reference quality signal
  // that no other surface shows. The three ROI entries below it remain live until the owner
  // confirms this one replaces them.
  {
    href: "/admin/marketing-roi-tracker",
    icon: Target,
    label: "ROI Tracker",
    description: "Every request with its forecast, attributed sales, products, target pharmacies and approval chain — one place, one set of numbers.",
    // Mirrors assertMarketingAdminPageAccess({ allowCompanyOversight: true }) and the sidebar
    // entry above. Previously omitted Marketing Manager / Product Manager / Group Product
    // Manager even though the page guard admits them.
    roles: [
      "Super Admin",
      "CEO",
      "SFE Manager",
      "Marketing Manager",
      "Product Manager",
      "Group Product Manager",
      "Finance Manager",
      "Financial Advisor",
    ],
  },
  {
    href: "/admin/sales-marketing-intelligence",
    icon: ChartColumnBig,
    label: "ROI Dashboard",
    description: "Marketing ROI & Customer Intelligence BI dashboard — spend vs. realized sales, coverage gaps, customer impact.",
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/marketing-requests/roi-tracking",
    icon: ChartColumnBig,
    label: "ROI Tracking",
    description: "Read-only executive report to filter and audit individual marketing requests.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/marketing-roi-report",
    icon: ClipboardList,
    label: "Marketing ROI Report",
    description: "Business-friendly ROI report, browsable by requester or customer.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/marketing-requests/coverage-report",
    icon: MapPinned,
    label: "Marketing Coverage Report",
    description: "Hierarchy-scoped drill-down into requests, target pharmacies, and coverage KPIs.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/marketing-requests/validation",
    icon: ShieldCheck,
    label: "Customer Validation",
    description: "Validate customer/pharmacy records tied to marketing requests.",
    roles: ["District Manager", "Super Admin"],
  },
  {
    href: "/admin/marketing-requests",
    icon: Megaphone,
    label: "Marketing Requests",
    description: "Submit and manage marketing requests.",
    roles: ["District Manager", "Super Admin"],
  },
  {
    href: "/admin/marketing-requests/inbox",
    icon: Inbox,
    label: "Approval Inbox",
    description: "Approve or reject pending marketing requests.",
    roles: ["District Manager", "Super Admin"],
  },
  {
    href: "/admin/marketing-requests/bulk-upload",
    icon: FileUp,
    label: "Bulk Upload",
    description: "Bulk import marketing request data.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/marketing-requests/control",
    icon: Settings2,
    label: "Marketing Control",
    description: "Configure marketing request module settings.",
    roles: systemAdministratorNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Recruitment & Hiring hub (app/(admin)/admin/recruitment-hiring/page.tsx) ────
// The tools formerly listed individually under the admin sidebar's "Recruitment
// & Hiring" section (see adminNavigationSectionSeeds above, now collapsed to
// one link). All four shared the same roles (hrAuthorityNavigationRoles).
export const recruitmentHiringPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/recruitment",
    icon: BriefcaseBusiness,
    label: "Recruitment",
    description: "Manage open positions and the recruitment pipeline.",
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/cv-database",
    icon: FileSpreadsheet,
    label: "CV Database",
    description: "Browse and search the candidate CV database.",
    permissions: [{ resource: "vacancies" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/hiring-documents",
    icon: FileCheck2,
    label: "Hiring Documents",
    description: "Manage hiring-related employee documents.",
    permissions: [{ resource: "employee_documents" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/recruitment/cv-extraction-analytics",
    icon: ChartColumnBig,
    label: "CV Extraction Accuracy",
    description: "How often Talent Acquisition corrects the AI's proposed CV fields, per position.",
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/recruitment/intake-health",
    icon: HeartPulse,
    label: "Inbound Intake Health",
    description: "WhatsApp + email CV intake funnel, capture rate, and any dead-lettered CVs to retry.",
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── People Management hub (app/(admin)/admin/people-management/page.tsx) ────────
// The tools formerly listed individually under the admin sidebar's "People
// Management" section (see adminNavigationSectionSeeds above, now collapsed to
// one link).
export const peopleManagementPageItems: readonly AdminToolsPageItem[] = [
  // "Other Approvals" moved to the sidebar's Approvals Hub section — see
  // adminNavigationSectionSeeds above.
  {
    href: "/employees",
    icon: UsersRound,
    label: "Employees",
    description: "Full employee directory and records.",
    permissions: [{ resource: "employees" }],
    roles: ["Super Admin"],
  },
  // Organogram/Probation moved to direct sidebar links — see the
  // people-management section in adminNavigationSectionSeeds above.
  {
    href: "/reports/vacancies",
    icon: BriefcaseBusiness,
    label: "Vacancies Report",
    description: "Open and vacant position report.",
    permissions: [{ resource: "vacancies" }],
    excludedRoles: ["Marketing Manager"],
  },
  {
    href: "/contracts",
    icon: CalendarClock,
    label: "Contract Renewal",
    description: "Manage upcoming and expiring employment contracts.",
    permissions: [{ resource: "contracts" }],
  },
  {
    href: "/resignations",
    icon: FileSpreadsheet,
    label: "Resignations",
    description: "Track and process employee resignations.",
    permissions: [{ resource: "resignations" }],
  },
  {
    href: "/admin/weekly-plans",
    icon: CalendarDays,
    label: "Weekly / Monthly Plans",
    description: "Org-wide review of weekly and monthly field plans.",
    permissions: [{ resource: "weekly_plans" }],
    roles: ["Super Admin"],
  },
  // Workforce Compliance moved to a direct sidebar link — see the
  // people-management section in adminNavigationSectionSeeds above.
  {
    href: "/admin/vacation-report",
    icon: FileSpreadsheet,
    label: "Company Vacation Report",
    description: "Every HR-approved leave request alongside unverified CRM/attendance leave signals, org-wide.",
    permissions: [{ resource: "leave" }],
    roles: ["Super Admin"],
  },
  {
    href: "/admin/support-requests",
    icon: LifeBuoy,
    label: "HR Support Requests",
    description: "Employee HR support ticket queue.",
    permissions: [{ resource: "support_requests" }],
    roles: hrAuthorityNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Outstation Expenses hub (app/(admin)/admin/outstation-expenses/page.tsx) ────
// The tools formerly listed individually under the admin sidebar's "Outstation
// Expenses" section (see adminNavigationSectionSeeds above, now collapsed to
// one link). Expense Requests / Add Manual Expense are query-string views of
// the same Expense Command Center page, preserved exactly as before.
export const outstationExpensesPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/outstation/expense-command",
    icon: Radar,
    label: "Expense Command Center",
    description: "Outstation expense command center — overview of activity and queues.",
    permissions: [{ resource: "outstation", action: "read" }],
    roles: ["Super Admin", "Finance Manager", "CEO"],
  },
  {
    href: "/admin/outstation/expense-command?tab=queue",
    icon: MapPinned,
    label: "Expense Requests",
    description: "Review and approve pending outstation expense requests.",
    permissions: [{ resource: "outstation", action: "approve" }],
    roles: ["Super Admin", "Finance Manager"],
  },
  {
    href: "/admin/outstation/expense-command?tab=queue&action=create-manager-expense",
    icon: PlusCircle,
    label: "Add Manual Expense",
    description: "Manually add an outstation expense on behalf of an employee.",
    permissions: [{ resource: "outstation", action: "approve" }],
    roles: ["Super Admin", "Finance Manager"],
  },
  {
    href: "/admin/outstation/expenses/dashboard",
    icon: ChartColumnBig,
    label: "Outstation Expenses",
    description: "Outstation expenses dashboard and reporting.",
    permissions: [{ resource: "expenses" }],
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/admin/outstation/expenses",
    icon: FileSpreadsheet,
    label: "Historical Upload",
    description: "Upload historical outstation expense data.",
    permissions: [{ resource: "expenses" }],
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/admin/outstation/policy",
    icon: CalendarClock,
    label: "Outstation Policy",
    description: "Configure outstation expense policy rules.",
    permissions: [{ resource: "outstation", action: "update" }],
    roles: ["Super Admin", "Finance Manager"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Field Coaching hub (app/(admin)/admin/field-coaching/page.tsx) ──────────────
// The tools formerly listed individually under the admin sidebar's "Field
// Coaching" section (see adminNavigationSectionSeeds above, now collapsed to
// one link).
export const fieldCoachingPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/coaching",
    icon: ClipboardCheck,
    label: "Field Coaching",
    description: "Submit and review field coaching evaluations.",
    permissions: [{ resource: "coaching" }],
  },
  {
    href: "/coaching/analytics",
    icon: ChartColumnBig,
    label: "Coaching Analytics",
    description: "Coaching trends and analytics across the field team.",
    permissions: [{ resource: "coaching" }],
    excludedRoles: ["Marketing Manager"],
  },
  {
    href: "/admin/double-visit-analytics",
    icon: Activity,
    label: "Double Visit Analytics",
    description: "Double-visit compliance and performance analytics.",
    permissions: [{ resource: "double_visit_analytics", action: "read" }],
    excludedRoles: ["Marketing Manager"],
  },
  {
    href: "/coaching/import",
    icon: FileUp,
    label: "Import History",
    description: "History of coaching evaluation imports.",
    permissions: [{ action: "create", resource: "coaching" }],
  },
  {
    href: "/coaching/archived",
    icon: Archive,
    label: "Resigned Evaluations",
    description: "Archived coaching evaluations for resigned employees.",
    permissions: [{ action: "create", resource: "coaching" }],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── CRM hub (app/(admin)/admin/crm/page.tsx) ────────────────────────────────────
// The single Super-Admin home for CRM (iReports360) data. The hub page itself shows sync
// health + a manual backfill, the raw master table (Visits/Check-ins/Double Visits/Triple
// Visits/Vacations/no-check-in views), unmapped-identity resolution, and the recovered-chains
// audit — all via its own tab bar, not separate pages. These two sub-modules are the only CRM
// analyses that still need a dedicated page (each renders a different derived report, not a
// view of the hub's own data) and render as cards linked from the hub. All CRM pulling/reading
// is centralized in src/lib/crm/*.
export const crmPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/crm-integrity",
    icon: MapPinned,
    label: "CRM Integrity",
    description: "Correlate visits with GPS check-ins; flag save-lag and impossible travel.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/double-visit-data-integrity",
    icon: TriangleAlert,
    label: "Double Visit Data Integrity",
    description: "Data-integrity checks for double-visit records.",
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Pharmacovigilance hub (app/(admin)/admin/pharmacovigilance/page.tsx) ────────
// The tools formerly listed individually under the admin sidebar's
// "Pharmacovigilance" section (see adminNavigationSectionSeeds above, now
// collapsed to one link).
export const pharmacovigilancePageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/report-it",
    icon: ShieldAlert,
    label: "Reports Dashboard",
    description: "Review submitted pharmacovigilance/adverse-event reports.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/report-it/new",
    icon: ShieldAlert,
    label: "Report It",
    description: "Submit a new pharmacovigilance or adverse-event report.",
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Direct Orders hub (app/(admin)/sales/direct-orders-tools/page.tsx) ──────────
// The Direct Order Request module's admin surfaces, collapsed to one sidebar
// button (see adminNavigationSectionSeeds above) exactly like Source of
// Sales / Weekly Sales / CRM / Admin Tools.
export const directOrdersPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/direct-orders",
    icon: ReceiptText,
    label: "Direct Orders",
    description: "Submit a governed direct-sales order for CEO-chain approval.",
    permissions: [{ resource: "direct_orders", action: "create" }],
  },
  {
    href: "/admin/direct-orders/report",
    icon: FileSpreadsheet,
    label: "Direct Orders Report",
    description: "Every direct order — requests, approvals, pharmacies, and money.",
    permissions: [{ resource: "direct_orders", action: "read" }],
  },
  {
    href: "/admin/direct-orders/caps",
    icon: Settings2,
    label: "Bonus & Discount Caps",
    description: "Configure per-product bonus and discount caps.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    roles: ["Super Admin", "SFE Manager", "CEO"],
  },
  {
    href: "/admin/direct-orders/pharmacy-variances",
    icon: MapPinned,
    label: "Pharmacy Variances",
    description: "Review pharmacy geography variances against the customer map.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    roles: ["Super Admin", "SFE Manager", "CEO"],
  },
  {
    href: "/admin/direct-orders/reconciliation",
    icon: Scale,
    label: "Direct Sales Reconciliation",
    description: "Reconcile the manual Direct upload against module direct orders.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    roles: ["Super Admin", "SFE Manager", "CEO"],
  },
] as const satisfies readonly AdminToolsPageItem[];

// Every consolidated hub's card list, tagged with the hub's own sidebar label.
// Consumed by the command palette (src/components/layout/command-palette.tsx)
// so Cmd/Ctrl+K search still surfaces every module that used to have its own
// sidebar row, not just the collapsed hub buttons that replaced them.
export const hubPageItemGroups: readonly { label: string; items: readonly AdminToolsPageItem[] }[] = [
  { items: leaveManagementPageItems, label: "Leave Management" },
  { items: sourceOfSalesPageItems, label: "Source of Sales" },
  { items: salesAnalyticsPageItems, label: "Sales Analytics" },
  { items: masterDataPageItems, label: "Master Data" },
  { items: adminToolsPageItems, label: "Admin Tools" },
  { items: accessCommunicationPageItems, label: "Access & Communication" },
  { items: weeklySalesToolsPageItems, label: "Weekly Sales" },
  { items: customersDatabasePageItems, label: "Customers Database" },
  { items: attendanceManagementPageItems, label: "Attendance Management" },
  { items: payrollManagementPageItems, label: "Payroll Management" },
  { items: marketingRoiPageItems, label: "Marketing & ROI" },
  { items: archivedMarketingPageItems, label: "Archived Marketing Requests" },
  { items: recruitmentHiringPageItems, label: "Recruitment & Hiring" },
  { items: peopleManagementPageItems, label: "People Management" },
  { items: outstationExpensesPageItems, label: "Outstation Expenses" },
  { items: fieldCoachingPageItems, label: "Field Coaching" },
  { items: crmPageItems, label: "CRM" },
  { items: pharmacovigilancePageItems, label: "Pharmacovigilance" },
  { items: directOrdersPageItems, label: "Direct Orders" },
] as const;
