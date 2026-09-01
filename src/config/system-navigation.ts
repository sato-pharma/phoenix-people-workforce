import {
  Activity,
  Archive,
  BellRing,
  BookUser,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Download,
  Columns3,
  Database,
  FileCheck2,
  FilePlus2,
  FileClock,
  FileSignature,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  Gauge,
  HeartPulse,
  Hourglass,
  IdCard,
  Inbox,
  Landmark,
  ListChecks,
  Lock,
  Package,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  Mail,
  MailCheck,
  MailX,
  MousePointerClick,
  MapPinned,
  PauseCircle,
  Megaphone,
  MessageSquareText,
  Network,
  PlusCircle,
  Radar,
  ReceiptText,
  Scale,
  ScrollText,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Sunrise,
  Store,
  Tags,
  Target,
  TriangleAlert,
  Trash2,
  Trophy,
  Undo2,
  Unlink,
  UserCog,
  UsersRound,
  Waypoints,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  adminShellEmployeeRoles,
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
  excludedRoles?: readonly PhoenixRole[];
  roles?: readonly PhoenixRole[];
  permissions?: readonly NavigationPermission[];
  /**
   * Per-role display-label override, resolved in `getSections` (active-path.ts). This item's
   * `label` stays the canonical one — used for search and every role that has no entry
   * here. Add a role only when that
   * role's own name for the module genuinely differs; do not use this to rename an item wholesale
   * — that is what editing `label` itself is for.
   *
   * First use (2026-08-11, owner instruction): the "Payroll — Finance" item is shared by four
   * roles (CEO, Financial Advisor, Finance Manager, Super Admin), but the sibling "Automated
   * Payroll" wizard item in the same section is `roles: ["Super Admin"]` only — so only Super
   * Admin ever sees both rows and needs "— Finance" to tell them apart. For CEO, Financial Advisor
   * and Finance Manager it is the only payroll row in this section, so the suffix is pure noise.
   * The owner asked to drop it for the Finance Manager specifically; CEO and Financial Advisor
   * keep the existing label unless they ask too.
   */
  labelByRole?: Partial<Record<PhoenixRole, string>>;
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
  navBadge?: "direct-orders-needs-action" | "direct-orders-approvals-pending" | "direct-orders-unbooked" | "approvals-hub-pending" | "vacation-approvals-pending" | "excuse-approvals-pending" | "plan-approvals-pending" | "marketing-approvals-pending";
};

export type NavigationSection = {
  id: string;
  items: readonly NavigationSectionItem[];
  label: string;
};

// Section headings below are the REAL titles for every role. The SFE Manager's flat, headless
// sidebar (PR #1625, 2026-08-02) is produced by subtracting them at render time — see
// `flatSidebarRoles` / `usesFlatSidebar` in @/lib/navigation/active-path. They are not blanked
// here because `label` is also the sidebar search key and the drag-handle aria text, neither of
// which should read as an empty string.

type NavigationSectionSeed = NavigationSection;

// Both HR bundles, because every entry using this list ALSO carries a `permissions:` requirement
// and the sidebar filter applies both — so the recruitment tools reach HR Advisory (which holds
// recruitment:read) and vacation control reaches HR Operations (which holds leave:update), from
// one shared list. Mirrors hrAuthorityRoles in permissions.ts, which gates the pages themselves.
const hrAuthorityNavigationRoles = ["Super Admin", "HR Advisory", "HR Operations"] as const satisfies readonly PhoenixRole[];
// Single consumer: the "Payroll Report" (/payroll) card in payrollManagementPageItems. Finance
// Manager was dropped on 2026-08-10 (owner) — his payroll:read/export grant stays, because the
// Automated Payroll finance sheets and the bank transfer file both need it; only this card goes.
const companyPayrollNavigationRoles = ["Super Admin"] as const satisfies readonly PhoenixRole[];
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

/**
 * Where the sidebar logo takes each shell.
 *
 * An exhaustive `Record` over a union does NOT gate the build here (`next.config` sets
 * `typescript: { ignoreBuildErrors: true }`), so a missing key compiles, ships, and hands the
 * sidebar `undefined` as an href. `tests/hr-url-namespace.test.ts` asserts at RUNTIME that every
 * `NavigationMode` resolves to a real path.
 */
export const navigationHomePathByMode: Record<NavigationMode, `/${string}`> = {
  admin: "/admin/access",
  "employee-portal": "/employee-portals",
  // Not /hr: that bare address resolves through the viewer's own landing rule, which costs an
  // extra hop. The HR seats' landing page today is the personal admin-shell workspace (see
  // resolveLandingPathForRole); Phase 4 replaces it with the per-seat dashboard and this line is
  // the one place that changes.
  hr: "/hr/workspace",
};

const adminNavigationSectionSeeds = [
  // ── Tier 1: Executive overview ────────────────────────────────────────────────
  // Items ordered: primary dashboard → intelligence → monitoring → audit → admin tools → destructive
  {
    id: "command-center",
    items: [
      { href: "/admin/ceo-command-center", icon: LayoutDashboard, label: "CEO Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["CEO"] },
      // `roles` alone already keeps this off the CEO's sidebar, but NOT off Super Admin's — the
      // system-administrator workspace bypasses role gating. excludedRoles is now honoured through
      // that bypass too (see getSections), so this is the line that actually hides it. Both are
      // listed explicitly: this is one role's personal overview, not a module anyone else works in.
      { href: "/admin/sfe-command-center", icon: LayoutDashboard, label: "SFE Manager Overview", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["SFE Manager"], excludedRoles: ["Super Admin", "CEO"] },
      // Deliberately roles-only, with NO `permissions` field — unlike the two entries above.
      // permissionAllowed is an OR across the list, and the Finance Manager holds neither `admin`
      // nor `overview` (see the matrix in permissions.ts), so copying their gate verbatim would
      // hide this row from the one person it exists for. His role IS the gate; the page itself
      // re-checks with the same role test.
      // Label shortened 2026-08-10: "Finance Command Center" measured 150px against a 136px budget
      // and clipped to "Finance Command …". The PAGE still reads Finance Command Center — only the
      // rail is width-constrained. Budgets are pinned by tests/sidebar-label-width.test.ts.
      { href: "/admin/finance-command-center", icon: Landmark, label: "Finance Overview", roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
      { href: "/business-review", icon: LayoutDashboard, label: "Business Review", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["CEO", "SFE Manager", "Super Admin"] },
      // Excluded for every role that has its OWN command center directly above — otherwise the
      // section shows them two "Command Center" entries and the generic one lands on the
      // admin-wide dashboard instead of theirs. The CEO was already excluded for this reason;
      // the SFE Manager has had his own overview since /admin/sfe-command-center shipped and
      // needs the same exclusion. Keep this list in step with the dedicated entries above.
      //
      // HR Advisory and HR Operations joined on 2026-08-30 for exactly that reason: both seats land
      // on /hr/admin/hr-command-center, so this row was a SECOND "Command Center" in their sidebar
      // pointing at a worse page. Measured on production before removing it — the generic page
      // answered EGP 0 payroll, EGP 0 sales and EGP 0 expenses for HR Advisory, and EGP 0 sales /
      // EGP 0 expenses for HR Operations, because their scopes resolve to nothing on those
      // aggregates while the tiles render regardless. /admin is now the Super Admin's alone.
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], excludedRoles: ["CEO", "SFE Manager", "Finance Manager", "HR Advisory", "HR Operations"] },
    ],
    // Heading restored on owner instruction (2026-08-08). It was blanked for the SFE Manager on
    // 2026-08-02, where this section resolves to a single button; Super Admin and CEO see several
    // rows here, so they get the title (and the collapse toggle) back. SFE Manager still sees no
    // heading — see flatSidebarRoles.
    label: "Command Center",
  },
  // ── Ruling 10 (owner, 2026-08-28): "Layer 1 = Approvals + Organogram only" ──────────────────
  // Organogram had TWO rail entries: one inside Command Center gated roles: ["CEO"], one inside
  // People Management gated excludedRoles: ["Marketing Manager", "CEO"]. The two gates were
  // mutually exclusive, so no ordinary role ever saw both — and for the Super Admin, whose sidebar
  // bypasses `roles` entirely, dedupeSectionsByHref was the only thing keeping the second copy off
  // his rail. Nothing was visibly broken; the duplication was load-bearing, which is worse.
  //
  // The ruling settles it by giving the org chart a slot of its own, and collapsing the two copies
  // into one is what implementing the ruling looks like. The gate below is the exact UNION of the
  // two it replaces: everyone holding organogram:read except the Marketing Manager, who the People
  // Management copy excluded by name. The CEO exclusion is gone because it existed only to keep the
  // two copies apart — there is one copy now.
  //
  // tests/organogram-nav-link-exists-for-every-role-that-can-open-it.test.ts is the proof that no
  // role lost its link in the merge; it fails if any role that can open the page has no link to it.
  {
    id: "organogram",
    items: [
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }], excludedRoles: ["Marketing Manager"] },
    ],
    label: "Organogram",
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
      // Finance Manager merged in from the former `finance-events-calendar` section (module audit,
      // 2026-08-30). That section held this same href under this same label, gated roles:
      // ["Finance Manager"] excludedRoles: ["Super Admin", "CEO"] — so the rail carried two
      // sections named "Company Calendar" pointing at one page, kept apart only by role. The seer
      // set is unchanged by the merge: CEO, SFE Manager and Finance Manager by name, Super Admin
      // through the role bypass, exactly as before.
      //
      // Why the Finance Manager reads the PLANNING calendar and not /admin/company-calendar, kept
      // verbatim from the section this absorbed (owner, 2026-08-11): the authoring page would only
      // ever have reached head-office staff — canPublishCompanyWide is false for him — so it
      // promised a company-wide reach he does not have, while the planning calendar is the one he
      // actually needs to read. Both of his gates were verified before that row was pointed here:
      //   gate 1, the page — /admin/weekly-plans/calendar redirects unless canAccess(weekly_plans,
      //           read); he holds weekly_plans: ["read","export"], so he is admitted.
      //   gate 2, the data — isPlanItemVisibleToViewer narrows only the roles it NAMES (CEO,
      //           Training Manager, the line-scoped sales roles, District/Regional Manager) and
      //           ends in `return true`. Finance Manager is not named, so he keeps the documented
      //           unrestricted default and sees every calendar-eligible plan, company-wide.
      // If anyone ever adds a "finance manager" branch to that function, this row starts showing
      // him a narrowed calendar without the nav changing at all.
      { href: "/admin/weekly-plans/calendar", icon: CalendarRange, label: "Company Calendar", permissions: [{ resource: "weekly_plans", action: "read" }], roles: ["CEO", "SFE Manager", "Finance Manager", "HR Advisory"] },
    ],
    label: "Company Calendar",
  },
  {
    id: "ceo-recruitment-candidates",
    items: [
      { href: "/recruitment/candidates", icon: BriefcaseBusiness, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["CEO"] },
      // The SILENT manager-engagement report: which managers opened / answered / ignored the CVs
      // sent to them. Admin-shell row for CEO (Super Admin auto-sees via the waiver in
      // active-path.ts); a National Sales Manager reaches the same report, scoped to his line,
      // through the portal twin. A plain sidebar row, NOT a hub card — hub cards trip four extra CI
      // gates for no more reach. The managers being measured never see any of it.
      { href: "/recruitment/manager-engagement", icon: ClipboardList, label: "Manager CV Engagement", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["CEO", "HR Advisory"] },
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
        // Finance Manager excluded 2026-08-10 (owner). employee_profile:read is a
        // portalMinimumPermissions floor he must keep — it is what lets him open his OWN profile —
        // so the grant cannot be withdrawn to hide this row; the exclusion is the only lever. He is
        // the section's only visible item, so the whole "Employee 360" block leaves his sidebar.
        excludedRoles: ["Finance Manager"],
        permissions: [{ resource: "employee_profile", action: "read" }],
      },
    ],
    label: "Employee 360",
  },
  // ── PM Product Master, lifted out of the Employee 360 block (module audit, 2026-08-30) ───────
  // Restored to its own row on 2026-08-08 after being folded into the Marketing & ROI hub on
  // 2026-08-02; it remains a card in marketingRoiPageItems, which is how the SFE Manager (excluded
  // here) still reaches it. tests/sidebar-role-scoped-headings.test.ts lists /admin/pm-products in
  // RESTORED_ROWS, so the ROW itself is pinned and must not be removed.
  //
  // What moved is only which heading it sits under. It was the second item in the "Employee 360"
  // section, so Super Admin and CEO read a product-master link under a per-employee-profile
  // heading — two unrelated modules sharing one title. Its permission gate is employee_profile:read
  // purely because it inherited the section's, and that is the tell. The gate is carried over
  // UNCHANGED rather than "corrected": every role that could see this row still sees it, and
  // narrowing a live grant is not what a navigation tidy-up gets to do on its own.
  {
    id: "pm-product-master",
    items: [
      {
        href: "/admin/pm-products",
        icon: Package,
        label: "PM Product Master",
        excludedRoles: ["SFE Manager"],
        permissions: [{ resource: "employee_profile", action: "read" }],
        roles: ["Super Admin", "CEO"],
      },
    ],
    label: "PM Product Master",
  },

  // ── Approvals Hub: consolidated per-module approval surfaces (near the top —
  // responding to approvals is frequent daily work). Phase 1: Vacation + Excuse.
  // "Other Approvals" (resignation/outstation/contract/plan combined inbox) was
  // moved here from the People Management hub page so all approval surfaces are
  // reachable from one sidebar group.
  //
  // ── My Requests ──────────────────────────────────────────────────────────────
  // Admin-shell roles have no employee portal, so their OWN vacation/excuse submission lives
  // under /workspace. Both pages already existed and already admitted these roles
  // (requireAdminShellEmployeeWorkspaceAccess → adminShellEmployeeRoles), but nothing in the
  // sidebar pointed at them — so an SFE Manager had no way to file his own leave. This list
  // mirrors that server guard rather than inventing a new one.
  //
  // RESTORED 2026-08-31 (owner instruction). Phase 4 (2026-08-30) had removed these two rows and
  // moved them into the "My Workspace" tab strip; the owner asked for the sidebar rows back for
  // every admin-shell role that lost them, while KEEPING the workspace tabs exactly as they are.
  // So this is now ADDITIVE — both doors exist side by side: the rail rows here AND the personal-
  // workspace tabs (src/lib/workspace/personal-workspace-nav.ts, deliberately untouched). Do not
  // re-remove either half without the owner. The HR seats (HR Advisory / HR Operations) reach the
  // same two pages through the /hr "My Requests" section (hr-self), so they are unaffected by this.
  {
    id: "my-requests",
    items: [
      // The permission mirrors the page's own guard (requireAdminShellEmployeeWorkspaceAccess with
      // action "create"). This row was role-only until 2026-08-10, and the two gates disagreed:
      // the Finance Manager was the one adminShellEmployeeRole without leave:create, so the row
      // rendered for him and then bounced him to his landing page with no message. He was granted
      // the permission (see permissions.ts) so the row now works — this gate is the belt: a future
      // role added to adminShellEmployeeRoles without leave:create simply does not see the row,
      // instead of seeing a button that throws them out.
      // Finance Manager excluded 2026-08-10 (owner) from both rows below: they are folded into his
      // own consolidated "Leave Management" button instead (see the finance-leave-management
      // section and financeLeaveManagementVacationItems/financeLeaveManagementExcuseItems). Every
      // other adminShellEmployeeRole is unaffected — this is a navigation move, not a revocation;
      // he keeps leave:create and reaches the identical page through the new button.
      { href: "/workspace/leave-management/vacation-request", icon: CalendarCheck, label: "Request Vacation", permissions: [{ resource: "leave", action: "create" }], roles: adminShellEmployeeRoles, excludedRoles: ["Finance Manager"] },
      { href: "/workspace/excuses", icon: CalendarClock, label: "Submit Excuse", roles: adminShellEmployeeRoles, excludedRoles: ["Finance Manager"] },
    ],
    // This section was born headless (it postdates the pre-2026-08-02 sidebar, so it has no
    // "before" to restore). Given a title on 2026-08-08 so it is not the one unlabelled block
    // left floating among the restored headings — which is the exact look being undone here.
    // SFE Manager still sees no heading — see flatSidebarRoles.
    label: "My Requests",
  },
  {
    // Named "Approvals Hub" until 2026-08-30; ruling 10 calls this "Approvals" and the shorter
    // label is the owner's own word for it. The four rows below deliberately do NOT collapse into
    // /admin/approvals-hub: that page is the "Other Approvals" inbox and it actively BOUNCES
    // ?module=leave|excuse|weekly_plan deep links back out to the three dedicated pages (see
    // MIGRATED_DEEPLINK_BASES in app/(admin)/admin/approvals-hub/page.tsx). Collapsing them would
    // point one row at a page that refuses three quarters of the work it claimed to hold.
    id: "approvals-hub",
    items: [
      // Finance Manager excluded 2026-08-10 (owner) from both rows below, same reason as the two
      // "My Requests" rows above: folded into his consolidated "Leave Management" button. He keeps
      // leave:approve and reaches the identical pages through the new button.
      { href: "/admin/approvals/vacation", icon: CalendarCheck, label: "Leave Approvals", permissions: [{ resource: "leave", action: "read" }], roles: leaveExcuseApproverAdminNavigationRoles, excludedRoles: ["Finance Manager"], navBadge: "vacation-approvals-pending" },
      { href: "/admin/approvals/excuse", icon: CalendarClock, label: "Excuse Approvals", permissions: [{ resource: "leave", action: "read" }], roles: leaveExcuseApproverAdminNavigationRoles, excludedRoles: ["Finance Manager"], navBadge: "excuse-approvals-pending" },
      // "Weekly / Monthly Plan Approvals" measured 191px against a 118px budget — the worst clip in
      // either shell, and unfixable by geometry: no sensible rail width fits 191px beside an icon
      // and a pending badge. Shortened to match its siblings in this section (Leave Approvals /
      // Excuse Approvals / D.Orders Approval). The page keeps the full title.
      { href: "/admin/approvals/plan", icon: CalendarRange, label: "Plan Approvals", permissions: [{ resource: "weekly_plans", action: "read" }], roles: planApproverAdminNavigationRoles, navBadge: "plan-approvals-pending" },
      // "Other Approvals" is not a heading, so the only way to take the phrase off his sidebar is
      // to drop the row. No loss: this inbox carries resignation / contract / outstation items
      // only (getAwaitingMyActionItems), and the SFE Manager holds none of those grants — it was
      // an empty inbox for him. Every other role keeps it.
      //
      // Finance Manager excluded 2026-08-10 (owner), same mechanism, different reason: his
      // leave:read grant is load-bearing for the two rows ABOVE this one — he manages OF-0001 /
      // A-1 / A-4 and decides their vacations and excuses — so the row can only go by name.
      { href: "/admin/approvals-hub", icon: Inbox, label: "Other Approvals", permissions: [{ resource: "leave", action: "read" }], excludedRoles: ["SFE Manager", "Finance Manager"], navBadge: "approvals-hub-pending" },
    ],
    label: "Approvals",
  },

  // Finance-Manager-only consolidated Vacation + Excuse workspace (owner instruction, 2026-08-10).
  // Replaces his individual "Request Vacation"/"Submit Excuse" rows (My Requests) and "Leave
  // Approvals"/"Excuse Approvals" rows (Approvals Hub) with one button — those four rows carry
  // excludedRoles: ["Finance Manager"] above; every other role keeps them exactly as before. The
  // hub page (app/(admin)/admin/finance-leave-management/page.tsx) splits the same five actions
  // into "Vacations" and "Excuses" — see financeLeaveManagementVacationItems /
  // financeLeaveManagementExcuseItems below. excludedRoles carries Super Admin/CEO even though
  // `roles` alone already keeps CEO off this row — Super Admin's system-administrator workspace
  // bypasses `roles` but still honours excludedRoles (see getSections), so without it Super Admin
  // would see this Finance-only button as well as his own existing "Leave Management" row.
  {
    id: "finance-leave-management",
    items: [
      { href: "/admin/finance-leave-management", icon: CalendarDays, label: "Leave Management", roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Leave Management",
  },

  // ── Finance Manager's own rows (owner, 2026-08-10) ────────────────────────────
  // Four modules he was granted that have no sidebar route of their own for him. Each is a
  // dedicated one-item section rather than a card on a shared hub, for the reason the Leave
  // Management section above already documents: the hubs that host these modules
  // (People Management, Attendance, Payroll Management) all carry excludedRoles: ["Finance Manager"]
  // because every OTHER card on them is closed to him — putting him back on a hub to reach one card
  // would hand him a page that renders one tile and a heading he was deliberately removed from.
  //
  // `excludedRoles: ["Super Admin"]` on every one of them is mandatory, not decorative: the
  // system-administrator workspace bypasses `roles` entirely but still honours excludedRoles, so
  // without it Super Admin gains a duplicate row beside the hub card he already has.
  //
  // `permissions` mirrors each destination's own guard so a visible row can never bounce the person
  // who presses it — except the calendar, whose page gate is purely role-based (same as
  // finance-command-center and finance-leave-management above), so a permission there would be a
  // gate the page does not actually check.
  {
    id: "finance-resignations",
    items: [
      { href: "/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations", action: "read" }], roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Resignations",
  },
  {
    id: "finance-payslips-center",
    items: [
      { href: "/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips", action: "read" }], roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Payslips Center",
  },
  // Monthly Closing used to sit here, in the finance tier. Ruling 1 makes it one of the five sales
  // blocks ("Monthly Closing alone"), so it moved into the Tier 6 sales run — same id, same roles,
  // same href, same Finance-Manager-only visibility. Search `finance-monthly-closing` to find it.
  {
    id: "finance-fingerprint-report",
    items: [
      // His OWN attendance only (owner: "only himself"). The page behind this
      // (WorkspaceFingerprintReportPage) is hard-bound to access.hrId and takes no employee
      // selector — it has existed unlinked for some time, so this row is a route to an existing
      // self-scoped surface, not a new access surface.
      //
      // KEPT through the 2026-08-30 phase 4 collapse, and the reasoning is worth recording because
      // the first pass got it wrong. The page is now also a tab in the personal workspace strip, so
      // this row looked like pure duplication and was briefly deleted. It is not: this is one of the
      // SIX MODULES the owner added for the Finance Manager by name on 2026-08-10, pinned in
      // tests/navigation-active-path.test.ts under "the sidebar trim must not remove a duty the
      // Finance Manager actually holds". A second door to a page is not a defect; removing a row the
      // owner asked for, because a generic rule said personal pages belong elsewhere, is.
      { href: "/workspace/fingerprint-report", icon: Fingerprint, label: "Fingerprint Report", permissions: [{ resource: "attendance", action: "read" }], roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Fingerprint Report",
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
      // a stale permission-cache read even without a system-administrator waiver
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
      // ROI Tracker and PM Product Master were standalone sidebar rows; owner folded both into
      // this hub (2026-08-02) so each module lives in exactly one place. They are cards in
      // marketingRoiPageItems now.
      //
      // Financial Advisor is here for a specific reason: the ROI Tracker row it used to reach
      // directly listed it, this hub button did not, and it is an admin-shell role (not in
      // portalNavigationRoles). Folding without it would leave a finance role whose page guard
      // admits ROI Tracker with no sidebar route to it at all. Marketing Manager / Product Manager
      // / Group Product Manager are deliberately NOT added — they are portal-only and reach ROI
      // Tracker through the employee portal.
      //
      // Finance Manager was in this list for the same reason until 2026-08-10, when the owner took
      // Marketing & ROI and ROI Tracker off his sidebar. The page guard
      // (assertMarketingAdminPageAccess allowCompanyOversight) still admits him by URL — this is a
      // navigation decision, not a revocation — but nothing links him here any more. His remaining
      // marketing duty is the Approval Inbox below, which is the rung he actually executes.
      {
        href: "/admin/marketing-roi",
        icon: Megaphone,
        label: "Marketing & ROI",
        roles: ["Super Admin", "CEO", "SFE Manager", "District Manager", "Financial Advisor"],
      },
      // Pulled OUT of the hub onto its own sidebar tab (2026-08-02). It is an inbox — work
      // arrives in it and waits — so it needs to be visible at a glance with its pending badge,
      // not one click inside a hub of reports. Removed from marketingRoiPageItems in the same
      // change so the module lives in exactly one place. Roles mirror the card it replaces plus
      // SFE Manager, which is what assertMarketingAdminPageAccess already admitted.
      //
      // CEO added 2026-08-04. They hold `ceo_approval`, the LAST required rung of the live chain,
      // and this is the only shell they are ever shown (resolveNavigationMode pins CEO to "admin"),
      // so without this link the final approver had no route to their own queue at all.
      //
      // Finance Manager added 2026-08-10 for exactly the same reason, one rung further down: the
      // `finance_execution` step was activated and pointed at that role (owner: "Ahmed is the next
      // step after CEO"), which makes HIM the last rung. He is admin-shell only, so this link and
      // marketingAdminApprovalInboxRoles in src/lib/marketing-requests/admin-page-access.ts have to
      // move together — the nav roles alone would render a button that redirects him back out.
      {
        href: "/admin/marketing-requests/inbox",
        icon: Inbox,
        // 150px against a 98px budget — the tightest context there is: a standalone hub row that
        // ALSO carries a pending badge, so the label competes with both the ↗ and the count.
        label: "Marketing Inbox",
        // The pending badge the comment above promised. It needs its OWN kind: marketing is
        // deliberately excluded from the consolidated approvals hub (see the comments in
        // src/lib/action-center/service.ts and app/api/approvals-hub/hub-data/route.ts), so
        // "approvals-hub-pending" would count everything EXCEPT this inbox.
        navBadge: "marketing-approvals-pending",
        roles: ["CEO", "District Manager", "Super Admin", "SFE Manager", "Finance Manager"],
      },
      // RE-OPENED 2026-08-30 on the owner's explicit instruction ("open the sidebar route"), after
      // #2713 gave the Finance Manager an overdue-invoice figure on his dashboard and a link to the
      // screen behind it. Read the history before removing this again, because it has been removed
      // twice and neither removal recorded a product reason:
      //   7aec78485 (2026-07-03) dropped it as the third bullet of an unrelated ROI-label cleanup,
      //     with no rationale given at all;
      //   7454dc920 a CI bot auto-reverted that, because the test then pinned the row's PRESENCE;
      //   d5fd863e4 re-removed it and flipped the test to pin its ABSENCE, describing the removal as
      //     "an explicit, repeated product decision" — a characterisation of 7aec78485, which does
      //     not itself contain one.
      // The owner's 2026-08-10 trim of this section (Marketing & ROI, ROI Tracker) is NOT that
      // decision either: those are reporting surfaces, and he kept the rung the Finance Manager
      // actually executes. This row is that same kind of thing — the workspace where the approved
      // request is executed and its invoice chased — not a fifth report.
      //
      // roles mirrors canAccessAdminShellEmployeeWorkspacePage({ allowedRoles: workspaceMarketingRoles })
      // EXACTLY: Super Admin implicitly, plus SFE Manager / Finance Manager / Financial Advisor / CEO.
      // Nav roles must never exceed that guard (a row that redirects the viewer straight back out) and
      // never fall short of it (the gap #2713 existed to close). Change one, change both.
      {
        href: "/workspace/marketing-requests",
        // Matches the page's own WorkspaceFrame title, which is also why no re-measurement was
        // needed: "Marketing Requests" is already in the admin sidebar label snapshot.
        exact: true,
        icon: ReceiptText,
        label: "Marketing Requests",
        roles: ["Super Admin", "CEO", "SFE Manager", "Finance Manager", "Financial Advisor"],
      },
      // COLLAPSED TO THE HUB, 2026-08-30 (owner, asked directly). The company-wide register
      // (owner instruction, 2026-08-03 — every request on the system and where each one is
      // stopped, as distinct from the inbox above which carries only what waits on YOUR decision)
      // is now a card in marketingRoiPageItems under the same two roles. Both of them can open
      // /admin/marketing-roi, so neither loses the route; Marketing Manager was never on this row
      // and still reaches the same page through the portal.
      // Restored on 2026-08-08. It was pulled out of the hub onto the sidebar deliberately (it is
      // the ROI source of truth, and burying it one click inside a hub of four competing ROI cards
      // was the discoverability problem the module set out to fix), then folded back in on
      // 2026-08-02 by the SFE rebuild. The role list mirrors assertMarketingAdminPageAccess({
      // allowCompanyOversight: true }) minus the SFE Manager, who keeps reaching it as a card in
      // marketingRoiPageItems. Row-level visibility is still scoped per viewer inside
      // getMarketingRoiReport; this widens nothing.
      //
      // Finance Manager dropped from this list on 2026-08-10 (owner). Removed from
      // marketingRoiPageItems for him too — that hub card is what the Cmd+K palette folds back in,
      // so leaving it would have moved "ROI Tracker" from his sidebar into his command palette
      // rather than removing it.
      // ── REMOVED 2026-08-30 (owner's collapse) ────────────────────────────────────────────
      // The ROI Tracker row stood here with roles Super Admin, CEO, Marketing Manager, Product
      // Manager, Group Product Manager and Financial Advisor, minus the SFE Manager. It is gone,
      // and the three admin-shell roles on that list — Super Admin, CEO, Financial Advisor — now
      // reach the page as a card on /admin/marketing-roi, which all three can open.
      //
      // The other three were never served by this row at all, and the first attempt at this
      // collapse kept it FOR them on exactly that mistaken reasoning. Marketing Manager, Product
      // Manager and Group Product Manager are portal roles: resolveNavigationMode sends them to
      // the employee portal, so adminNavigationSections is not their rail and naming them in it
      // did nothing in either direction. Their route is the portal's own /employee-portals/roi
      // and /employee-portals/roi-tracker, which are deliberately separate URLs rather than a
      // shared page with this one (owner rule, 2026-07-28 — see the comment on that entry).
      //
      // Read that as the general warning it is: a `roles` list in this array is NOT a statement
      // about what a person can see. It is filtered by shell first, so a portal role written into
      // an admin section is dead weight that reads exactly like a working grant.
    ],
    // Heading restored on owner instruction (2026-08-08). It repeated the single button beneath
    // it in the SFE Manager's sidebar, but this section carries three rows for Super Admin, so
    // the title is doing real work there. SFE Manager still sees no heading — see flatSidebarRoles.
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
        // leave:read and weekly_plans:read let him past this gate, but peopleManagementPageItems
        // needs employees / vacancies / contracts / resignations — none of which he holds — so the
        // hub is empty for him. Probation, the one people-surface he genuinely owns, is its own
        // sidebar entry in this section and is unaffected.
        //
        // Finance Manager excluded 2026-08-10 (owner). Identical situation: leave:read +
        // weekly_plans:read open the button, and he holds none of the card grants, so this hub
        // rendered empty for him too. He is the section's only visible item, so the whole "People
        // Management" block leaves his sidebar.
        excludedRoles: ["SFE Manager", "Finance Manager"],
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
      // ── COLLAPSED TO THE HUB, 2026-08-30 (owner, asked directly) ──────────────────────────
      // Probation held FIVE rows here — /probation, /probation/dashboard, /probation/analytics,
      // /admin/probation-settings and the SFE Manager's own /admin/probation-tools hub. The four
      // expanded ones were the 2026-08-02 hub reverted by row 5 of the owner's 2026-08-08 decision
      // sheet; he was shown that history and chose the hub anyway. Do not restore them without a
      // fresh instruction.
      //
      // The single row below is the same hub the SFE Manager already had, widened to everyone who
      // held any of the four. Its gate is deliberately `probation` with no action, matching what
      // /probation itself used, rather than `probation:read`: the settings row was probation:update
      // and narrowing here could silently drop an update-only holder. The page's own guard is
      // probation:read, so an update-only role would be redirected — but that is the pre-existing
      // shape of the SFE row, not something introduced here.
      //
      // CEO is excluded because he never held any of the four (/probation excluded him by name and
      // he is on none of the other role lists) and he has his own /admin/ceo-probation section.
      // Without the exclusion the collapse would GRANT him a row, which is not what was asked for.
      //
      // Nothing is stranded, and this was checked rather than assumed: all four hrefs are cards in
      // probationPageItems; /admin/probation-tools admits anyone with probation:read; and each
      // card's own gate covers its old audience — Marketing Manager and Training Manager keep the
      // dashboard and analytics cards, Super Admin keeps all four, and the Marketing Manager stays
      // excluded from the Probation Cases card exactly as his old row excluded him.
      { href: "/admin/probation-tools", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }], excludedRoles: ["CEO"] },
      // Restored on 2026-08-08. Moved into the CRM hub on 2026-08-02 because it is judged on CRM
      // visit activity; it stays a card there for the SFE Manager, who is excluded here.
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }], excludedRoles: ["SFE Manager"] },
    ],
    // Heading restored on owner instruction (2026-08-08), same treatment as Command Center.
    // SFE Manager still sees no heading — see flatSidebarRoles.
    label: "People Management",
  },
  // The Recruitment & Hiring hub button (app/(admin)/admin/recruitment-hiring/page.tsx, items in
  // recruitmentHiringPageItems below), plus the Returned CVs queue beside it — same pattern as the
  // other consolidated sections above. Both rows share the exact same gate.
  {
    id: "recruitment-hiring",
    items: [
      // The ONE entry on this list that also needs a permission clause. Every other consumer of
      // hrAuthorityNavigationRoles carries one, so the matrix separates the two HR bundles for
      // free; this button did not, and would have put a Recruitment & Hiring row in HR Operations'
      // sidebar opening a hub whose seven cards are all filtered out for her — the same empty-hub
      // defect already recorded above for SFE Manager and Finance Manager on People Management.
      { href: "/admin/recruitment-hiring", icon: BriefcaseBusiness, label: "Recruitment & Hiring", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
      // Returned CVs — where a district manager's "return this CV to the administrator" lands, one
      // pile per returning manager and reason (app/(admin)/recruitment/returned-cvs/page.tsx). A
      // plain sidebar row rather than a ninth hub card, which would trip four unrelated CI gates for
      // no more reach — the same choice Manager CV Engagement made. The recruitment:read clause is
      // what its page gate reads too, so the two cannot drift (every-offered-link-opens.test.ts).
      { href: "/recruitment/returned-cvs", icon: Undo2, label: "Returned CVs", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
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
        // 147px against a 136px budget. The hub page still titles itself Attendance Management.
        label: "Attendance",
        // The SFE Manager holds attendance:read, so the permission gate lets him through — but
        // every card inside attendanceManagementPageItems is gated on employees/hr_calendar,
        // which he does not hold, so the hub renders with ZERO items. A link to an empty page is
        // worse than no link, and attendance is not part of his sales/CRM remit either.
        //
        // Finance Manager excluded 2026-08-10 (owner) — same empty hub, same reasoning. His
        // attendance:read/export grant stays: it feeds the payroll and day-report surfaces he
        // keeps, so only the row goes.
        excludedRoles: ["SFE Manager", "Finance Manager"],
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
      { href: "/leave-management", icon: CalendarDays, label: "Leave Management", roles: ["Super Admin", "CEO", "HR Operations"] },
      // Vacation Action Center removed — replaced by the Approvals Hub › Vacation Approvals surface.
    ],
    label: "Leave Management",
  },
  // Owner request (2026-08-27): the SFE Manager gets his own vacation report — every employee's
  // leave, org-wide, with the SOURCE of each day on the row: a request submitted through Phoenix,
  // or a vacation the field CRM recorded on its own. It points at the existing
  // /admin/vacation-report, which grew a read-only mode for him (no Review column, no "Approve as
  // real leave"; the filters and the Excel export are untouched).
  //
  // Its OWN section rather than a row inside the Leave Management hub above, for the reason
  // spelled out on the early-birds section further down — navigation-active-path.test.ts pins
  // the exact ordered href list of several sections, so inserting into one breaks it. A section
  // resolving to a single visible item renders headerless, which is exactly the "tab" this is
  // meant to be for him.
  //
  // excludedRoles, not `roles` alone: Super Admin's sidebar bypasses role gating entirely (see
  // getSections), and he already reaches this page as a card on the Admin Tools hub — without
  // the exclusion he would be shown the same page twice, which is precisely the duplicate-href
  // failure tests/sidebar-role-scoped-headings.test.ts asserts against.
  {
    id: "vacation-sources",
    items: [
      { href: "/admin/vacation-report", icon: FileSpreadsheet, label: "Vacation Sources", permissions: [{ resource: "leave", action: "read" }], roles: ["SFE Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Vacation Sources",
  },
  // Owner request (2026-08-28): the SFE Manager also gets the Company Activity Report — a
  // day-by-day account of what every employee actually did (CRM visits, office attendance, leave,
  // gaps) over a freely chosen date range. Deliberately its OWN section, not merged into
  // vacation-sources above — the owner was explicit this is a separate module from anything
  // vacation- or Private-Calendar-related, and a section resolving to a single visible item
  // renders headerless, matching how vacation-sources itself renders for him.
  //
  // excludedRoles, not `roles` alone — same reasoning as vacation-sources: Super Admin's sidebar
  // bypasses role gating entirely and already reaches this page as a card on the Admin Tools hub;
  // without the exclusion he would see the same page twice.
  {
    id: "company-activity-report",
    items: [
      { href: "/admin/company-activity-report", icon: Activity, label: "Activity Report", permissions: [{ resource: "leave", action: "read" }], roles: ["SFE Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Company Activity Report",
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
        // payroll:read admits him to the hub, but every card in payrollManagementPageItems is
        // gated tighter, so it renders empty for him. Payroll is not in his remit; his own
        // payslip lives in the employee portal.
        //
        // Finance Manager excluded 2026-08-10 (owner). His real payroll surface is the separate
        // "Payroll — Finance" row under Automated Payroll (/admin/automated-payroll/finance,
        // unaffected by this change) — this hub's cards were otherwise Super-Admin/CEO-gated and
        // rendered nothing for him except "Deductions", which is now excluded by name too (see
        // payrollManagementPageItems below).
        excludedRoles: ["SFE Manager", "Finance Manager"],
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
        labelByRole: { "Finance Manager": "Payroll" },
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
  // sections above. The items' roles are drawn from the same two-role set
  // (Super Admin / CEO), so the button's gate is that union.
  //
  // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
  // This is the whole section, not a card: he is the only item in it, so the "Outstation Expenses"
  // block leaves his sidebar entirely. His matrix lost the `outstation` key in the same change and
  // OUTSTATION_EXPENSES_ROLES in the hub page dropped him too, so the row, the hub and the pages
  // behind it all close together — a sidebar list alone is UX, never the boundary.
  {
    id: "expenses-outstation",
    items: [
      { href: "/admin/outstation-expenses", icon: Radar, label: "Outstation Expenses", roles: ["Super Admin", "CEO"] },
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
  // ── Ruling 6 (owner, 2026-08-28): "Early Birds with Field Force" ─────────────────────────────
  // This section was authored on 2026-08-09 (#1918) naming Super Admin, CEO and SFE Manager —
  // three admin-shell roles — and appended to employeePortalNavigationSectionSeeds instead of to
  // this array. It is the ONLY /admin/* href in that portal list, which is the signature of the
  // slip rather than a decision. resolveNavigationMode pins all three of those roles to "admin",
  // so the entry has never rendered for anybody in either shell: this rail never held it, and no
  // portal viewer is on its role list.
  //
  // The module was not unreachable, which is why no guard fired: /admin/early-birds is linked from
  // a card in src/components/admin/ceo-phase-b.tsx:862, and that component is rendered by BOTH
  // /admin/ceo-command-center and /admin/sfe-command-center — so each of the three roles above
  // could reach the page, and tests/navigation-reachability-backlog.ts was right to record it as
  // "linked-from-a-component" rather than as stranded.
  //
  // What makes that a thin door rather than a real one is the CONDITION on it. The card renders
  // inside `{earlyBirdStars.length > 0 ? … : null}`, so a fortnight with no stars to show removes
  // the module's only route, for everybody, with nothing anywhere saying so. A rail row does not
  // blink out when the data behind it is empty; that is most of what a rail row is for.
  //
  // Placed here rather than anywhere else because the ruling says so: Early Birds is field-force
  // recognition and Field Coaching is the row it belongs beside.
  //
  // The stray portal-array copy was DELETED on 2026-08-30, with the owner asked for that specific
  // permission first — it sat in employeePortalNavigationSectionSeeds, and his standing instruction
  // for this audit is not to touch the employee portal. Nothing observable changed: every role on
  // that row (Super Admin, SFE Manager, and CEO via its explicit early return) resolves to the
  // ADMIN shell in resolveNavigationMode, and the portal array only renders in portal mode, so the
  // row was offered to three roles who were never in the shell that could draw it. This row, in
  // this array, is now the only one.
  {
    id: "early-birds",
    items: [
      { href: "/admin/early-birds", icon: Sunrise, label: "Early Birds", permissions: [{ resource: "early_birds", action: "read" }], roles: ["Super Admin", "CEO", "SFE Manager"] },
    ],
    label: "Early Birds",
  },
  // ── COLLAPSED TO THE HUB, 2026-08-30 (owner, asked directly) ────────────────────────────────
  // This section held NINE rows for the Super Admin: /admin/crm plus seven Super-Admin-only tools,
  // beside the /admin/crm-tools hub button that every other role gets. He was shown the trade —
  // 9 rows against 1, with every page still one click inside the hub — and chose the hub. That
  // REVERSES the 2026-08-08 restoration and the 2026-08-29 completion of it, both of which are
  // recorded below; do not restore the rows without a fresh instruction.
  //
  // The mechanism is one line: /admin/crm-tools used to name Super Admin in excludedRoles, because
  // the 2026-08-08 rule was that he must never see a hub button beside the rows duplicating it.
  // With the rows gone, that exclusion is what would leave him with no CRM row at all, so it goes
  // and the seven rows go with it. Finance Manager stays excluded — that is a separate owner
  // decision from 2026-08-10, and unrelated.
  //
  // Nothing is stranded, and this was checked rather than assumed: all nine hrefs that used to be
  // rows are cards in crmPageItems, /admin/crm-tools' own page guard admits anyone holding
  // crm_visits, double_visit_analytics or hr_calendar (so it admits him), and every one of those
  // cards names Super Admin or is gated on permission alone.
  //
  // What the removed rows were, kept so the history is not lost with them:
  //   /admin/crm                          the CRM workspace itself — sync health, manual pull, the
  //                                       raw master table, unmapped-identity resolution and
  //                                       recovered-chains review, all on that page's own tab bar.
  //                                       Super Admin's direct link to it was the whole of this
  //                                       section before the 2026-08-02 SFE rebuild.
  //   /admin/reps-plans                   Reps Plans
  //   /admin/doctor-list                  Doctor List           } the District Manager page's two
  //   /admin/plan-verification            Plan Verification     } tabs, two routes, two rows
  //                                       — Doctor List and that tab strip were retired 2026-08-31;
  //                                       /admin/reps-list replaced the first and Plan Verification
  //                                       now stands on its own.
  //   /admin/crm-integrity                CRM Integrity
  //   /admin/brick-coverage               Brick Coverage
  //   /admin/double-visit-analytics       Double Visit Analytics
  //   /admin/double-visit-data-integrity  Double Visit Integrity — the label was shortened from
  //                                       "Double Visit Data Integrity" because that string
  //                                       measured 160px against this shell's 157px budget. It
  //                                       keeps the full name as a hub card, where the budget is
  //                                       different. Never model these widths: the app resolves to
  //                                       Aptos and a per-character estimate was once off by 9px
  //                                       against ~5px of slack. scripts/measure-sidebar-labels.ts
  //                                       regenerates tests/fixtures/sidebar-label-widths.json.
  {
    id: "crm",
    items: [
      // Owner decision 2026-08-02: the SFE Manager owns sales and CRM, so he gets the workspace.
      // Server side is enforced by canUseAdminCrmWorkspace (src/lib/crm/admin-access.ts) — this
      // list only controls the sidebar.
      //
      // The role list is wider than the workspace's own grant because the hub also carries
      // Workforce Compliance (hr_calendar) and Double Visit Analytics: gating the button on the
      // workspace grant alone would hide the hub from roles holding one of the other two. Each
      // card still carries its own gate.
      //
      // Finance Manager excluded 2026-08-10 (owner). crm_visits:read is what admitted him, and
      // that grant has to stay — canViewEmployeeActivity and the attendance manager view both
      // read it — so the row is removed by name.
      { href: "/admin/crm-tools", icon: Database, label: "CRM", permissions: [{ resource: "crm_visits" }, { resource: "double_visit_analytics" }, { resource: "hr_calendar" }], excludedRoles: ["Finance Manager"] },
    ],
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
  // Sales vs Target — its OWN standalone sidebar button rather than a child of the Targets
  // group. It reads the same au.f_monthly_achievement engine as Targets, so grouping it there
  // was defensible on data lineage, but the owner expects this to be the most-opened dashboard
  // in the system and a collapsed group made it a two-click destination (decision 2026-08-04).
  // Admin-shell roles only; DM/RM/NSM/Medical Rep land in the employee-portal shell and the page
  // redirects them to /employee-portals/sales-vs-target rather than denying them.
  {
    id: "sales-vs-target-module",
    items: [
      { href: "/sales/vs-target", icon: Gauge, label: "Sales vs Target", permissions: [{ action: "read", resource: "sales" }], roles: ["Super Admin", "SFE Manager", "CEO"] },
    ],
    label: "Sales vs Target",
  },
  {
    id: "sales-direct-orders",
    items: [
      // navBadge added 2026-08-10 (owner: builds 1-3, no emails). Counts APPROVED orders still
      // carrying no sales month — the Finance Manager's one exclusive duty, and the only queue in
      // the product with no chaser of any kind behind it (the approved-order email fires once, at
      // CEO approval, and nothing mentions the order again). The owner declined a reminder email,
      // so this badge IS the chase: it follows him onto every page and only clears when the queue
      // does.
      //
      // Safe on the roles that share this row. The row is permission-gated only, so SFE/CEO/sales
      // managers reach it too — but getDirectOrderUnbookedBadge returns 0 to anyone who cannot
      // actually book a month, so it lights up for B-185 and Super Admin alone. A badge that
      // another role cannot clear is how people learn to ignore badges.
      { href: "/admin/direct-orders", icon: ReceiptText, label: "Direct Orders", permissions: [{ resource: "direct_orders", action: "read" }], navBadge: "direct-orders-needs-action" },
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
  // Sales Queue retired 2026-08-02. It was the only surface that could approve a monthly sales
  // import batch, so the workflow was not deleted — it moved into the Sales Import workspace as
  // the "Approvals" tab (/sales/import?tab=approvals), reachable from the Source of Sales hub.
  {
    id: "sales-targets-module",
    items: [
      // VIEW is sales:read bounded by TARGETS_ADMIN_VIEW_ROLES (the page's own gate); EDIT is still
      // sales:import. Previously this whole entry was sales:import, so the CEO — who holds
      // sales:read and lands in the ADMIN shell, hence cannot use the portal twin — had no way to
      // see target achievement at all.
      { href: "/sales/targets", icon: Target, label: "Targets", permissions: [{ action: "read", resource: "sales" }], roles: ["Super Admin", "SFE Manager", "CEO"] },
    ],
    label: "Targets",
  },
  // Ruling 1 (owner): Sales is five blocks, with Monthly Closing alone and Targets alone. This is
  // the "Monthly Closing alone" block. It was `finance-monthly-closing`, filed under the finance
  // tier and holding the Finance Manager's export row only; moving it up here was the first half of
  // the ruling, and giving the Super Admin a row of his own (2026-08-30) is the second. The two
  // rows point at DIFFERENT pages under mutually exclusive gates — the note on each says why. The
  // long account of WHY the Finance Manager gets the analytics detail route rather than
  // /sales/monthly-closing is preserved below; that reasoning is load-bearing and cost a real
  // incident to work out.
  {
    id: "monthly-closing",
    items: [
      // Ruling 1 (owner, 2026-08-28): Sales is five blocks, and Monthly Closing is one of them,
      // standing alone. Targets — the other block the ruling names outright — already had its own
      // rail row. Monthly Closing had one only for the Finance Manager, on the export-only page
      // below; for everyone else it was a card inside the Source of Sales hub, i.e. one of the five
      // blocks folded into another of the five.
      //
      // Super Admin ONLY, and that is a gate rather than a preference. /sales/monthly-closing
      // admits Super Admin, system scope and the SFE Manager and redirects everyone else, so a CEO
      // row here would bounce on entry — which is the same reason the Finance Manager's row below
      // deliberately points at a different page. The SFE Manager is left out for the opposite
      // reason: he keeps the flat sidebar WITH hub buttons and reaches this page as a Source of
      // Sales card, which is the 2026-08-08 rule pinned by
      // tests/sidebar-role-scoped-headings.test.ts.
      //
      // The section id changed from "finance-monthly-closing" with this row, because the section is
      // no longer one role's. Section ids are the localStorage key for the per-user collapsed set,
      // so the only effect is that this section starts expanded once for anyone who had collapsed
      // it; no saved sidebar ARRANGEMENT is affected, that layout is stored by href.
      { href: "/sales/monthly-closing", icon: ChartColumnBig, label: "Monthly Closing", permissions: [{ resource: "sales", action: "read" }], roles: ["Super Admin"] },
      // Owner, 2026-08-11: a Monthly Closing tab of his own, able to export the full workbook for
      // CNS, Pedia or Anti Infective.
      //
      // He asked for /sales/monthly-closing. This row deliberately points somewhere else, because
      // that page cannot give him what he asked for and would be a dead link twice over:
      //   1. its guard admits only Super Admin, system scope and SFE Manager — he is redirected;
      //   2. even past that, it loads its matrix behind assertPermission(sales, "import"), and
      //      `sales:import` is the one action he must never hold — it is the gate on the whole
      //      upload/publish workspace and ten other pages. Granting it to reach an export would
      //      hand him the ability to produce the closing he is only meant to consume.
      //
      // /admin/analytics/monthly-closing/details is the export-only surface built for exactly this
      // in #2010: assertPermission(sales, "read") plus canViewAdminCoreAnalytics, both of which he
      // passes, and its Export XLSX button posts to /api/sales/monthly-closing/export, whose
      // Branch A names Finance Manager — the full sheet set for any line, published or not.
      //
      // Ruling 11 delisted the Sales Analytics module from navigation, which makes this the ONLY
      // remaining nav entry anywhere into the /admin/analytics tree. That is deliberate: the ruling
      // removed the module, not this role's export, and the two were never the same thing.
      { href: "/admin/analytics/monthly-closing/details", icon: ChartColumnBig, label: "Monthly Closing", permissions: [{ resource: "sales", action: "read" }], roles: ["Finance Manager"], excludedRoles: ["Super Admin", "CEO"] },
    ],
    label: "Monthly Closing",
  },
  // Territory Management was its own rail block until ruling 1 capped Sales at five. It is the
  // Source of Sales geography — every SoS sale attributes to today's geography — so it folded into
  // the Source of Sales hub as a card rather than losing its home (see sourceOfSalesPageItems).
  // The page and its own role gate are untouched; only the door moved.
  //
  // Sales Analytics was a rail block here too, pointing at /admin/analytics. Ruling 11 — "no
  // analytics module, no sales analytics", said three times — removed it. The page and the nine
  // modules under it still ship and still work by URL; nothing in the rail or the command palette
  // offers them any more. Do NOT re-add a row here: tests/navigation-ruling-11-analytics.test.ts
  // fails the PR if any role's rail exposes /admin/analytics, or if a rail label is exactly
  // "Sales Analytics". It does NOT match the word "analytics" generally — "Attendance Analytics"
  // and the other in-module TAB labels are a wider reading of the ruling the owner has not been
  // asked to confirm, so they are deliberately left alone and deliberately not pinned either way.

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
      // 149px against a 136px budget. Page title keeps the full "Access & Communication".
      { href: "/admin/access-communication", icon: ShieldCheck, label: "Access & Comms", permissions: [{ resource: "admin_access" }, { resource: "communication" }], excludedRoles: ["CEO"] },
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
    items: [
      // Finance Manager excluded 2026-08-10 (owner): "Report It" is the only card this hub ever
      // showed him ("Reports Dashboard" inside it is Super Admin only), so it is pulled out onto
      // its own direct tab below instead of one click inside a single-card hub — same treatment as
      // "Marketing Inbox" (see the workspace-marketing-requests section above).
      { href: "/admin/pharmacovigilance", icon: ShieldAlert, label: "Pharmacovigilance", excludedRoles: ["Finance Manager"] },
      // excludedRoles carries Super Admin for the same reason as the finance-leave-management
      // section above: `roles` alone does not stop the system-administrator workspace bypass, and
      // Super Admin already reaches this page via the hub row he keeps.
      { href: "/admin/report-it/new", icon: ShieldAlert, label: "Report It", roles: ["Finance Manager"], excludedRoles: ["Super Admin"] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSectionSeed[];

const employeePortalNavigationSectionSeeds = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/employee-360", icon: IdCard, label: "Employee 360", permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/private-calendar", icon: CalendarDays, label: "Private Calendar", permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] },
      // Training Manager added 2026-08-25. He has held `organogram: ["read"]` and passed
      // canAccessCompanyOrganogram the whole time — the page itself even names him in its
      // comment as one of the company-wide roles that reach it — but he was never listed
      // here, so the portal offered him no way in. A grant with no nav entry is not a
      // security hole (the page gates independently); it is a page nobody can find.
      { href: "/employee-portals/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram", action: "read" }], roles: ["District Manager", "National Sales Manager", "Regional Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/recruitment-candidates", icon: UsersRound, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Catalog entry for the SILENT manager-engagement report (real nav lives in
      // employee-portal-layout.tsx, gated by showManagerEngagementTab → National Sales Manager only).
      // Present here so Cmd/Ctrl+K can find it and the browser tab carries its own title; the command
      // palette filters by these roles/permissions, so only an NSM sees it in search. Required by
      // employee-portal-nav-catalog-sync.test.ts, which pins every real-nav portal href as either
      // catalogued or a recorded omission.
      { href: "/employee-portals/recruitment-engagement", icon: ClipboardList, label: "Manager CV Engagement", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["National Sales Manager"] },
      { href: "/employee-portals/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/employee-portals/contact-hr-support", icon: LifeBuoy, label: "HR Support", permissions: [{ resource: "support_requests", action: "create" }] },
      { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Outstation Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expense Dashboard", permissions: [{ resource: "expenses" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/expense-submissions", icon: FileClock, label: "Expense Submissions", permissions: [{ resource: "expenses" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/team-expenses", icon: ReceiptText, label: "Team Expenses", permissions: [{ resource: "expenses" }], roles: ["National Sales Manager"] },
      // Present here so the destination is CURATABLE from Modules Control — the catalog is matched
      // by href, and a portal page missing from it is silently always-visible. This entry is what
      // employee-portal-nav-catalog-sync.test.ts checks for.
      { href: "/employee-portals/early-birds", icon: Sunrise, label: "Early Birds", permissions: [{ resource: "early_birds", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
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
      { href: "/employee-portals/approvals/vacation", icon: CalendarCheck, label: "Leave Approvals", permissions: [{ resource: "leave", action: "read" }], roles: vacationApproverPortalNavigationRoles, navBadge: "vacation-approvals-pending" },
      { href: "/employee-portals/approvals/excuse", icon: CalendarClock, label: "Excuse Approvals", permissions: [{ resource: "leave", action: "read" }], roles: excuseApproverPortalNavigationRoles, navBadge: "excuse-approvals-pending" },
      // Shortened with its admin twin above (same 191px clip, same reason).
      { href: "/employee-portals/approvals/plan", icon: CalendarRange, label: "Plan Approvals", permissions: [{ resource: "weekly_plans", action: "read" }], roles: planApproverPortalNavigationRoles, navBadge: "plan-approvals-pending" },
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
  // The portal-side "Recruitment & Hiring" and "People Management" mirrors were REMOVED on
  // 2026-08-28 with the Talent Acquisition role, which was their only holder. Both successor
  // bundles (HR Advisory, HR Operations) are admin-shell roles, so the admin-shell originals
  // these mirrored — app/(admin)/recruitment, /cv-database, /hiring-documents, /hiring-pack,
  // /offers, /recruitment/intake-health, /leave-management/vacation-control — are now the only
  // copy, reached through hrAuthorityNavigationRoles above. Do not recreate a portal mirror for
  // an admin-shell role: maintaining two copies of one tool is what shipped two of these
  // unreachable, and the second copy is where the drift always lands.
  {
    id: "sales-operations",
    items: [
      { href: "/employee-portals/source-of-sales", icon: ChartNoAxesColumnIncreasing, label: "Source of Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // ONE Direct Orders row. `direct_orders:read`, not `create`: approvers who never raise an
      // order still need the workspace, and their queue lives in it now that the standalone
      // D.Orders Approval row is retired. The Report is reachable from inside the workspace.
      { href: "/employee-portals/direct-orders", icon: ReceiptText, label: "Direct Orders", permissions: [{ resource: "direct_orders", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"], navBadge: "direct-orders-needs-action" },
      { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Portal render of the admin /sales/monthly-closing Closing Matrix + Details — published-gated
      // and scoped per viewer (see loadPortalMonthlyClosing / canAccessPortalClosing). Roles mirror
      // PORTAL_CLOSING_ROLES: no Medical Rep (no line). Marketing Manager added 2026-08-12 (owner)
      // — this row IS the "/sales/monthly-closing tab" he asked her to have; that admin URL bounces
      // portal-navigation roles before any permission check, so her door is here. She opens Anti
      // Infective / Pedia / CNS through the line picker and exports the full workbook for each.
      { href: "/employee-portals/monthly-closing", icon: CalendarRange, label: "Monthly Closing", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Sales Analytics (/employee-portals/sales-analytics) — hidden from every role, owner
      // request 2026-08-08. Was: Medical Rep, District Manager, Regional Manager, National Sales
      // Manager, Product Manager, Group Product Manager, Marketing Manager. Kept in the catalog
      // (not deleted) — tests/employee-portal-nav-catalog-sync.test.ts (M12) requires every href
      // the portal layout renders to be either catalogued or in KNOWN_UNCURATABLE, and that
      // allowlist is for permanently-VISIBLE pages, the opposite of this one. `roles: []` hides it
      // from every role (roleAllowed reads an EMPTY array as "nobody", distinct from an absent
      // one meaning "no constraint"); `excludedRoles: ["Super Admin"]` is what stops
      // navigationItemVisible resurfacing it, since that helper waives the `roles` gate for the
      // system administrator and honours excludedRoles for everybody. BOTH HALVES ARE REQUIRED —
      // dropping either one puts this page back on somebody's rail. Same pattern as the Probation
      // SFE-Manager row above.
      { href: "/employee-portals/sales-analytics", icon: Activity, label: "Sales Analytics", permissions: [{ resource: "sales" }], roles: [], excludedRoles: ["Super Admin"] },
      // Sales vs Target — catalogued (rather than listed as intentionally uncuratable) so an admin
      // can hide it per role from Modules Control. Roles mirror showSalesVsTargetTab in
      // src/lib/employee-portal/navigation.ts; the enforcing gate is resolveVsTargetBound, and a
      // role here with no resolvable territory still fails closed to an empty scope.
      { href: "/employee-portals/sales-vs-target", icon: Gauge, label: "Sales vs Target", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Portal counterpart of /business-review, scoped per viewer. Medical Rep is deliberately
      // absent — the owner ruled this module is managers-only. CEO/SFE Manager/Super Admin reach it
      // through the admin entry instead, since that is the shell they land in.
      // The real gate is the access map in src/lib/business-review/portal-scope.ts; this list is
      // UX only, and a role here with no seat in that map still resolves to no access.
      { href: "/employee-portals/business-review", icon: LayoutDashboard, label: "Business Review", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // RETIRED 2026-08-28 (owner's instruction, in the conversation): "Doctor Coverage" and
      // "Doctor Coverage Settings" were listed here for the seven portal-mode sales roles. Both are
      // withdrawn along with the admin twins — see the retirement note on crmPageItems below for
      // why. DO NOT RE-ADD either row: the board they point at scores every doctor against the
      // GRADE norm instead of the rep's own planned call count, which the owner has ruled is the
      // wrong measure. A replacement is being built; it gets its own entry when it ships.
      // All four sales roles now shipped (Medical Rep, District Manager, Regional Manager,
      // National Sales Manager) — see TERRITORY_DRILLDOWN_ROLES in
      // src/lib/sales/territory/service.ts, the server-side gate this list must match.
      { href: "/employee-portals/territory-drilldown", icon: MapPinned, label: "Sales Drilldown", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] },
      // Portal-shell counterpart of /sales/territory-management — same component, own-scope data.
      // Medical Rep is deliberately excluded: this compares MULTIPLE areas' bricks against each
      // other, which is a District-Manager-and-up decision, not a single rep's own area view.
      { href: "/employee-portals/territory-management", icon: Waypoints, label: "Territory Management", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
      // Read-only Targets (owner decision 2026-07-30). Mirrors PORTAL_TARGETS_ROLES; editing and
      // upload stay on the admin surface with SFE Manager / Super Admin.
      { href: "/employee-portals/targets", icon: Target, label: "Targets", permissions: [{ resource: "sales", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
      // Scoped CRM Master. Catalog entry (so Modules Control can curate it); the rendered sidebar
      // link lives in the Fieldforce section of employee-portal-layout.tsx. Mirrors PORTAL_CRM_ROLES
      // in src/lib/crm/portal-crm-scope.ts (adds Medical Rep to the DSM/RM/NSM set above).
      { href: "/employee-portals/crm", icon: Database, label: "CRM", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] },
      // Reps List — the portal twin of /admin/reps-list, added 2026-08-31 with it ("every manager in
      // the employee portal has a scoped reps list"). Catalog entry so the command palette can find
      // it and the browser tab gets its label; the rendered sidebar link sits under CRM in the Field
      // Activity section of employee-portal-layout.tsx.
      //
      // NO Medical Rep, unlike the CRM row above. This board is about the reps who report to you, so
      // a rep would reach it and see nobody — and the enforcing gate (canAccessDoctorList, in
      // src/lib/crm/doctor-list-access.ts) does not admit the role at all. These three roles must
      // stay in step with the portal-side half of DOCTOR_LIST_ACCESS_ROLES.
      { href: "/employee-portals/reps-list", icon: BookUser, label: "Reps List", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
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
        // Same dedicated badge as the admin-shell tab — this is the surface the portal-side
        // approvers on the chain (District Manager / National Sales Manager, Marketing Manager)
        // actually use.
        navBadge: "marketing-approvals-pending",
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
      // Company-wide register (owner instruction, 2026-08-03): every request on the system with
      // the step it is stopped at. The Approval Inbox above only carries what is waiting on YOUR
      // decision, so it can never answer "where is everything else?" for an oversight role.
      {
        href: "/employee-portals/marketing-requests/all",
        icon: ClipboardList,
        label: "All Marketing Requests",
        roles: ["Marketing Manager", "SFE Manager", "Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/control",
        icon: Settings2,
        label: "Marketing Control",
        roles: ["SFE Manager", "Super Admin"],
      },
      // SFE Manager added 2026-08-03 alongside Super Admin — it owns validation, so it must see
      // every customer employees submitted, validated or not.
      {
        href: "/employee-portals/marketing-requests/customer-database",
        icon: Database,
        label: "Customer Database",
        roles: ["SFE Manager", "Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/coverage-report",
        icon: MapPinned,
        // 161px against a 136px budget. It already sits under the Marketing Requests section, so
        // the "Marketing" prefix was doing no work in the rail. Page title keeps it in full.
        label: "Coverage Report",
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

// ── The /hr namespace (HR Advisory + HR Operations) ──────────────────────────
//
// Owner instruction, 2026-08-28: the two HR seats must not sit on the admin addresses — "due to
// security reasons and due to not see things they are not should be able to see". This list is
// that namespace's navigation, and it is AUTHORED rather than derived, which is the whole point.
//
// Deriving it (filter adminNavigationSections by the HR permission matrix) was measured first and
// rejected. It admits three rows neither seat has any business seeing, because the sidebar's
// permission check FAILS OPEN on a resource the item never names:
//   • /admin/pharmacovigilance — no permission gate at all, only `excludedRoles: ["Finance
//     Manager"]`, so every other role on earth passes it;
//   • /admin/field-coaching — a sales-management hub reached on a coaching grant that exists for
//     one JD line about performance follow-up;
//   • /admin/crm-tools (HR Operations only) — a CRM hub whose single reachable card is Workforce
//     Compliance, which she already has as a row of her own.
// Those are presentation leaks, not permission leaks: every page behind them re-asserts its own
// grant server-side. But the owner asked for a surface with nothing on it they should not see, and
// an authored list is the only kind that stays that way as modules are added. A new admin module
// appears in the HR sidebar only when someone writes it here on purpose.
//
// FLAT, NOT HUBBED — deliberately different from the admin shell. The admin sidebar collapses a
// module into one hub button and makes you open a card grid to reach the page you wanted. With ~30
// pages across 8 sections and collapsible headings, every HR page is ONE click from anywhere. The
// hub pages themselves still exist and still work under /hr/… if a link lands on one; they are just
// not the way through.
//
// Every row still carries its real `permissions`, so this list can only ever NARROW what the
// matrix allows — it can never widen it. A row whose grant a seat lacks simply does not render.
const hrNavigationSectionSeeds = [
  {
    id: "hr-overview",
    items: [
      // The seat's landing page, and deliberately FIRST — `resolveLandingPathForRole` sends both
      // HR roles here on sign-in, so the sidebar's first row is the page they are already on.
      //
      // NO `permissions` entry, and that is not an oversight. The page is composed from the
      // viewer's own function bundle, so the only people it can render for are the two roles this
      // whole catalogue serves; its gate is `hrBundleForRole`, the same lookup that decides their
      // permissions. A permission here would be a second, weaker statement of that — and the kind
      // that drifts (see the Deductions note under Payroll, where a row's grant and its page's
      // real gate disagreed, so the link rendered and the page refused it).
      //
      // ONE row, not two. "My Workspace" sat here until 2026-09-01, when the owner asked for the
      // two overviews merged: "make the overview dashboard merged between HR overview and my
      // workspace into one landing overview page." Her leave balance, excuse allowance, attendance
      // and her own excuse requests are now the "My Record" section of the page below, and
      // /hr/workspace redirects here rather than 404ing. Every personal PAGE underneath it
      // (payslips, excuses, vacation request…) is still reachable — from that section, and from
      // the My Requests rows at the bottom of this catalogue.
      { href: "/hr/admin/hr-command-center", icon: Gauge, label: "Overview" },
    ],
    label: "Overview",
  },
  {
    id: "hr-people",
    items: [
      // Gated on `read` since 2026-09-01. It was `update` because EmployeeManagement took no
      // capability props and rendered the full editing UI unconditionally, so offering the row to a
      // reader meant offering Save buttons the API refuses. That component now takes `canEdit`, the
      // page passes the real employees:update answer into it, and POST /api/employees still asserts
      // update — so a reader gets the directory, the filters and the export, and no control that
      // could fail. This is what let the owner's instruction ("make Employee Directory appear in
      // her account") be honoured without handing her a write surface.
      { href: "/hr/employees", icon: UsersRound, label: "Employee Directory", permissions: [{ resource: "employees", action: "read" }] },
      { href: "/hr/employee-360", icon: IdCard, label: "Employee 360", permissions: [{ resource: "employee_profile", action: "read" }] },
      { href: "/hr/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      // Probation moved OUT of this section on 2026-09-01, down to its own "Probation" section,
      // where it sits beside the outcomes dashboard. It is one module and it was in two minds
      // here: People is who is on the payroll, probation is how a new joiner is performing.
      { href: "/hr/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
      { href: "/hr/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
      // The offboarding arc, in the order it actually happens: the departure is recorded, the
      // stations are cleared, the conversation is captured. Each row advertises the permission its
      // page really gates on - the Deductions note under Payroll is what happens when they drift.
      //
      // Only ONE of these two ever renders for a given seat, by design. Clearance is in
      // people_records (HR Operations); Retention is in engagement_retention (HR Advisory). The
      // sidebar does not enforce that - the route handler does - but the split is the reason a
      // reader of this file should not "helpfully" grant both to both.
      { href: "/hr/clearance", icon: ClipboardCheck, label: "Clearance", permissions: [{ resource: "clearance" }] },
      // Gated on `clearance` rather than a resource of its own: a leaver's mailbox IS the "IT &
      // System Access" station given a table, and a second offboarding grant is a second thing to
      // drift out of step with the first.
      { href: "/hr/mailbox-offboarding", icon: MailX, label: "Mailbox Revocation", permissions: [{ resource: "clearance" }] },
      { href: "/hr/retention", icon: HeartPulse, label: "Retention Register", permissions: [{ resource: "retention" }] },
      { href: "/hr/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
      { href: "/hr/admin/support-requests", icon: LifeBuoy, label: "HR Support Requests", permissions: [{ resource: "support_requests" }] },
    ],
    label: "People",
  },
  {
    id: "hr-recruitment",
    items: [
      { href: "/hr/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment" }] },
      // Added 2026-09-01. The page has always admitted both HR seats — its gate is
      // isHrAuthorityRole + recruitment:read — and had no row anywhere, so the district managers'
      // returned CVs sat in a queue nobody could navigate to.
      { href: "/hr/recruitment/returned-cvs", icon: Undo2, label: "Returned CVs", permissions: [{ resource: "recruitment" }] },
      { href: "/hr/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies" }] },
      { href: "/hr/offers", icon: MailCheck, label: "Job Offers", permissions: [{ resource: "offers" }] },
      { href: "/hr/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }] },
      { href: "/hr/hiring-pack", icon: FileSignature, label: "HR Forms", permissions: [{ resource: "employee_documents" }] },
      // NO "Missing Contact Details" (/hr/recruitment/contact-review) and NO "Inbound Intake
      // Health" (/hr/recruitment/intake-health) row. Both sat here until 2026-09-01, when the
      // owner cut them: "I think there are irrelevant modules... I don't want any crowd... remove
      // them from this sidebar." They are intake PLUMBING — one lists candidate records missing a
      // phone or an email, the other counts what the WhatsApp and mailbox importers ingested —
      // and neither is work an HR Business Partner is measured on. `recruitment` is HER grant
      // alone (HR Operations holds none of it), so these two rendered for exactly one seat and
      // deleting the lines takes nothing from anybody else. Both PAGES stay live and gated as they
      // were — it is the rail that is quieter. Do not re-add them "for completeness": the
      // crowding IS the defect he named.
      { href: "/hr/recruitment/whatsapp-replies", icon: MessageSquareText, label: "WhatsApp Replies", permissions: [{ resource: "recruitment" }] },
      // Added 2026-09-01. The page was `admin:update` — Super Admin alone — and was re-gated to
      // `recruitment:update` rather than the resource being widened, because `admin:update` also
      // opens module locks, scope visibility, salary flags and a notification TEST-SEND endpoint.
      // See assertScreeningQuestionsAccess in whatsapp-screening-questions-admin.ts.
      { href: "/hr/admin/screening-questions", icon: ListChecks, label: "Screening Questions", permissions: [{ resource: "recruitment", action: "update" }] },
      // Added 2026-09-01. The audience is a ROLE SET, not a permission — canViewManagerCvEngagement
      // — so this row carries `roles` rather than a grant, and the two must be read together: the
      // owner amended that list the same day to add HR Advisory and nobody else in HR.
      { href: "/hr/recruitment/manager-engagement", icon: Radar, label: "Manager Engagement", permissions: [{ resource: "recruitment" }], roles: ["HR Advisory"] },
    ],
    label: "Recruitment",
  },
  {
    id: "hr-attendance",
    items: [
      // Kept for BOTH seats. Attendance is named in the HR Business Partner job description too —
      // "use HR data to identify turnover, vacancy, attendance, performance or engagement patterns
      // that need management attention" — so Advisory's attendance:read is correct and this row is
      // right. What was wrong was the destination: every data view inside the hub was CEO/Super
      // Admin only, so the hub listed 0 of 12 for her and 3 of 12 for Operations. Widened above.
      { href: "/hr/attendance", icon: Fingerprint, label: "Attendance", permissions: [{ resource: "attendance", action: "read" }] },
      // HR Operations only — the day-by-day org-wide record behind "identify unexplained absences,
      // missing punches or inconsistent records". Same findability problem as the Company Vacation
      // Report: it sits in peopleManagementPageItems, which this catalogue does not open.
      // "Activity Report" for symmetry with the Vacation Report row above, which had to drop
      // "Company" to fit the rail. This one fits either way (153px); matching them is a choice, so
      // that two rows added together do not read as two different naming conventions.
      { href: "/hr/admin/company-activity-report", icon: Activity, label: "Activity Report", permissions: [{ resource: "leave", action: "read" }], roles: ["HR Operations"] },
      { href: "/hr/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/hr/attendance/policies", icon: CalendarClock, label: "Attendance Policies", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/hr/hr-calendar", icon: CalendarDays, label: "Company Calendar", permissions: [{ resource: "hr_calendar" }] },
      // Added 2026-09-01. Gated on weekly_plans:read, which workforce_insight grants and
      // people_records deliberately does not — so this is HR Advisory's row alone, and correctly
      // absent for HR Operations, who has no reason to read a rep's call plan.
      { href: "/hr/admin/weekly-plans/calendar", icon: CalendarRange, label: "Planning Calendar", permissions: [{ resource: "weekly_plans", action: "read" }] },
    ],
    // Renamed from "Attendance" on 2026-09-01: with the Company Calendar visible to both seats and
    // the Planning Calendar added, two of the rows in here are calendars rather than attendance.
    label: "Attendance & Calendars",
  },
  {
    id: "hr-leave",
    items: [
      // excludedRoles: HR Advisory, 2026-08-29. Leave administration appears NOWHERE in the HR
      // Business Partner job description — it is HR Operations' second area ("Maintain leave
      // balances and ensure approved leave is correctly recorded"). Advisory holds leave:[read,
      // create] for her OWN requests, which the "Request Vacation" row under My Requests already
      // serves, so this row opened a hub that listed nothing she could enter: 0 of 3 children
      // visible. An always-empty hub reads as a broken page, not as "not for you".
      { href: "/hr/leave-management", icon: CalendarDays, label: "Leave Management", permissions: [{ resource: "leave", action: "read" }], excludedRoles: ["HR Advisory"] },
      { href: "/hr/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      // HR Operations only — the org-wide leave register. It lives in peopleManagementPageItems,
      // a hub this catalogue has no row for, so without this line the seat passes the gate
      // (companyVacationReportReaderRoles) and still cannot find the page.
      // Labelled "Vacation Report", not "Company Vacation Report" as the page's own hero reads:
      // the full name measures 158px against the admin rail's 157px budget, and the owner's rule is
      // no ellipsis and no wrap, so the label gives way rather than the rail. It loses nothing —
      // the row sits in the Leave section of an admin shell only HR Operations sees, where there is
      // no personal vacation report for it to be confused with.
      { href: "/hr/admin/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave", action: "read" }], roles: ["HR Operations"] },
      // excludedRoles: HR Advisory, 2026-09-01 — same shape as the Leave Management row above and
      // the same cause. The row is offered on `leave:read`, which Advisory holds only for HER OWN
      // vacation requests, while the page behind it shows exactly three modules: resignation,
      // contract renewal and outstation (leave/excuse/plan migrated out to their own dedicated
      // pages — see MIGRATED_DEEPLINK_BASES in app/(admin)/admin/approvals-hub/page.tsx).
      //
      // Her composed matrix holds NO grant for any of those three: resignations, contracts and
      // outstation are all ABSENT, not merely read-only. So the inbox could never contain one row
      // for her. Measured off the composed matrix rather than inferred from the job description,
      // because the JD would have suggested resignations were hers — the People section still
      // carries /hr/resignations and /hr/contracts rows, and those correctly do not render for her
      // for exactly this reason.
      //
      // HR Operations keeps the row: she holds resignations and contracts at read/create/update/
      // export, and leave administration is her second JD area.
      //
      // An always-empty inbox reads as a broken page rather than as "not for you" — and this one
      // also carries a pending-count badge, so it advertises work that can never become hers.
      { href: "/hr/admin/approvals-hub", icon: Inbox, label: "Other Approvals", permissions: [{ resource: "leave", action: "read" }], excludedRoles: ["HR Advisory"], navBadge: "approvals-hub-pending" },
    ],
    label: "Leave Management",
  },
  {
    id: "hr-payroll",
    items: [
      // excludedRoles: HR Advisory, 2026-08-29. Payroll appears NOWHERE in the HR Business Partner
      // job description, and her Role Boundaries bar her from salary changes outright; payroll
      // inputs and monthly closure are HR Operations' third area. Advisory reached this row through
      // payslips:read — the grant that shows her HER OWN payslip — and the hub then listed 0 of 7.
      // Her own payslip is unaffected: that is the employee-portal path, not this admin hub.
      { href: "/hr/admin/payroll-management", icon: FileSpreadsheet, label: "Payroll Management", permissions: [{ resource: "payroll" }, { resource: "payslips" }, { resource: "deductions", action: "read" }], excludedRoles: ["HR Advisory"] },
      // NO "Deductions" row here, deliberately. The legacy Deductions Governance page was retired in
      // the C6 cutover (2026-08-30); its unified replacement app/(admin)/admin/deductions/page.tsx
      // gates on a hard-coded `VIEW_ROLES = {Super Admin, CEO}` — a role set, not a permission — and
      // redirects everyone else to /employee-portals. This catalogue serves `hrNamespaceRoles`, the
      // two HR seats and nobody else, so the unified page admits none of its readers and a row here
      // could only ever be a dead link (offered on `deductions:read`, which HR Operations holds, then
      // refused by the page). Widening VIEW_ROLES is the owner's call — he set that boundary by role on
      // 2026-08-11, and hidden is not revoked. HR Operations still sees the deduction month as
      // read-only count tiles on her HR command center (payroll_inputs), drilling into Payroll
      // Management; the full review screen is Super Admin / CEO only.
      //
      // Payslips Center, added 2026-09-01 at the owner's instruction. It renders for BOTH seats and
      // shows each a different set of people: HR Operations company-wide (getPayrollScope), HR
      // Advisory the audience he named that day — "the district managers, the Medicare reps, and
      // herself only". That split lives in resolvePayslipCenterAudience, never here: a row is a
      // link, and what a viewer may see is the page's own answer. Offered on payslips:read, which
      // every HR seat holds through the self-service floor, so the row is honest for both.
      { href: "/hr/admin/payslips-center", icon: ReceiptText, label: "Payslips Center", permissions: [{ resource: "payslips", action: "read" }] },
    ],
    label: "Payroll",
  },
  // Probation and Performance are TWO sections, not one. They were merged into a single
  // "Performance & Probation" earlier on 2026-09-01; the owner split them again the same day —
  // "separate performance from probation" — and he is right that they are two jobs. Probation is a
  // dated gate with a pass/fail at the end of it; coaching is continuous and has no end. Note the
  // `performance_probation` FUNCTION in hr-functions.ts keeps its combined name: that is a grant
  // bundle, not a rail, and renaming it would move permissions rather than links.
  {
    id: "hr-probation",
    items: [
      // Moved here from People on 2026-09-01: the probation tracker and the outcomes dashboard read
      // the same cycle and belong side by side.
      { href: "/hr/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }] },
      // Added 2026-09-01. Its gate is canReadAllProbation, which already named both HR seats — so
      // like Returned CVs this page admitted them all along and simply had no row.
      { href: "/hr/probation/dashboard", icon: LayoutDashboard, label: "Probation Dashboard", permissions: [{ resource: "probation" }] },
    ],
    label: "Probation",
  },
  {
    id: "hr-performance",
    items: [
      // The coaching grant is real and JD-traced (performance follow-up), so the page is listed
      // rather than left reachable-but-hidden.
      { href: "/hr/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      // Coaching Analytics, added 2026-09-01. It was deliberately left out as "the SFE Manager's
      // sales-management surface"; the owner overrode that the same day. No grant changed — the
      // page gates on coaching:read, which performance_probation has always given both seats.
      { href: "/hr/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
      // NO "Workforce Compliance" (/hr/admin/field-workforce-compliance) row, for EITHER HR seat.
      // "I told you to remove the workforce compliance. Remove it." (2026-09-01). It was first
      // cut from HR Advisory alone, by excludedRoles rather than deletion, because the row gates
      // on hr_calendar:read and BOTH seats hold that grant — so deleting it would have taken it
      // from HR Operations too, which had not been asked for. He was asked directly and answered
      // "yes remove it", so the line is gone rather than narrowed.
      //
      // The PAGE is untouched and still reachable for every role that gates into it from the
      // ADMIN catalogue (adminNavigationSectionSeeds carries its own row, excluding SFE Manager).
      // What is gone is the /hr rail entry — field-force compliance is sales-management work, not
      // an HR seat's.
    ],
    label: "Performance",
  },
  {
    id: "hr-self",
    items: [
      { href: "/hr/workspace/leave-management/vacation-request", icon: CalendarCheck, label: "Request Vacation", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/hr/workspace/excuses", icon: CalendarClock, label: "Submit Excuse" },
      { href: "/hr/admin/report-it/new", icon: ShieldAlert, label: "Report It" },
    ],
    label: "My Requests",
  },
] as const satisfies readonly NavigationSectionSeed[];

export const adminNavigationSections: readonly NavigationSection[] = adminNavigationSectionSeeds;
export const employeePortalNavigationSections: readonly NavigationSection[] = employeePortalNavigationSectionSeeds;
export const hrNavigationSections: readonly NavigationSection[] = hrNavigationSectionSeeds;

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  if (mode === "employee-portal") return employeePortalNavigationSections;
  if (mode === "hr") return hrNavigationSections;
  return adminNavigationSections;
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
    // HR Operations added 2026-08-29 (owner). "Maintain leave balances and ensure approved leave is
    // correctly recorded" is her job description's own sentence for this page.
    roles: ["Super Admin", "CEO", "HR Operations"],
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

// ── Finance Leave Management hub (app/(admin)/admin/finance-leave-management/page.tsx) ──────────
// Finance-Manager-only (owner instruction, 2026-08-10). Consolidates the exact same destinations
// his "My Requests" and "Approvals Hub" rows used to point at directly — see
// excludedRoles: ["Finance Manager"] on those four rows in adminNavigationSectionSeeds above —
// into one page, split into "Vacations" and "Excuses". Every item below is deliberately
// roles: ["Finance Manager"]: unlike the shared hubs elsewhere in this file, this hub has exactly
// one audience.
export const financeLeaveManagementVacationItems: readonly AdminToolsPageItem[] = [
  {
    href: "/workspace/leave-management/vacation-request",
    icon: CalendarCheck,
    label: "Request Vacation",
    description: "Submit your own vacation request.",
    permissions: [{ resource: "leave", action: "create" }],
    roles: ["Finance Manager"],
  },
  {
    href: "/admin/approvals/vacation",
    icon: ClipboardCheck,
    label: "Vacation Approvals",
    description: "Vacation requests waiting on your response, and your response history.",
    permissions: [{ resource: "leave", action: "read" }],
    roles: ["Finance Manager"],
  },
  {
    href: "/leave-management/vacation-report",
    icon: FileSpreadsheet,
    label: "Vacation Report",
    description: "Vacation balances and history for your visible scope.",
    permissions: [{ resource: "leave" }],
    roles: ["Finance Manager"],
  },
] as const satisfies readonly AdminToolsPageItem[];

export const financeLeaveManagementExcuseItems: readonly AdminToolsPageItem[] = [
  {
    href: "/workspace/excuses",
    icon: CalendarClock,
    label: "Submit Excuse",
    description: "Submit your own excuse request.",
    roles: ["Finance Manager"],
  },
  {
    href: "/admin/approvals/excuse",
    icon: Clock,
    label: "Excuse Approvals",
    description: "Excuse requests waiting on your response, and your response history.",
    permissions: [{ resource: "leave", action: "read" }],
    roles: ["Finance Manager"],
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
    // Finance Manager excluded 2026-08-11 (owner). His `sales` grant satisfies the bare
    // { resource: "sales" } permission here, so the card was visible to him — and because this is a
    // hub CARD rather than a sidebar row, hiding a parent hub would not have removed it:
    // hubPageItemGroups folds every card a viewer's role allows straight back into Cmd+K. Naming
    // him in excludedRoles is the only gate that actually closes it, the same lesson "Archived ROI
    // Tracking" cost two attempts to learn.
    //
    // He keeps Monthly Closing itself — the export-only surface added in this same change. What
    // goes is the achievement DASHBOARD, which reads sales performance against target; that is
    // sales-management reporting, not a finance duty.
    excludedRoles: ["CEO", "Marketing Manager", "Finance Manager"],
  },
  {
    href: "/sales/monthly-closing",
    icon: ChartColumnBig,
    label: "Monthly Closing",
    description: "Enter and manage monthly closing sales data.",
    // Super Admin gets the full upload/publish workspace; SFE Manager reaches the same page but
    // view + download only, never publish (owner decision, 2026-08-05) -- see the page's own
    // canPublish gate. No excludedRoles here on purpose: both roles must see this card.
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/monthly-closing/performance-review",
    icon: Trophy,
    label: "Performance Review",
    description: "Rep ranking, families, and growth by product and by area, as a Sato workbook.",
    // The presentation cut of the SAME closing -- it reads, ranks and exports, and publishes
    // nothing. Its page gate is Monthly Closing's, SFE Manager carve-out included, so no
    // excludedRoles here for the same reason: both roles must see this card.
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/closing-corrections",
    icon: Undo2,
    label: "Closing Corrections",
    description: "Reversals, oversized returns, and late returns that make a month read wrong.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above — SFE Manager sees
    // this card via sales:import but always gets redirected to his own overview.
    excludedRoles: ["SFE Manager"],
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
    // Mapping surface — excluded for the SFE Manager on owner instruction (2026-08-02):
    // he consumes Source of Sales, he does not maintain its mapping tables.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/database-mapping",
    icon: Database,
    label: "Master Database",
    description: "Manage master sales reference database.",
    // Mapping surface — excluded for the SFE Manager on owner instruction (2026-08-02):
    // he consumes Source of Sales, he does not maintain its mapping tables.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    // Folded in from the retired `sales-territory-management` rail block when ruling 1 capped Sales
    // at five. It belongs here on the merits, not merely for want of a slot: Territory Management IS
    // the Source of Sales geography, and every SoS sale — historical and future — attributes to
    // today's geography, so the map and the numbers are one subject.
    //
    // Gate carried over VERBATIM from the rail row, deliberately. District / Regional / National
    // Sales Managers land in the employee-portal shell (resolveNavigationMode) and their entry point
    // is /employee-portals/territory-management, so naming only the admin-shell roles keeps this
    // card from being offered to someone who would be redirected straight past it. It is `sales`
    // read, NOT `sales:import` like the mapping cards around it — this is a narrower gate than its
    // neighbours, which is correct and must not be "tidied" into line with them.
    href: "/sales/territory-management",
    icon: Waypoints,
    label: "Territory Management",
    description: "Bricks, areas and territory coverage.",
    permissions: [{ resource: "sales" }],
    roles: ["CEO", "SFE Manager", "Super Admin"],
  },
  {
    href: "/sales/distributor-profiles",
    icon: Tags,
    label: "Distributor Profiles",
    description: "Manage distributor profile records.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/missing-data",
    icon: TriangleAlert,
    label: "Missing Data",
    description: "Review sales rows with missing or unresolved data.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/normalizer",
    icon: Sparkles,
    label: "SoS Magic",
    description: "AI-assisted sales data normalization.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/diagnostics",
    icon: Stethoscope,
    label: "Sales Diagnostics",
    description: "Diagnose Source of Sales pipeline issues.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/truth-check",
    icon: ShieldCheck,
    label: "Sales Truth Check",
    description: "Prove every sales report agrees with Monthly Closing, area by area.",
    // Same Super-Admin/system-scope-only boundary as Monthly Closing above. It prints whole-company
    // per-area sales for every line, so it is gated exactly like the closing itself.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "read", resource: "sales" }],
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Sales Analytics cards — RETIRED, DELIBERATELY UNWIRED ──────────────────────────
// ⚠️ This array is NOT referenced by hubPageItemGroups any more and NOTHING reads it.
//
// Ruling 11 ("no analytics module, no sales analytics", said three times) removed the module from
// navigation. It is kept rather than deleted for one reason: it is the only record of who was
// allowed to reach each dashboard, and re-deriving those five role lists from scratch if the owner
// ever reverses the ruling would be guesswork. Re-wiring is one line in hubPageItemGroups.
//
// It is NOT a source of truth for anything today. The cards a user actually sees on
// app/(admin)/admin/analytics/page.tsx come from that page's own MODULES array — the two lists were
// always separate and have to move together, which is the trap the note below was written about.
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
    // Finance Manager added 2026-08-10 (owner) — command-palette parity with the hub tile. The two
    // lists are separate (this one feeds Cmd+K, app/(admin)/admin/analytics/page.tsx feeds the hub
    // cards), so they must move together or the module is reachable from one and not the other.
    roles: ["Super Admin", "CEO", "SFE Manager", "Finance Manager"],
  },
  {
    href: "/admin/analytics/monthly-closing",
    icon: CalendarRange,
    label: "Closing Analytics",
    description: "Monthly closing analytics dashboard.",
    permissions: [{ resource: "sales" }],
    // Finance Manager added 2026-08-10 (owner). Weekly Analytics below is deliberately NOT widened:
    // it gates on weekly_sales, which he does not hold, so offering it would be a guaranteed 403.
    roles: ["Super Admin", "CEO", "SFE Manager", "Finance Manager"],
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
  {
    href: "/admin/master-data/area-consolidation",
    icon: Shuffle,
    label: "Area Consolidation",
    description: "Move everything off a legacy area onto the area it actually means — you read the list, you press the button.",
    // Owner, 2026-08-22: Super Admin only. This moves employees and teams between territories in
    // bulk; it is the most sensitive button in Master Data and nobody else gets it.
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

export const adminToolsPageItems: readonly AdminToolsPageItem[] = [
  // Where Modules Control used to sit, which is where it will be looked for — but it is the
  // opposite kind of tool. Modules Control decided what OTHER people saw; this edits only the
  // sidebar of whoever opens it. Super Admin only for now, matching the owner's framing ("I mean
  // in my own account"); the route itself is per-caller, so widening this row later is a one-line
  // change that grants nothing new.
  {
    href: "/admin/sidebar-layout",
    icon: LayoutGrid,
    label: "Navigation Layout",
    description: "Put any page in the row above the page title, the row below it, the top strip, or any module. Changes your own navigation only.",
    roles: ["Super Admin"],
  },
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
  // "Cron Control" (/admin/cron-control) stood here until 2026-08-30. It drove the GCP Cloud
  // Scheduler, which died with GCP billing on 2026-08-01, so the card opened a permanent error
  // box and could not see cron-job.org — the scheduler that actually runs production. The card
  // now names the live editor that shared that page and outlived it.
  {
    href: "/admin/notification-recipients",
    icon: BellRing,
    label: "Notification Recipients",
    description: "Choose which roles are told about each system notification, and silence or retarget an alert.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/email-control-center",
    icon: SlidersHorizontal,
    label: "Email Control Center",
    description: "Every automated email in one place: turn any one off, or fine-tune exactly which roles receive it. Viewing is Super Admin + CEO; changes are Super Admin only.",
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/mailbox-monitor",
    icon: ShieldCheck,
    label: "Mailbox Compliance Monitor",
    description: "Read company mailboxes over a read-only connection for compliance oversight. Opening a message never marks it read for the owner. Super Admin only.",
    permissions: [{ resource: "mailbox_monitor", action: "read" }],
    roles: ["Super Admin"],
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
    href: "/admin/module-locks",
    icon: Lock,
    label: "Temporary Module Locks",
    description: "Temporarily close a module on one account, and release it again.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/screening-questions",
    icon: ListChecks,
    label: "WhatsApp Screening Questions",
    description: "Add, reorder or retire the extra questions the CV-intake bot asks after the fixed six.",
    roles: ["Super Admin", "HR Advisory"],
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
    // Mapping surface — excluded for the SFE Manager on owner instruction (2026-08-02):
    // he consumes Source of Sales, he does not maintain its mapping tables.
    excludedRoles: ["SFE Manager"],
    permissions: [{ action: "update", resource: "weekly_sales" }],
  },
  {
    href: "/sales/weekly/distributor-editor",
    icon: Columns3,
    label: "Weekly Distributor Column Editor",
    description: "Edit distributor column layouts used during weekly import.",
    // Super-Admin/system-scope-only workspace (app/(admin)/sales/weekly/distributor-editor/page.tsx)
    // — SFE Manager holds weekly_sales:import broadly but has no route into this one.
    excludedRoles: ["SFE Manager"],
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
    href: "/admin/pharmacy-search",
    icon: Search,
    label: "Pharmacy Search",
    description: "One box: find any pharmacy by name, code or distributor, and see its brick, area, region and the doctors around it.",
    // Same gate as Customer Directory (owner decision, 2026-08-21) -- it reads the same customer
    // estate, so it inherits that bar rather than introducing a permission of its own.
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/customer-directory",
    icon: UsersRound,
    label: "Customer Directory",
    description: "Browse and filter every customer across all distributors.",
    // Super Admin and SFE Manager both reach this page (owner decision, 2026-08-05) -- see the
    // page's own role gate. No excludedRoles here on purpose.
    permissions: [{ action: "import", resource: "sales" }],
  },
  {
    href: "/sales/customer-mapping",
    icon: MapPinned,
    label: "Customer Mapping",
    description: "Map raw distributor customer records to canonical customer/brick codes.",
    // Mapping surface — excluded for the SFE Manager on owner instruction (2026-08-02):
    // he consumes Source of Sales, he does not maintain its mapping tables.
    excludedRoles: ["SFE Manager"],
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
    roles: ["SFE Manager", "Super Admin"],
  },
  {
    href: "/admin/marketing-requests/validated-customers",
    icon: ClipboardCheck,
    label: "Validated Customers",
    description: "Validated marketing customers by employee — check the data, then hand one to Direct Orders.",
    // Owner, 2026-08-22: "Only super admin." Narrower than the Customer Database row above on
    // purpose — this one carries the button that writes a pharmacy into Direct Orders.
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
    // HR Operations added 2026-08-29 (owner). Her job description's second area opens "Review
    // attendance records, FINGERPRINT INPUTS, approved leave, permissions, excuses" — this is that
    // screen. Note the page already admitted her: canAccessFingerprintReport is CEO or
    // employees:read, which she holds, so this row was hiding a page she could already open by
    // typing the address. Hidden is not revoked, and a surface that is reachable but unfindable is
    // the worse of the two states.
    roles: ["CEO", "Super Admin", "HR Operations"],
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
    // HR Operations added 2026-08-29 (owner) — "Prepare clean, supported monthly attendance
    // outputs" is her job description's own phrase for this page. Same story as Fingerprint Report
    // above: app/(admin)/attendance/monthly-summary/page.tsx gates on employees:read and nothing
    // else, so she could already reach it and only the sidebar disagreed.
    //
    // HR Advisory added at the same time, and this row is the ONLY attendance destination she gets.
    // Her job description names attendance exactly once, as insight rather than administration —
    // "use HR data to identify turnover, vacancy, attendance, performance or engagement patterns
    // that need management attention" — which is the monthly aggregate, not raw punches and not
    // policy setup. Without it her Attendance sidebar row opened a hub listing 0 of 12 items, and a
    // permanently empty hub reads to its owner as a broken page rather than as a boundary. The page
    // admits her already (employees:read, which she holds); nothing about its gate changes here.
    //
    // CEO removed 2026-08-29: a name that never rendered a row. This page gates on employees:read
    // and nothing else — unlike Fingerprint Report above, there is no CEO branch — and `employees`
    // is a HARD BOUNDARY that returns [] for CEO (permissions.ts hardBoundaryAllowedActions), so
    // the name was ANDed against a permission he cannot hold. Deleting it changes what no user has
    // ever seen. And it cannot be repaired by granting instead: tests/ceo-account-contract.test.ts
    // pins `isRolePermissionWithinHardBoundary("CEO", "employees", "read") === false` — "CEO must
    // not be grantable employees:read by role overrides" — in the required CI validate job. Giving
    // the CEO this page means moving that boundary and re-pinning that contract, which is an owner
    // decision about segregation of duties, not a navigation fix.
    roles: ["Super Admin", "HR Operations", "HR Advisory"],
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
    roles: ["CEO", "Super Admin", "HR Advisory"],
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
    // HR Operations added 2026-08-29 (owner). Official holidays are an input to every attendance
    // and leave figure she is responsible for, so she cannot reconcile a month without seeing the
    // calendar it was measured against. The page gates on canAccessAttendanceSetup, which is just
    // canAccess(employees, …) — she already passed it; only this row disagreed.
    roles: [...systemAdministratorNavigationRoles, "HR Operations"],
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
    // HR Operations added 2026-08-29 (owner), with her COMPANY payroll scope. Her job description's
    // third area is "Payroll HR Inputs & Monthly Closure", and this seat was composed with
    // payroll:[read, export] from the start — getPayrollScope was the only thing refusing her, so
    // those grants were decorative until now. Read and export; no payroll write action is granted.
    roles: [...companyPayrollNavigationRoles, "HR Operations"],
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
    // HR Operations added 2026-08-29 (owner). This is the widest surface the company-scope ruling
    // opens: every employee's payslip, the CEO's included. She was composed with
    // payslips:[read, export] when the seat was built and getPayrollScope was the only thing
    // refusing her, so the grant existed and did nothing — but "already granted" is a reason to
    // raise this, not a reason to treat it as settled. Read and export only: generating, editing
    // and publishing a payslip are separate matrix actions this seat does not hold, and the page
    // itself still asks for each. If that is wider than intended, take HR Operations out of this
    // one row — it is independent of the other three payroll rows and of the scope change.
    roles: ["Super Admin", "CEO", "HR Operations"],
  },
  {
    href: "/admin/deductions",
    icon: ReceiptText,
    label: "Deductions",
    description: "Unified source of truth for every payroll deduction — compute, decide, and (once published) feed Automated Payroll and the employee portal.",
    permissions: [{ resource: "deductions", action: "read" }],
    // Finance Manager excluded 2026-08-10 (owner). deductions:read is what admitted him and it has to
    // stay — it feeds payroll surfaces he keeps — so the card goes by name, on the hub AND in the
    // command palette. hubPageItemGroups folds every hub card the viewer's role admits back into Cmd+K
    // regardless of the parent hub row, so hiding /admin/payroll-management from his sidebar alone
    // would not have hidden this card. (This was previously worded "same reasoning as Deductions
    // Governance above"; that legacy card was retired in the C6 cutover, 2026-08-30.)
    //
    // HR Operations excluded 2026-08-29, for the same reason and by the same mechanism. Her seat holds
    // deductions:read — the grant behind the read-only deduction count tiles on her HR command center —
    // so this card admitted her, but app/(admin)/admin/deductions/page.tsx gates on a hard-coded role
    // set of {Super Admin, CEO} and redirects everyone else to /employee-portals. It would be a dead
    // link for her. Excluded by NAME rather than by widening VIEW_ROLES: that boundary is the owner's,
    // set by role on 2026-08-11, and hidden is not revoked — the page refuses her either way.
    excludedRoles: ["Finance Manager", "HR Operations"],
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
    // Finance Manager removed 2026-08-10 (owner), completing the trim that took "Marketing & ROI"
    // and "ROI Tracker" off his sidebar earlier the same day. This card was the survivor: it has no
    // sidebar row of its own, so hiding the parent hub did nothing — hubPageItemGroups folds every
    // card the viewer's role admits straight back into the Cmd+K palette, which left "Archived ROI
    // Tracking" one keystroke away under a heading he was supposed to have lost.
    //
    // He keeps the live marketing rung he actually executes (`finance_execution`, via Marketing
    // Inbox). What goes is read-only historical Excel data that was never his to report on.
    // assertMarketingAdminPageAccess({ allowCompanyOversight: true }) still admits him by URL — this
    // is a navigation decision, not a revocation, matching how ROI Tracker was handled.
    roles: ["Super Admin", "CEO", "SFE Manager", "Financial Advisor"],
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
    //
    // Finance Manager removed 2026-08-10 alongside the sidebar row, and it must stay removed for
    // the removal to mean anything: command-palette.tsx folds every hub card the viewer's role
    // admits back into Cmd+K, so this card alone would have kept "ROI Tracker" one keystroke away
    // under a "Marketing & ROI" heading. The page guard still admits him by URL.
    roles: [
      "Super Admin",
      "CEO",
      "SFE Manager",
      "Marketing Manager",
      "Product Manager",
      "Group Product Manager",
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
    // Folded in from its own sidebar row (2026-08-02). Roles and permission mirror that row
    // exactly, so the move changes who can reach it by nothing.
    href: "/admin/pm-products",
    icon: Package,
    label: "PM Product Master",
    description: "Product-manager product master — which products each PM owns, the basis for ROI attribution.",
    permissions: [{ resource: "employee_profile", action: "read" }],
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
    roles: ["Super Admin", "CEO", "SFE Manager"],
  },
  {
    href: "/admin/marketing-requests/validation",
    icon: ShieldCheck,
    label: "Customer Validation",
    description: "Validate customer/pharmacy records tied to marketing requests.",
    // SFE Manager added 2026-08-02: he validates in marketing requests. This widens nothing —
    // assertMarketingAdminPageAccess has always admitted him to the workflow pages; only this
    // card excluded him, so the page worked while the sidebar pretended it did not exist.
    roles: ["District Manager", "Super Admin", "SFE Manager"],
  },
  {
    href: "/admin/marketing-requests",
    icon: Megaphone,
    label: "Marketing Requests",
    description: "Submit and manage marketing requests.",
    // Same nav-vs-gate drift as Customer Validation above: assertMarketingAdminPageAccess
    // admits the SFE Manager to the workflow pages, this card did not.
    roles: ["District Manager", "Super Admin", "SFE Manager"],
  },
  // Approval Inbox is NOT a card here, and that is deliberate twice over. It moved to its own
  // sidebar tab on 2026-08-02 because an inbox has to be visible at a glance with its pending
  // badge rather than one click inside a hub of reports, and a hub card cannot carry that badge.
  // The 2026-08-30 collapse left it on the rail for the same reason, and because the owner's own
  // ruling 10 keeps approvals on layer 1. Same for /workspace/marketing-requests, which he
  // instructed be re-opened on the rail that very morning.
  {
    // Moved here from its own sidebar row by the 2026-08-30 collapse. The two roles are the row's
    // verbatim, and both can open this hub, so neither lost the route. The page itself admits the
    // wider marketingAdminWorkflowRoles set (Marketing Manager, Product Manager and Group Product
    // Manager too) — they are left off this card because they cannot open the hub at all and reach
    // the same register through the portal, exactly as the row's own note said.
    href: "/admin/marketing-requests/all",
    icon: ClipboardList,
    label: "All Marketing Requests",
    description: "Every marketing request on the system, and where each one is stopped.",
    roles: ["Super Admin", "SFE Manager"],
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
    href: "/hiring-pack",
    icon: FileSignature,
    label: "HR Forms",
    description: "Fill, print and record the contract, Form 1, Form 6 and the two exit forms.",
    permissions: [{ resource: "employee_documents" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/offers",
    icon: MailCheck,
    label: "Job Offers",
    description: "Compose, design and send official offers of employment as Sato Pharmaceuticals.",
    permissions: [{ resource: "offers" }],
    roles: hrAuthorityNavigationRoles,
  },
  // Removed 2026-08-15 on the owner's ruling: CV Review Queue, CV Extraction Accuracy and CV Field
  // Settings. Measured against production before cutting — the review queue had been opened for 5
  // of 194 extracted CVs, the accuracy dashboard computed its whole number from those same 5
  // reviews, and no field setting had ever been changed. They made the module look complicated
  // without ever changing an outcome. The flow is: receive the CV, let the AI read it, push the
  // candidate to the hiring manager.
  //
  // Like every other Talent-Acquisition-gated tool on this hub, each surviving card needs a portal
  // twin: a page under app/employee-portals/, an entry in employeePortalNavigationSections, an
  // entry in employee-portal-layout.tsx, and an entry in PORTAL_TWIN_BY_HUB_HREF in
  // tests/recruitment-hub-portal-coverage.test.ts. That is not ceremony — the (admin) group
  // redirects portal-shell roles away before any page in it renders, so without the twin she gets a
  // card that cannot open. The test holds a TOTAL map for exactly that reason and fails CI if the
  // pairing is ever broken.
  {
    href: "/recruitment/intake-health",
    icon: HeartPulse,
    label: "Inbound Intake Health",
    description: "WhatsApp + email CV intake funnel, capture rate, and any dead-lettered CVs to retry.",
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
  {
    href: "/recruitment/contact-review",
    icon: IdCard,
    label: "Missing Contact Details",
    description: "Candidates nobody can reach, and the email or phone their own CV already gave us.",
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
  // The record of what the automated recruitment line SAID to each applicant. Added 2026-08-30,
  // when "show me the reply that went out" turned out to be answerable only by reading the source
  // commit that was live at the time. Read-only: it carries no action, because an audit trail with
  // an edit button is a weaker one.
  {
    href: "/recruitment/whatsapp-replies",
    icon: MessageSquareText,
    label: "WhatsApp Replies",
    description: "The exact words the recruitment line sent each applicant, and whether they reached WhatsApp.",
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
    // HR Operations added alongside the Super Admin: she holds employees create/update/import, and
    // nine responsibilities of her job description are carried out on this screen. HR Advisory is
    // deliberately NOT here - she is read/export only, and the page ships an editing UI that takes
    // no capability props, so admitting her would show Save buttons the API refuses.
    //
    // This entry is load-bearing in a way that is easy to miss and was briefly reverted on
    // 2026-08-29 because of it. She is offered no People Management hub ROW, so nothing renders
    // this card for her and it looks like dead weight. But tests/hr-url-namespace.test.ts derives
    // each seat's admin closure from these lists and requires every /hr row to point INSIDE it -
    // the namespace may narrow the matrix, never widen it. Take her off this card and her
    // /hr/employees row becomes a page "neither seat's permissions admit", i.e. the HR namespace
    // inventing access rather than mirroring it. The card is the grant; the /hr row is the mirror.
    roles: ["Super Admin", "HR Operations"],
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
    // Finance Manager excluded 2026-08-10 (owner) — he reaches this page through his OWN sidebar
    // row (the finance-resignations section) instead. Without this exclusion the card would ALSO
    // fold into his Cmd+K palette under a "People Management" heading, because hubPageItemGroups
    // re-admits every card a viewer's role allows regardless of whether the parent hub row is
    // hidden. That heading is one he was deliberately removed from, and this is the exact mechanism
    // that kept "Archived ROI Tracking" and "/admin/deductions" one keystroke away after their hubs
    // were hidden.
    excludedRoles: ["Finance Manager"],
  },
  {
    href: "/clearance",
    icon: ClipboardCheck,
    label: "Clearance & Offboarding",
    description: "Every station a leaver has to clear, and the final settlement release.",
    permissions: [{ resource: "clearance" }],
  },
  {
    href: "/mailbox-offboarding",
    icon: MailX,
    label: "Mailbox Revocation",
    description: "Every leaver still holding a company mailbox, and what has been done about it.",
    permissions: [{ resource: "clearance" }],
  },
  {
    href: "/retention",
    icon: HeartPulse,
    label: "Retention Register",
    description: "Stay discussions and exit interviews, summarised into themes.",
    permissions: [{ resource: "retention" }],
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
    // HR Operations added 2026-08-29 (owner) — see companyVacationReportReaderRoles, which is the
    // gate the page itself asserts. She reads and exports; turning a CRM Signal row into a real
    // balance-deducting request stays Super Admin only at the page and at the approve route.
    //
    // She never SEES this card — she is offered no People Management hub row, and reaches the
    // report by her own /hr/admin/vacation-report sidebar row. It is still required: this list is
    // the admin closure tests/hr-url-namespace.test.ts derives, and a /hr row pointing outside that
    // closure is a widening by the namespace rather than a mirror of an existing grant.
    roles: ["Super Admin", "HR Operations"],
  },
  {
    href: "/admin/company-activity-report",
    icon: Activity,
    label: "Company Activity Report",
    description: "Day-by-day CRM visits, office attendance, and leave for any employee slice and date range — not a payroll report.",
    permissions: [{ resource: "leave" }],
    // HR Operations added 2026-08-29 (owner) — see companyActivityReportReaderRoles. This is the
    // report behind "identify unexplained absences, missing punches or inconsistent records". It
    // has no write path, so this is read-only by construction.
    //
    // As with the Vacation Report card above, she never sees this card — it is required because
    // tests/hr-url-namespace.test.ts derives her admin closure from these lists, and her
    // /hr/admin/company-activity-report row must point inside it. tests/company-activity-report.ts
    // pins this list, so it moves deliberately or not at all.
    roles: ["Super Admin", "HR Operations"],
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
    href: "/admin/outstation/expense-approvals",
    icon: ClipboardCheck,
    label: "Expense Approvals",
    description: "Review and approve outstation expenses against real CRM field activity.",
    permissions: [{ resource: "expenses" }],
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/admin/outstation/expense-command",
    icon: Radar,
    label: "Expense Command Center",
    description: "Outstation expense command center — overview of activity and queues.",
    permissions: [{ resource: "outstation", action: "read" }],
    // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
    // The `outstation` key is gone from his matrix as well, so the permission gate closes this card
    // independently — both are listed because a future role list edit must not silently reopen it.
    roles: ["Super Admin", "CEO"],
  },
  {
    href: "/admin/outstation/expense-command?tab=queue",
    icon: MapPinned,
    label: "Expense Requests",
    description: "Review and approve pending outstation expense requests.",
    permissions: [{ resource: "outstation", action: "approve" }],
    // Finance Manager removed 2026-08-10 (owner). He never actually saw this card — he held
    // outstation read/export/update but never `approve`, and items need permission AND role — so
    // the role list had been claiming an authority the gate denied. Both are now consistent:
    // outstation approval is the HR Manager's, per executionOnlyOutstationRoles.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/outstation/expense-command?tab=queue&action=create-manager-expense",
    icon: PlusCircle,
    label: "Add Manual Expense",
    description: "Manually add an outstation expense on behalf of an employee.",
    permissions: [{ resource: "outstation", action: "approve" }],
    // Finance Manager removed 2026-08-10 (owner), same reason as the queue card above: he never
    // held `outstation:approve`, so this card was already dark for him.
    roles: ["Super Admin"],
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
    // Finance Manager dropped 2026-08-10 (owner) — first from this card alone, then from the whole
    // module later the same day ("exclude him 100% from outstation or expenses"). The `outstation`
    // key no longer exists in his matrix, so nothing on this hub reaches him by any route.
    roles: ["Super Admin"],
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
  // Double Visit Analytics moved to the CRM hub (2026-08-02) — see crmPageItems. It is CRM visit
  // data, and listing it in both hubs would put one module in two places.
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
// ── Probation hub (app/(admin)/admin/probation-tools/page.tsx) ─────────────────
// Every probation surface behind one sidebar button. Each card keeps the role list its own page
// gate uses — canReadAllProbation for dashboard/analytics, isProbationAdministrator for settings —
// so collapsing the rows changes who can reach what by nothing.
export const probationPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/probation",
    icon: Hourglass,
    label: "Probation Cases",
    description: "The probation case list: assessments, evidence and decisions per employee.",
    permissions: [{ resource: "probation" }],
    excludedRoles: ["Marketing Manager", "CEO"],
  },
  {
    href: "/probation/dashboard",
    icon: LayoutDashboard,
    label: "Probation Dashboard",
    description: "Company-wide decision dashboard — who is due, overdue, and where each case stands.",
    permissions: [{ resource: "probation", action: "read" }],
    roles: ["Super Admin", "Training Manager", "Marketing Manager", "SFE Manager", "HR Advisory"],
  },
  {
    href: "/probation/analytics",
    icon: Activity,
    label: "Probation Analytics",
    description: "Outcome and scoring analytics across probation cases.",
    permissions: [{ resource: "probation", action: "read" }],
    roles: ["Super Admin", "Training Manager", "Marketing Manager", "SFE Manager"],
  },
  {
    href: "/admin/probation-settings",
    icon: Settings2,
    label: "Probation Settings",
    description: "Configure probation scoring weights, windows and evaluator roles.",
    permissions: [{ resource: "probation", action: "update" }],
    roles: ["Super Admin"],
  },
] as const satisfies readonly AdminToolsPageItem[];

export const crmPageItems: readonly AdminToolsPageItem[] = [
  {
    href: "/admin/crm",
    icon: Database,
    label: "CRM Workspace",
    description: "Sync health, the raw visit/check-in master, unmapped-identity resolution and recovered chains.",
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // Cut from Field Coaching (2026-08-02): double-visit intelligence is CRM visit data.
    href: "/admin/double-visit-analytics",
    icon: UsersRound,
    label: "Double Visit Analytics",
    description: "Manager coverage: repeated vs. neglected medical reps, AM/PM split, per-rep intensity.",
    permissions: [{ resource: "double_visit_analytics", action: "read" }],
  },
  {
    // Moved from People Management: compliance is judged on CRM visit activity, so it belongs
    // beside the visit data it is computed from.
    href: "/admin/field-workforce-compliance",
    icon: ClipboardCheck,
    label: "Workforce Compliance",
    description: "Field activity compliance against the working-day calendar, from the CRM visit mirror.",
    permissions: [{ resource: "hr_calendar" }],
  },
  {
    href: "/admin/crm-integrity",
    icon: MapPinned,
    label: "CRM Integrity",
    description: "Correlate visits with GPS check-ins; flag save-lag and impossible travel.",
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    href: "/admin/double-visit-data-integrity",
    icon: TriangleAlert,
    label: "Double Visit Data Integrity",
    description: "Data-integrity checks for double-visit records.",
    roles: ["Super Admin", "SFE Manager"],
  },
  // ── RETIRED 2026-08-28, BY THE OWNER, IN THE CONVERSATION ──────────────────────────────────
  //
  // Three cards stood here: "Doctor Coverage" (/admin/doctor-coverage), "Doctor Coverage Settings"
  // (/admin/doctor-coverage-settings) and "Rep Doctor Lists" (/admin/rep-doctor-lists). All three
  // are withdrawn, along with the two portal rows above and the CEO Command Center embed.
  //
  // WHY, so nobody restores them as an apparent oversight: both boards read the same iReports360
  // plan mirror and answer the same question with two different, disagreeing measures. Doctor
  // Coverage scored each doctor against the GRADE norm (A=2/B=1/C=1) rather than against the
  // number of calls the rep's own plan asked for. Measured on production for August 2026, that is
  // the wrong number on 6,307 of 8,635 graded doctors — 73%. It flatters (a grade-B doctor turns
  // green after one visit, while the plan asked for more than one on 77% of them) and it punishes
  // (on 1,496 grade-A doctors the plan asked for a single visit and the board demanded two). It
  // also passes over-visiting as green, which the owner has ruled is a deviation, not a win.
  //
  // The owner's instruction was to retire both modules and rebuild from the beginning. The library
  // code and the routes still exist and are dormant; they are deleted once the replacement ships.
  // DO NOT re-add these cards, and do not "fix" the scoring in place — the rebuild is the fix.
  {
    // Brick Coverage SURVIVES the 2026-08-28 retirement above: it measures which Source-of-Sales
    // bricks a rep reaches against the bricks carrying his sales, and never uses the grade norm
    // that the retired board was scored on. It still asks getDoctorCoverageScope for WHOSE reps a
    // viewer sees, so this entry cannot grant sight of a rep that scope would hide; listing it
    // here is UX only — src/lib/crm/brick-coverage.ts is reached through that scope.
    href: "/admin/brick-coverage",
    icon: MapPinned,
    label: "Brick Coverage",
    description:
      "Which Source-of-Sales bricks each rep actually reaches, against the bricks that carry his sales — weighted by selling units, with the blind spots named.",
    roles: ["Super Admin", "SFE Manager", "CEO"],
  },
  {
    // REPLACED "Doctor List" (/admin/doctor-list) on 2026-08-31, by the owner, in the conversation:
    // "if you have another one named rep list, then retire it — retire it and build instead of it
    // this one." Same source, same access module, same scope; what is new is the Line -> Region ->
    // Area -> Rep cascade and the grouping by brick. The old route is a redirect stub and its
    // District Manager tab went with it, so this is the single door onto that data.
    //
    // WIDENED 2026-08-28 from Super Admin alone, once the reps-per-manager scope landed: a district
    // manager sees his own reps and nobody else's, and the SAME scope restricts the cascade tree
    // BEFORE it derives a dropdown option — which is the half that was missing when the owner caught
    // the fault on Doctor Coverage that same day. The enforcing gate is canAccessDoctorList
    // (src/lib/crm/doctor-list-access.ts) plus crm_visits:read, both asked by the page; this list
    // is UX only and must be kept in step with that file.
    //
    // It does NOT bring the retired "Rep Doctor Lists" board back under a new name. That one was
    // built from the CRM PLAN and scored visits against it, so it could only ever show a doctor
    // somebody had already planned. This one mirrors the CRM's own contact list, which is the only
    // place a doctor assigned to a rep and never touched appears at all — 448 of them on the first
    // sweep. That is the assignment itself, and it survives the retirement for that reason.
    href: "/admin/reps-list",
    icon: BookUser,
    label: "Reps List",
    description:
      "Filter to a line, region and area, then open a rep to see his whole CRM contact list grouped by the brick each contact sits in — the assignment itself, not the activity against it.",
    roles: ["Super Admin", "CEO", "National Sales Manager", "SFE Manager", "Regional Manager", "District Manager"],
  },
  {
    // TAB TWO of the District Manager page — the plans a manager verifies.
    //
    // A SHORTER role list than Doctor List directly above, deliberately: this page carries the only
    // button in Phoenix that writes into the customer's CRM, and the National Sales Manager and SFE
    // Manager do not supervise a named rep. Reading a rep's list and signing his plan are not the
    // same authority, which is why the two lists live in two files
    // (src/lib/crm/plan-verification-access.ts) rather than being shared.
    //
    // The enforcing gate is canAccessPlanVerification plus `crm_plans` — READ to open the page,
    // APPROVE to press Verify, which is how the CEO appears on this list and still cannot sign
    // anything. `crm_plans` is its own resource rather than a reuse of `crm_visits` precisely
    // because a district manager holds crm_visits:read only, and granting him update there would
    // have handed him the company-wide Doctor Coverage visit-norms editor too. This list is UX only.
    href: "/admin/plan-verification",
    icon: ClipboardCheck,
    label: "Plan Verification",
    description: "Weekly and monthly plans as the reps filed them — verify one and the approval is written straight back into the CRM.",
    roles: ["Super Admin", "CEO", "Regional Manager", "District Manager"],
  },
  {
    // SUPER ADMIN ONLY — it names every rep and prints how much of their reported work nothing can
    // prove, so it stays on one account. ("Rep Doctor Lists", which carried the same reasoning and
    // stood in this group, was retired 2026-08-28 — see the note above.) The enforcing gate is
    // canAccessRepsPlans (src/lib/crm/reps-plans-access.ts) plus crm_visits:read, both asked by the
    // page; this list is UX only.
    //
    // Sits in the CRM group rather than under "Weekly / Monthly Plans" (/admin/weekly-plans,
    // Phoenix's own planning module) because it scores the CRM's recorded visits, not Phoenix's plans.
    href: "/admin/reps-plans",
    icon: Gauge,
    label: "Reps Plans",
    description:
      "The split call rate — two AM accounts and ten PM clinics per working day, reported twice: what each rep recorded, and what the check-ins prove.",
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
    href: "/admin/direct-orders/pharmacies",
    icon: Store,
    label: "Pharmacy Registry",
    description: "Register a pharmacy and its distributor codes before an order needs it.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // Not CEO: the registry is a setup surface, and the read itself refuses anyone outside
    // Super Admin / SFE Manager, so offering the link to CEO would only lead to a 403.
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    href: "/admin/direct-orders/validations",
    icon: ShieldCheck,
    label: "Pharmacy Validation",
    description: "Decide claims for pharmacies the distributor sheets do not know — match, approve on probation, or reject.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // System Admin only: the service refuses anyone else, so a wider link would only lead to a 403.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/direct-orders/held",
    icon: PauseCircle,
    label: "Held Desk",
    description: "Requests parked on a pharmacy the master database does not know — notify, track, expire.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // System Admin only: the desk's one action is the bulk held-notice email, and the service
    // refuses anyone else — offering the link wider would only lead to a 403.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/direct-orders/approval-exceptions",
    icon: Unlink,
    label: "Approval Exceptions",
    description: "Orders waiting on an employee record the directory has lost — nobody can act on them, and they show in no queue.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // System Admin only, matching listDirectOrderApprovalExceptions, the repair service and the
    // workflow-registry row for repair_approval_rung. A wider link would only lead to a 403 — and
    // the action re-addresses an in-flight approval, which is not a judgement to spread around.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/direct-orders/cleanup",
    icon: Sparkles,
    label: "Duplicate Cleanup",
    description: "One pharmacy entered twice, one order submitted twice — the system works out the fix and you confirm it.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // WIDER than the Held Desk on purpose (owner rule 5, 2026-08-09): the owner put the SFE Manager
    // in the reviewer's seat for this cleanup. The service admits exactly these two roles, so the
    // link and the gate agree — a wider link would only lead to a 403.
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    href: "/admin/direct-orders/rep-counters",
    icon: Gauge,
    label: "Per-rep Counters",
    description: "Who parks orders on unknown pharmacies, who lets them expire, and who files it as new after being shown the match.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // Deliberately WIDER than the Held Desk and Pharmacy Validation. Those gate on Super Admin
    // because their ACTIONS do; this page only reads, and it is SCOPED — a manager sees their own
    // subtree, which is exactly who the counters are for. Restricting it to Super Admin would
    // leave the people who can act on the numbers unable to see them.
    roles: ["Super Admin", "CEO", "SFE Manager", "National Sales Manager", "Regional Manager", "District Manager"],
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
  { items: [...financeLeaveManagementVacationItems, ...financeLeaveManagementExcuseItems], label: "Leave Management" },
  { items: sourceOfSalesPageItems, label: "Source of Sales" },
  // `salesAnalyticsPageItems` is deliberately ABSENT. Ruling 11 — "no analytics module, no sales
  // analytics" — delisted the module, and this group was the last thing still offering its nine
  // dashboards, via Cmd+K rather than the rail. Leaving it here would have made the ruling look
  // done while the module stayed one keystroke away, which is the exact drift this restructure
  // exists to end. The array itself is kept, unwired, so the decision is reversible in one line;
  // tests/navigation-ruling-11-analytics.test.ts fails the PR if that line comes back.
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
  { items: probationPageItems, label: "Probation" },
  { items: crmPageItems, label: "CRM" },
  { items: pharmacovigilancePageItems, label: "Pharmacovigilance" },
  { items: directOrdersPageItems, label: "Direct Orders" },
] as const;
