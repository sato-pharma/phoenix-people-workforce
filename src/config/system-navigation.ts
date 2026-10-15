import {
  Activity,
  Archive,
  Award,
  Banknote,
  BellRing,
  BookUser,
  Briefcase,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarFold,
  CalendarHeart,
  CalendarRange,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  ClipboardList,
  CircleQuestionMark,
  Clock,
  CopyCheck,
  Download,
  Columns3,
  Contact,
  Database,
  FileCheck2,
  FileClock,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  FlaskConical,
  Gauge,
  HeartPulse,
  Hourglass,
  IdCard,
  Inbox,
  Landmark,
  Laptop,
  ListChecks,
  Lock,
  Package,
  PackageCheck,
  PackageSearch,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  Link2,
  Mail,
  MailCheck,
  MailPlus,
  MailX,
  Medal,
  MousePointerClick,
  MapPinCheck,
  MapPinOff,
  MapPinned,
  PauseCircle,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  MessageSquareWarning,
  Network,
  PenLine,
  PhoneCall,
  PlusCircle,
  Presentation,
  Radar,
  ReceiptText,
  Repeat2,
  Reply,
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
  Tablet,
  Tags,
  Target,
  TrendingUp,
  TriangleAlert,
  Trash2,
  Trophy,
  Undo2,
  Unlink,
  UserCog,
  UserRoundPlus,
  UserRoundSearch,
  Users,
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
  navBadge?: "direct-orders-needs-action" | "direct-orders-approvals-pending" | "direct-orders-unbooked" | "approvals-hub-pending" | "vacation-approvals-pending" | "excuse-approvals-pending" | "plan-approvals-pending" | "marketing-approvals-pending" | "market-awareness-approvals-pending" | "calendar-disputes-pending" | "deduction-disputes-pending";
};

export type NavigationSection = {
  id: string;
  items: readonly NavigationSectionItem[];
  label: string;
  /**
   * Per-role HEADING override, resolved in `getSections` beside the item `labelByRole`. `label`
   * stays the canonical heading for every role without an entry. For a band whose rows a role sees
   * only part of, so the heading names what that role actually finds under it.
   */
  labelByRole?: Partial<Record<PhoenixRole, string>>;
  /**
   * Gates on the whole band, ALL of which must pass, ANDed with each row's own by `getSections`.
   *
   * It exists because an item gate cannot express AND: `permissionAllowed` ORs the entries of a
   * `permissions` list, so "holds recruitment:read AND holds employee_documents:read" is not
   * sayable on one row. The promoted hub sections need exactly that — a row is reachable only if
   * the viewer could have opened the hub it came from AND passes the row's own gate. Set by
   * `promoteHubRows` at the bottom of this file, from the gate the hub's own sidebar row carried;
   * without it, promoting a card whose grant is wider than its hub's puts a module on a rail that
   * never had it (measured: HR Operations, who holds `employee_documents` but not `recruitment`,
   * gained Hiring Documents and HR Forms).
   *
   * A LIST rather than one gate because hubs nest: Customers Database is a hub page that is itself
   * a card on the Master Data hub, so its band is reachable only by someone who could have opened
   * Master Data AND was offered that card AND passes the row's own gate — three gates, of which
   * only the last is sayable on the row. Chaining them is the only correct composition: two gates
   * cannot be flattened into one, because each one's `permissions` list is internally OR'd.
   *
   * Leave it undefined anywhere else — a section without one behaves exactly as it always did.
   */
  gate?: readonly {
    excludedRoles?: readonly PhoenixRole[];
    permissions?: readonly NavigationPermission[];
    roles?: readonly PhoenixRole[];
  }[];
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
// HR Resourcing — the Talent Acquisition seat — joined on 2026-10-08 with hrAuthorityRoles.
// "HR Advisory" (the HR Business Partner) left this list when the owner retired the seat on 2026-10-08:
// "no more HR business partner … everything regarding recruiting is for the talent acquisition", the
// rest of its work left with the Super Admin ("Leave it for system administrator now").
const hrAuthorityNavigationRoles = ["Super Admin", "HR Operations", "HR Resourcing"] as const satisfies readonly PhoenixRole[];
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

export const adminNavigationSectionSeeds = [
  // ── Tier 1: Executive overview ────────────────────────────────────────────────
  // Items ordered: primary dashboard → intelligence → monitoring → audit → admin tools → destructive
  {
    id: "command-center",
    items: [
      // FIRST in this section on purpose: it is the one row that answers "is anything waiting on
      // me", which is the question every other row in here is a long way round to.
      //
      // `roles` ONLY, and never `permissions`. That list is OR-ed, so adding even one resource here
      // would WIDEN the gate past the page's own `canAccessSystemAdministratorWorkspace` check —
      // handing the row to roles that then get redirected, which reads as a broken link.
      //
      // AND NO BADGE IN v1. `NavBadge` does `if (!count) return null;` and the batched badge route
      // degrades to `{count: 0}` on any failure, so a badge here would be the under-report rule
      // broken in the most-seen pixel in the product: a dead read and a clean board would paint the
      // identical nothing. A badge needs a count source that can say "I do not know", which the
      // board itself has and the badge route does not.
      // HR Resourcing (the Talent Acquisition seat) since 2026-10-08, the owner's answers in chat on 2026-10-08 — her /hr row for
      // this page must sit inside what this catalogue admits for her (tests/hr-url-namespace.test.ts).
      { href: "/admin/needs-you", icon: BellRing, label: "Needs You", roles: ["Super Admin", "HR Resourcing"] },
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
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], excludedRoles: ["CEO", "SFE Manager", "Finance Manager", "HR Operations", "HR Resourcing"] },
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
      // HR Resourcing (the Talent Acquisition seat) since 2026-10-08 — her /hr row for this page must sit
      // inside what this catalogue admits for her (tests/hr-url-namespace.test.ts).
      { href: "/admin/ceo-probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["CEO", "HR Resourcing"] },
    ],
    label: "Probation",
  },
  {
    // RENAMED to "Planning Calendar" on 2026-09-05 (owner). The id keeps its old spelling because a
    // section id is not private to this file — sidebar-layout-editor.tsx saves a per-role layout
    // keyed by it, so renaming the id silently orphans every saved arrangement.
    //
    // The two rows read the wrong way round against the pages behind them. This href is the
    // PLANNING calendar — the page titles itself "Company Planning Calendar" and its eyebrow is
    // "Planning Calendar" — while /admin/company-calendar, the real company events / holidays /
    // leave / birthdays calendar, was the one labelled "Events Calendar". Anyone looking for the
    // company calendar opened the planning one. Both names now sit on their own page, and this one
    // matches what three other places in this repo already call it: the /hr row below, this href's
    // entry in HUB_ROW_RAIL_LABELS, and the page's own eyebrow.
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
      { href: "/admin/weekly-plans/calendar", icon: CalendarRange, label: "Planning Calendar", permissions: [{ resource: "weekly_plans", action: "read" }], roles: ["CEO", "SFE Manager", "Finance Manager"] },
    ],
    label: "Planning Calendar",
  },
  {
    id: "ceo-recruitment-candidates",
    items: [
      // HR Resourcing (the Talent Acquisition seat) since 2026-10-08 — her /hr row for this page must sit
      // inside what this catalogue admits for her (tests/hr-url-namespace.test.ts).
      { href: "/recruitment/candidates", icon: BriefcaseBusiness, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["CEO", "HR Resourcing"] },
      // The SILENT manager-engagement report: which managers opened / answered / ignored the CVs
      // sent to them. Admin-shell row for CEO (Super Admin auto-sees via the waiver in
      // active-path.ts); a National Sales Manager reaches the same report, scoped to his line,
      // through the portal twin. A plain sidebar row, NOT a hub card — hub cards trip four extra CI
      // gates for no more reach. The managers being measured never see any of it.
      { href: "/recruitment/manager-engagement", icon: ClipboardList, label: "Manager CV Engagement", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["CEO", "HR Resourcing"] },
      // Hiring Analytics: channel effectiveness and where the pipeline stops. Reads across
      // EVERY candidate, so it is gated on `candidates: read` rather than the per-manager
      // hiring_interviews grant, and has no portal twin - a portal role would be shown a
      // company-wide report scoped to nobody. A plain sidebar row for the same reason as the
      // row above it.
      //
      // NO `roles` list, deliberately. Naming CEO here looked right and grants NOTHING: the
      // CEO holds no `candidates` permission at all, which permissions.ts states outright.
      // nav-roles-name-only-permission-holders caught it. The permission alone is the gate.
      { href: "/recruitment/hiring-analytics", icon: ChartNoAxesColumnIncreasing, label: "Hiring Analytics", permissions: [{ resource: "candidates", action: "read" }] },
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
  // ── Customer 360: the place-side twin of Employee 360. One page per pharmacy — the campaigns
  // raised for it, the orders placed on it, and the sales that landed — joined on the distributor
  // code pair, which is the only key the marketing register, the direct-order desk and Source of
  // Sales all share. Gated by sales:read; the LIST itself is scoped to the viewer's own territory
  // in src/lib/customer-360/access.ts, because the names a picker offers are the disclosure.
  {
    id: "customer-360",
    items: [
      {
        href: "/customer-360",
        icon: Building2,
        label: "Customer 360",
        permissions: [{ resource: "sales", action: "read" }],
      },
    ],
    label: "Customer 360",
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
      // The DOOR to the personal workspace (owner, 2026-09-05). The fifteen pages about a person's
      // own record — payslip, incentive, deductions, vacation balance, fingerprint, plans, expenses
      // — got a real home on 2026-08-30 (personalWorkspaceTabs, rendered as a tab strip inside the
      // workspace frame), but the only way IN was the account menu in the topbar. Everything worked
      // and nothing advertised it. This is that door, on the rail, beside the two workspace pages
      // that already had rows.
      //
      // NOT the fifteen pages as fifteen rows, deliberately: the same day this shipped, the rail
      // was rebalanced specifically to stop a domain being a wall of rows, and the strip on the
      // other side of this link already lists all fifteen with their own groups.
      //
      // THE GATE MIRRORS THE PAGE, INCLUDING ITS SECOND HALF. WorkspaceDashboardPage asks
      // requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" }) and THEN
      // redirects any HR-bundle seat to /hr/admin/hr-command-center — so HR Advisory and HR
      // Operations are in `adminShellEmployeeRoles` and still never see this page. Naming the three
      // roles rather than reusing that list is what keeps them off the row; giving them one would
      // be a link that throws them somewhere else, which reads as the app malfunctioning rather
      // than as "not for you". They lose nothing: both seats reach the same personal pages through
      // the /hr namespace's own "My Pages" strip. Super Admin passes by the waiver in
      // navigationItemVisible, exactly as canAccessAdminShellEmployeeWorkspacePage lets him past.
      { href: "/workspace", icon: Briefcase, label: "My Workspace", permissions: [{ resource: "employee_profile" }], roles: ["SFE Manager", "Finance Manager", "Financial Advisor"] },
    ],
    // This section was born headless (it postdates the pre-2026-08-02 sidebar, so it has no
    // "before" to restore). Given a title on 2026-08-08 so it is not the one unlabelled block
    // left floating among the restored headings — which is the exact look being undone here.
    // SFE Manager still sees no heading — see flatSidebarRoles.
    label: "My Requests",
  },
  {
    // "Approvals Hub" again since 2026-10-08, by the owner's own instruction — *"in the sidebar
    // show Approvals Hub as a title and under it every tab in the approvals"*. It was shortened to
    // "Approvals" on 2026-08-30 (ruling 10) when the band held four leave-shaped rows; it now holds
    // every approval queue in the admin shell, which is the thing his word names. The heading in
    // src/config/sidebar-domains.ts carries the same text and the two must move together: the
    // domain layer prints the heading, this label is what the flat rail prints.
    //
    // The rows below deliberately do NOT collapse into
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
      // ── THE FOUR QUEUES THAT JOINED THIS BAND ON 2026-10-08 ────────────────
      // Owner: *"in the sidebar show Approvals Hub as a title and under it every tab in the
      // approvals — vacation approval, expense approval, plan approval, other approvals, any type
      // of approval"*. Each of the four below was already a live approval queue; none of them was
      // under this heading, so finding one meant knowing which module owned it.
      //
      // Each row MOVED rather than being copied. A second row for the same href is what this file
      // keeps calling "the module lives in exactly one place", and it is not cosmetic here: two
      // rows carrying the same pending badge print the same number twice in one rail, and a viewer
      // learns to read neither.
      //
      // EXPENSE APPROVALS was a card on the Outstation Expenses hub (outstationExpensesPageItems,
      // promoted into the "Expense Desk" band). This gate is that promotion's EXACT net effect and
      // deliberately not a byte wider: the card carried `expenses` + Super Admin, the hub row
      // above it carried Super Admin / CEO, and `getSections` ANDed the two — so Super Admin, with
      // the CEO reaching the page by URL only. canReviewOutstationExpenseApprovals admits the CEO
      // and always has; widening the rail to match it is a separate decision nobody has taken.
      { href: "/admin/outstation/expense-approvals", icon: ClipboardCheck, label: "Expense Approvals", permissions: [{ resource: "expenses" }], roles: systemAdministratorNavigationRoles },
      // DIRECT ORDERS is the one row here that is NOT a move: /admin/direct-orders is the module's
      // whole workspace (every order, the tabs, Finance's booking queue) and it stays under "Order
      // Desk". This row is the approval QUEUE inside it — ?view=needs-action — which is what the
      // owner was looking at when he asked for it on 2026-10-08 (*"the direct orders, why do I see
      // direct orders here? make a separate inbox for the direct orders"*).
      //
      // Its badge is "direct-orders-approvals-pending" (/api/approvals/direct-orders/pending-count:
      // orders waiting on THIS caller's own approval rung), never the workspace row's
      // "direct-orders-needs-action", which is that count PLUS Finance's unbooked-month queue. The
      // unbooked half is a booking duty, not an approval, and it is the Finance Manager's only
      // chaser — so it stays on the workspace row and does not follow the module name in here.
      { href: "/admin/direct-orders?view=needs-action", icon: ReceiptText, label: "D.Orders Approvals", permissions: [{ resource: "direct_orders", action: "read" }], navBadge: "direct-orders-approvals-pending" },
      // MARKETING INBOX and AWARENESS APPROVALS moved out of "Marketing Workspace" with their
      // gates and badges unchanged — same roles, same permissions, same badge kinds, so nobody
      // gains or loses a route. Both keep their measured labels: "Marketing Inbox" was shortened to
      // fit a rail row that also carries a pending badge (150px against a 98px budget), and
      // renaming it "Marketing Approvals" under this heading would put that clip straight back.
      { href: "/admin/marketing-requests/inbox", icon: Inbox, label: "Marketing Inbox", navBadge: "marketing-approvals-pending", roles: ["CEO", "District Manager", "Super Admin", "SFE Manager", "Finance Manager"] },
      { href: "/admin/market-awareness/inbox", icon: Inbox, label: "Awareness Approvals", navBadge: "market-awareness-approvals-pending", permissions: [{ resource: "market_awareness", action: "read" }], roles: ["CEO", "Super Admin"] },
      // "Other Approvals" is not a heading, so the only way to take the phrase off his sidebar is
      // to drop the row. No loss: this inbox carries resignation / contract / outstation items
      // only (getAwaitingMyActionItems), and the SFE Manager holds none of those grants — it was
      // an empty inbox for him. Every other role keeps it.
      //
      // Finance Manager excluded 2026-08-10 (owner), same mechanism, different reason: his
      // leave:read grant is load-bearing for the two rows ABOVE this one — he manages OF-0001 /
      // A-1 / A-4 and decides their vacations and excuses — so the row can only go by name.
      { href: "/admin/approvals-hub", icon: Inbox, label: "Other Approvals", permissions: [{ resource: "leave", action: "read" }], excludedRoles: ["SFE Manager", "Finance Manager"], navBadge: "approvals-hub-pending" },
      // CALENDAR DISPUTES — its own row since 2026-10-08 (owner: "separate the disputes inbox into a
      // separate dispute inbox"). It was the fifth tab of Other Approvals, which is the residual
      // resignation/contract queue; a Private Calendar accuracy review is neither, and it is decided
      // by ONE person — assertDisputeDecisionActor refuses anybody but Super Admin end to end, which
      // is why this row is Super-Admin-only rather than permission-gated. `roles` alone is the right
      // gate here: Super Admin's system-administrator waiver in navigationItemVisible lets him past
      // it anyway, and no other role may reach the page (it redirects them to Other Approvals).
      // THE DISPUTE CENTER — every dispute from all three modules, open and decided, in one place
      // (owner, 2026-10-09: *"dispute closed dispute open but never disappeared from me or the
      // employee side"*). The three rows below it stay: each is that module's own live queue, and a
      // notification link already in the wild still lands on it. This row is the only place a
      // DECIDED dispute can be read again, and the only one that holds all three kinds at once.
      //
      // Gated on attendance:read because that is what the routes assert; WHICH cases a reader sees
      // is then each module's own audience rule, applied per case inside the domain helpers — a
      // manager holding attendance:read opens this page and sees only what that rule allows.
      { href: "/admin/disputes", icon: Scale, label: "Dispute Center", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/admin/private-calendar-disputes", icon: FileSearch, label: "Calendar Disputes", roles: ["Super Admin"], navBadge: "calendar-disputes-pending" },
      // DEDUCTION DISPUTES — the owner, 2026-10-08, in the same breath as the Approvals tab itself:
      // *"don't forget the deduction disputes"*, *"make every approval inbox its own row under the
      // orange Approvals tab"*. An employee contesting a published deduction is an approval queue by
      // every test that matters — it waits, it is answered by one person, and the answer moves money
      // already on a payslip — but it had no row anywhere: the only in-app route to it was the email
      // notification's own deep link, and before that it had none at all (owner: "I receive a
      // comment on a deduction and I can never reach it").
      //
      // The href carries ?tab=disputes deliberately. /admin/deductions lands on the CURRENT month's
      // collection workspace, which shows no comment at all; the Disputes tab is company-wide and
      // month-independent, which is the whole reason it exists. The "Deductions" row under Payroll
      // Management keeps the bare address and the module.
      //
      // Roles are the deductions PAGE's own VIEW_ROLES, not isDeductionsReadActor: the Finance
      // Manager passes that helper (his payroll surfaces are built on the reach) but the owner
      // revoked his screen on 2026-08-11, so a row would redirect him straight back out. Replying is
      // narrower still — Super Admin only — and that is deliberate: the CEO and HR Operations read
      // the dispute on this screen without answering it.
      { href: "/admin/deductions?tab=disputes", icon: MessageSquareWarning, label: "Deduction Disputes", permissions: [{ resource: "deductions", action: "read" }], roles: ["Super Admin", "CEO", "HR Operations"], navBadge: "deduction-disputes-pending" },
    ],
    label: "Approvals Hub",
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
      // portalShellRoles). Folding without it would leave a finance role whose page guard
      // admits ROI Tracker with no sidebar route to it at all. Marketing Manager / Product Manager
      // / Group Product Manager are deliberately NOT added — they are portal-only and reach ROI
      // Tracker through the employee portal.
      //
      // Finance Manager was in this list for the same reason until 2026-08-10, when the owner took
      // Marketing & ROI and ROI Tracker off his sidebar. The page guard
      // (assertMarketingAdminPageAccess allowCompanyOversight) still admits him by URL — this is a
      // navigation decision, not a revocation — but nothing links him here any more. His remaining
      // marketing duty is the Approval Inbox, which is the rung he actually executes — under the
      // "Approvals Hub" heading since 2026-10-08, not in this section.
      {
        href: "/admin/marketing-roi",
        icon: Megaphone,
        label: "Marketing & ROI",
        roles: ["Super Admin", "CEO", "SFE Manager", "District Manager", "Financial Advisor"],
      },
      // MOVED TO THE "Approvals Hub" BAND ON 2026-10-08 — the Marketing Inbox and Awareness
      // Approvals rows that stood here are now the two marketing queues under that heading
      // (search "THE FOUR QUEUES THAT JOINED THIS BAND" above), gates and badges byte-identical.
      // The owner asked for every approval queue under one title, and a row left here as well
      // would print the same pending badge twice in one rail. This workspace keeps what it is
      // actually for: the reports, and the bench where an approved request is executed.
      //
      // Both rows' own history travelled with them — why the CEO, the SFE Manager and the
      // Finance Manager are on the marketing row at all (each is a live rung of that chain), and
      // why the awareness queue needed an admin-shell screen — so change that row and
      // marketingAdminApprovalInboxRoles in src/lib/marketing-requests/admin-page-access.ts
      // together, exactly as before: nav roles alone render a button that bounces the viewer out.

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
        // "Requests Workspace" since 2026-09-05, not the page's own WorkspaceFrame title. The
        // 2026-09-05 hub promotion put /admin/marketing-requests — whose <h1> is also "Marketing
        // Requests" — on the rail a few rows away, inside the SAME domain group, so one word named
        // two different pages. This is the row that gives way rather than the admin board: the
        // board is the module, this is where an approved request is executed and its invoice
        // chased, and "workspace" is the word the page's own chrome uses for that. Re-measured.
        exact: true,
        icon: ReceiptText,
        label: "Requests Workspace",
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
    // ── Renamed 2026-09-05, and the reason is the promotion, not the rows ───────────────────
    // The promoted "Marketing & ROI" band (hub-marketing-roi) carries the module's eleven reports and
      // sits in the same domain group as this one, so both read "Marketing & ROI" and the sidebar
      // search drew the heading twice. This half is the inbox and the execution workspace, which is
      // what it is now called; the group heading above both is still "Marketing & ROI".
    label: "Marketing Workspace",
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
      // Labelled for the page, not the module. The CEO section above carries a row labelled
      // "Probation" too (/admin/ceo-probation), and the two are mutually exclusive by CEO/not-CEO —
      // except that navigationItemVisible waives the `roles` half of that for the system
      // administrator, so his rail alone carried two rows reading "Probation" opening two different
      // hubs. The hrefs differ, so dedupeSectionsByHref cannot collapse them, and must not: this is
      // the hub that also holds Settings, his is the executive entry point. Renaming here rather
      // than there leaves the CEO's own sidebar untouched.
      { href: "/admin/probation-tools", icon: Hourglass, label: "Probation Tools", permissions: [{ resource: "probation" }], excludedRoles: ["CEO"] },
      // Restored on 2026-08-08. Moved into the CRM hub on 2026-08-02 because it is judged on CRM
      // visit activity; it stays a card there for the SFE Manager, who is excluded here.
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }], excludedRoles: ["SFE Manager"] },
    ],
    // Heading restored on owner instruction (2026-08-08), same treatment as Command Center.
    // SFE Manager still sees no heading — see flatSidebarRoles.
    // ── Renamed 2026-09-05, and the reason is the promotion, not the rows ───────────────────
    // The promoted "People Management" band (hub-people-management) holds the module's ten rows and
      // shares this one's domain group, so both read "People Management". What is left here is the
      // Workforce Compliance board, and that is what this half is now called. The group heading
      // above both is still "People Management".
    label: "Compliance",
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
      // Screening Queue — the CV screening workstation (app/(admin)/recruitment/screening/page.tsx),
      // which until now had NO entry in this file at all.
      //
      // WHY IT NEEDED ONE. That page's own header records the decision to keep it off the
      // Recruitment & Hiring hub — a ninth card trips four unrelated CI gates — on the reasoning
      // that "a route and a link from the pool already do" make it reachable. The reach turned out
      // not to be there. Measured on production 2026-09-07 by calling the page's own loader: the
      // workstation renders 400 CVs in "New CVs — first review required", 143 in "Recommended",
      // 8 unreviewed duplicate pairs and 13 overdue manager sends, against 46 open vacancies. It
      // works, it is full, and 75% of the pool had never had a decision recorded against it — the
      // best tool in the module was the only one you could not get to without typing its URL.
      //
      // A PLAIN ROW, NOT A HUB CARD, and deliberately so: the same choice Returned CVs and Manager
      // CV Engagement each made and recorded below, for the same reason. A row costs one measured
      // label; a card costs the portal twin pairing, the mobile bottom-nav registry and the pinned
      // hub count as well, and buys no more reach than this.
      //
      // The gate is copied from the page rather than chosen here — `isHrAuthorityRole` plus
      // recruitment:read — so the row and the screen it opens cannot drift
      // (every-offered-link-opens.test.ts).
      //
      // NO `?unseen=1`, though the page documents that as its entry point and it was the obvious
      // thing to put here. A query string makes the href stop resolving to a page.tsx, and that
      // test then SKIPS the row entirely rather than failing — it reports the href among the ones it
      // "was not checked", which is easy to read past. The two outstation hub cards carrying
      // `?tab=queue` are already sitting in that unchecked list. Trading the gate-drift guard for a
      // pre-selected filter is a bad deal on the one row whose whole purpose is reaching a screen
      // that reads every field on every candidate. Landing on the workstation itself is also the
      // better arrival: the rail shows New CVs beside Duplicate review and overdue manager sends,
      // and the pile you should open is not always the unread one.
      { href: "/recruitment/screening", icon: ListChecks, label: "Screening Queue", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
      // Returned CVs — where a district manager's "return this CV to the administrator" lands, one
      // pile per returning manager and reason (app/(admin)/recruitment/returned-cvs/page.tsx). A
      // plain sidebar row rather than a ninth hub card, which would trip four unrelated CI gates for
      // no more reach — the same choice Manager CV Engagement made. The recruitment:read clause is
      // what its page gate reads too, so the two cannot drift (every-offered-link-opens.test.ts).
      { href: "/recruitment/returned-cvs", icon: Undo2, label: "Returned CVs", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
      // WhatsApp Applicants — everyone who started the WhatsApp bot's questions, searched by job
      // title and then by that title's own questions (app/(admin)/recruitment/whatsapp-applicants/
      // page.tsx). Owner, 2026-09-18. Same gate and same clause as Returned CVs above.
      { href: "/recruitment/whatsapp-applicants", icon: MessageSquareText, label: "WhatsApp Applicants", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
      // Interview Calendar — every interview booked from a CV, by week, day and half hour, with PDF
      // and Excel exports and the owner's own sharing (app/(admin)/recruitment/interview-calendar/
      // page.tsx). Owner, 2026-09-18. The row is offered where the recruiters work; the calendar
      // itself admits its owner and whoever he shared it with, and shows anyone else a plain notice
      // rather than bouncing them. A sharee outside recruitment reaches it from the share notice,
      // and in the portal from a row that appears only once it is shared with them.
      { href: "/recruitment/interview-calendar", icon: CalendarClock, label: "Interview Calendar", permissions: [{ resource: "recruitment", action: "read" }], roles: hrAuthorityNavigationRoles },
      // CV Sheet Links — the bearer tokens feeding the owner's live CV-lifecycle Google Sheet
      // (app/(admin)/recruitment/cv-lifecycle-sheet/page.tsx). #3102 shipped that whole feature
      // with no UI, so the only token was minted by hand in SQL against production and nothing in
      // Phoenix could list, revoke or renew it — and when it lapsed the sheet would have gone on
      // showing yesterday's numbers rather than an error.
      //
      // EXPORT, not read: minting a credential that copies the candidate pool out of Phoenix is a
      // different act from reading it inside, and this clause is the one the page itself asserts,
      // so the two cannot drift (every-offered-link-opens.test.ts). A plain row rather than a ninth
      // hub card, the same choice Returned CVs above made.
      { href: "/recruitment/cv-lifecycle-sheet", icon: Link2, label: "CV Sheet Links", permissions: [{ resource: "recruitment", action: "export" }], roles: hrAuthorityNavigationRoles },
      // WhatsApp Templates — the wording the company sends candidates, and the one-click send
      // (app/(admin)/recruitment/whatsapp-templates/page.tsx). A plain row rather than a hub card,
      // the same choice Returned CVs and CV Sheet Links above made and for the same reason.
      //
      // `update`, not `read`: this screen SENDS a message to a member of the public in the company's
      // name, which is acting on the pipeline — the same clause the send route asserts.
      //
      // THE ROLES ARE SPELLED OUT rather than reusing hrAuthorityNavigationRoles, which carries a
      // third role (HR Operations) the page gate does not. canSendWhatsAppTemplate resolves to
      // Super Admin + HR Resourcing (HR Advisory until recruiting moved off her seat, 2026-10-08), and a row offered to someone the page then redirects is exactly
      // what every-offered-link-opens.test.ts exists to catch. These two must be changed together.
      { href: "/recruitment/whatsapp-templates", icon: MessageCircle, label: "WhatsApp Templates", permissions: [{ resource: "recruitment", action: "update" }], roles: ["Super Admin", "HR Resourcing"] },
      // WhatsApp Inbox — both company numbers, every chat, reply / send files / templates
      // (app/(admin)/recruitment/whatsapp-inbox/page.tsx). SUPER ADMIN ONLY, owner 2026-09-15: the
      // page gate is the role itself, so this row names that one role and nothing wider — an offered
      // link that redirects is what every-offered-link-opens.test.ts exists to catch.
      // The Talent Acquisition seat (HR Resourcing) joined on 2026-10-08 — the owner's answers in chat on 2026-10-08 — and
      // canUseWhatsAppInbox names her beside the Super Admin, so the two still agree.
      { href: "/recruitment/whatsapp-inbox", icon: MessageCircle, label: "WhatsApp Inbox", permissions: [{ resource: "recruitment", action: "update" }], roles: ["Super Admin", "HR Resourcing"] },
      // Job Posts — pick a job title, write it, choose one of five designs, download the post
      // (app/(admin)/recruitment/job-posts/page.tsx; owner, 2026-10-15). canBuildJobPosts admits the
      // Super Admin and the Talent Acquisition seat, so the row names exactly those two — an offered
      // link that redirects is what every-offered-link-opens.test.ts exists to catch.
      { href: "/recruitment/job-posts", icon: Megaphone, label: "Job Posts", permissions: [{ resource: "recruitment", action: "update" }], roles: ["Super Admin", "HR Resourcing"] },
    ],
    // ── Renamed 2026-09-05, and the reason is the promotion, not the rows ───────────────────
    // The promoted "Recruitment & Hiring" band (hub-recruitment-hiring) holds the module's eight rows
      // and shares this one's domain group, so both read "Recruitment & Hiring". What is left here
      // is Returned CVs and CV Sheet Links — CV administration, not the pipeline — so that is what
      // this half is now called. The group heading above both is still "Recruitment & Hiring".
    label: "CV Tools",
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
      { href: "/admin/company-activity-report", icon: Activity, label: "Activity Report", labelByRole: { "SFE Manager": "Company Activity Report" }, permissions: [{ resource: "leave", action: "read" }], roles: ["SFE Manager"], excludedRoles: ["Super Admin", "CEO"] },
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
      { href: "/admin/early-birds", icon: Sunrise, label: "Early Birds", permissions: [{ resource: "early_birds", action: "read" }], roles: ["Super Admin", "CEO", "SFE Manager", "HR Resourcing"] },
      // Phoenix Ranks (owner, 2026-10-05): the shared rep board, with the counts behind every score.
      { href: "/admin/ranks", icon: Award, label: "Phoenix Ranks", permissions: [{ resource: "early_birds", action: "read" }], roles: ["Super Admin", "CEO", "SFE Manager", "HR Resourcing"] },
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
  //   /admin/reps-plans                   Reps Plans — merged into Reps List as its Call rate tab
  //                                       on 2026-09-21; the route now forwards there.
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
      // Rankings — the standing of the whole field over any window, cut by line, by several lines,
      // by the whole company, by title, by region or down to one person (owner, 2026-10-03: the
      // rep's two ranking cards, "built as a new tab", never inside an overview). Same engine,
      // same gate and the same three admin-shell roles as Sales vs Target above; portal roles are
      // redirected to their own scoped analytics by the page itself, exactly as that one does.
      { href: "/sales/rankings", icon: Trophy, label: "Rankings", permissions: [{ action: "read", resource: "sales" }], roles: ["Super Admin", "SFE Manager", "CEO"] },
      // Make It Happen — the forecast planner (owner 2026-09-13). Of the admin-shell roles only SFE
      // Manager and Super Admin were named; the CEO was not. Enforced by canUseMakeItHappen in
      // src/lib/sales/make-it-happen/scope.ts; portal roles are redirected to their own twin.
      { href: "/sales/make-it-happen", icon: Sparkles, label: "Make It Happen", permissions: [{ action: "read", resource: "sales" }], roles: ["Super Admin", "SFE Manager"] },
      // Daily Forecast — the CNS reps' boxes for today, pre-filled from the target: the Phoenix CRM tab
      // of that name, given a row under Make It Happen (owner, 2026-10-01: "put it under forecast in
      // sidebar"). The three admin-shell holders of phoenix_crm read who read the company, and so hold
      // every CNS territory; the tab itself is offered by forecastIsOffered, and the Training Manager
      // (who holds phoenix_crm for the Doctors directory alone) is not listed.
      { href: "/admin/field-crm?tab=forecast", activeTab: "forecast", icon: PackageCheck, label: "Daily Forecast", permissions: [{ action: "read", resource: "phoenix_crm" }], roles: ["Super Admin", "CEO", "SFE Manager"] },
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
  // Spotlight: the recognition export. SUPER ADMIN AND CEO ONLY, by the owner's instruction when
  // the module was specified — it reads every rep, district and line with no scope narrowing and
  // produces a shareable sheet carrying other people's names and achievement, which is a
  // publishing right rather than a reading one.
  //
  // ⚠ THIS ENTRY IS UX, NOT THE GATE. `/api/spotlight/{options,preview,export}` each assert
  // `spotlight` themselves; hiding the card here protects nothing on its own.
  {
    id: "sales-spotlight-module",
    items: [
      // HR Resourcing (the Talent Acquisition seat) since 2026-10-08, the owner's answers in chat on 2026-10-08.
      { href: "/spotlight", icon: Trophy, label: "Spotlight", permissions: [{ action: "read", resource: "spotlight" }], roles: ["Super Admin", "CEO", "HR Resourcing"] },
      { href: "/spotlight/cheques", icon: Banknote, label: "Award cheques", permissions: [{ action: "export", resource: "spotlight" }], roles: ["Super Admin", "CEO"] },
    ],
    label: "Spotlight",
  },
  // Milestones: the service-anniversary and birthday keepsake. SUPER ADMIN ALONE — not the same
  // holders as Spotlight above, since the owner narrowed this one himself on 2026-09-23 ("make it
  // only super admin. None either uh, CEO"). The roles here must match the matrix exactly or
  // `tests/nav-roles-name-only-permission-holders.test.ts` goes red, which is the point of it.
  //
  // ⚠ THIS ENTRY IS UX, NOT THE GATE. `/api/milestones/{due,card}` each assert `milestones`
  // themselves; hiding the link here protects nothing on its own.
  {
    id: "people-milestones-module",
    items: [
      // HR Resourcing (the Talent Acquisition seat) since 2026-10-08, the owner's answers in chat on 2026-10-08.
      { href: "/milestones", icon: Award, label: "Milestones", permissions: [{ action: "read", resource: "milestones" }], roles: ["Super Admin", "HR Resourcing"] },
    ],
    label: "Milestones",
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
      // Super Admin and the CEO. It was Super Admin ONLY until 2026-09-07, on the reasoning that
      // /sales/monthly-closing admits Super Admin, system scope and the SFE Manager and redirects
      // everyone else, so a CEO row here would bounce on entry. That reasoning was correct, and the
      // owner’s answer was to change the PAGE rather than the row: he reported the module missing to
      // the CEO, was offered the analytics mount instead, and refused it — he wants this address.
      //
      // The page now admits the CEO read-only: same workspace, same matrix, canPublish false, so no
      // publish, unpublish or lock control renders and their two status feeds are never called at all
      // (the workspace gates both on canPublish). He is NOT granted sales:import and never will be —
      // the page and its matrix reload feed assert sales:read for him specifically, and publish/lock
      // keep their own independent Super-Admin-only guard, pinned by tests/sfe-manager-nav-dead-links.
      //
      // The SFE Manager is left out of THIS row for an unrelated reason: he keeps the flat sidebar
      // WITH hub buttons and reaches this page as a Source of Sales card, which is the 2026-08-08
      // rule pinned by tests/sidebar-role-scoped-headings.test.ts.
      //
      // The section id changed from "finance-monthly-closing" with this row, because the section is
      // no longer one role's. Section ids are the localStorage key for the per-user collapsed set,
      // so the only effect is that this section starts expanded once for anyone who had collapsed
      // it; no saved sidebar ARRANGEMENT is affected, that layout is stored by href.
      { href: "/sales/monthly-closing", icon: ChartColumnBig, label: "Monthly Closing", permissions: [{ resource: "sales", action: "read" }], roles: ["Super Admin", "CEO"] },
      // Owner, 2026-08-11: a Monthly Closing tab of his own, able to export the full workbook for
      // CNS, Pedia or Anti Infective.
      //
      // He asked for /sales/monthly-closing. This row deliberately points somewhere else, because
      // that page cannot give him what he asked for and would be a dead link twice over:
      //   1. its guard admits only Super Admin, system scope, SFE Manager and the CEO — he is redirected;
      //   2. even past that, it loads its matrix behind assertPermission(sales, "import"), and
      //      `sales:import` is the one action he must never hold — it is the gate on the whole
      //      upload/publish workspace and ten other pages. Granting it to reach an export would
      //      hand him the ability to produce the closing he is only meant to consume.
      //
      // /admin/analytics/monthly-closing/details is the export-only surface built for exactly this
      // in #2010: assertPermission(sales, "read") plus canOpenClosingDetailsPage, both of which he
      // passes, and its Export XLSX button posts to /api/sales/monthly-closing/export, whose
      // Branch A names Finance Manager — the full sheet set for any line, published or not.
      //
      // Ruling 11 delisted the Sales Analytics module from navigation, which made this the ONLY
      // remaining nav entry anywhere into the /admin/analytics tree. That is deliberate: the ruling
      // removed the module, not this role's export, and the two were never the same thing. The
      // owner retired the module itself on 2026-09-17; this page is the one address it left behind
      // (its gate is src/lib/sales/closing-details-page-access.ts), and next.config.ts redirects the rest.
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
  // analytics module, no sales analytics", said three times — removed it, and on 2026-09-17 the
  // owner retired the module itself: its pages are deleted and next.config.ts redirects their
  // addresses (tests/sales-analytics-retired.test.ts). Do NOT re-add a row here: tests/navigation-ruling-11-analytics.test.ts
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

  // ── Tier 7b2: Production planning ────────────────────────────────────────────
  // Ivyronc is toll-manufactured by EGPI and Sato supplies most of its raw materials, so this is
  // where a production order turns into a buy list. 🔴 THE SIDEBAR IS NOT THE GATE here in an
  // unusual way: the module's MAIN USER cannot be listed. Dr. Sahar Khalil, the R&D Manager, holds
  // `Manager` — a portal-shell role whose other holder is the QPPV — and Reham Elwiy holds
  // `Employee`, which is the whole company. Both reach the module through its PORTAL twin, whose
  // link is drawn by `showProductionPlanningTab` from the named HR-ID list
  // (src/lib/production-planning/access.ts), not from these seeds. The CEO is listed because the
  // owner named him a main controller in his own words; the Finance Manager is read-only.
  {
    id: "production-planning",
    items: [
      {
        href: "/admin/production-planning",
        icon: FlaskConical,
        label: "Production Planner",
        permissions: [{ resource: "production_planning", action: "read" }],
        roles: ["Super Admin", "CEO", "Finance Manager"],
      },
    ],
    label: "Production Planner",
  },

  // ── Tier 7c: Verified field captures ──────────────────────────────────────────
  // A read-only gallery of every customer captured in the field — direct orders and validated
  // marketing requests — with the live photo and the GPS location the rep took. SUPER ADMIN ONLY
  // (owner, 2026-09-24): it gathers the most sensitive evidence both modules hold (shop-front photos,
  // home/venue coordinates, and who captured them) onto one company-wide screen, so the sidebar gate
  // is the narrowest one there is. The page re-asserts the same check server-side.
  {
    id: "verified-captures",
    items: [
      { href: "/admin/verified-captures", icon: MapPinned, label: "Verified Captures", roles: ["Super Admin", "SFE Manager"] },
    ],
    label: "Verified Captures",
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
      // My Milestones — the rep's own service-anniversary and Sato-Pharma birthday keepsake cards,
      // self-scoped and downloadable by him (owner, 2026-09-30). Medical-Rep only; catalogued so
      // Cmd/Ctrl+K finds it and the tab carries its own title. The page gates by role predicate, and
      // employee_profile:read (which the rep holds) is the permission the name-only guard reads here.
      { href: "/employee-portals/milestones", icon: Award, label: "My Milestones", permissions: [{ resource: "employee_profile" }], roles: ["Medical Rep"] },
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
      // The Training Manager section and every coaching destination were removed from the portal
      // catalog (command palette / Modules Control) on 2026-09-29 (owner: "hide anything related to
      // training manager and coaching anywhere system wide in employee portal"). Coaching read/create
      // grants are unchanged; the routes are blocked by the layout redirects under
      // app/employee-portals/{coaching,coaching-analytics,training-manager}. They are recorded as
      // delisted-by-ruling in tests/navigation-reachability-backlog.ts.
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
      { href: "/employee-portals/ranks", icon: Award, label: "Phoenix Ranks", permissions: [{ resource: "early_birds", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
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
      { href: "/employee-portals/source-of-sales", icon: ChartNoAxesColumnIncreasing, label: "Source of Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Medical Rep"] },
      // ONE Direct Orders row. `direct_orders:read`, not `create`: approvers who never raise an
      // order still need the workspace, and their queue lives in it now that the standalone
      // D.Orders Approval row is retired. The Report is reachable from inside the workspace.
      { href: "/employee-portals/direct-orders", icon: ReceiptText, label: "Direct Orders", permissions: [{ resource: "direct_orders", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"], navBadge: "direct-orders-needs-action" },
      // Medical Rep only — a view-only window onto the counted direct orders in his own area (owner,
      // 2026-09-24). He never raises one, so it is a separate read from the requester row above; the
      // page enforces role + area itself. `sales:read` is the permission a rep already holds here.
      { href: "/employee-portals/direct-orders-in-my-area", icon: PackageSearch, label: "Area Direct Orders", permissions: [{ resource: "sales", action: "read" }], roles: ["Medical Rep"] },
      // Weekly Sales — roles mirror PORTAL_WEEKLY_ROLES plus PORTAL_WEEKLY_REP_ROLES. Medical Rep added
      // 2026-09-16 (owner): the page gives him his own area's weekly sales only (portal-weekly-rep.ts).
      { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Medical Rep"] },
      // Weekly Stock — roles mirror PORTAL_WEEKLY_STOCK_ROLES. It includes Medical Rep (owner,
      // 2026-09-14), scoped to his own line and region by resolveWeeklyAccessScope.
      { href: "/employee-portals/weekly-stock", icon: Package, label: "Weekly Stock", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Portal render of the admin /sales/monthly-closing Closing Matrix + Details — published-gated
      // and scoped per viewer (see loadPortalMonthlyClosing / canAccessPortalClosing). Roles mirror
      // PORTAL_CLOSING_ROLES. Marketing Manager added 2026-08-12 (owner)
      // — this row IS the "/sales/monthly-closing tab" he asked her to have; that admin URL bounces
      // portal-navigation roles before any permission check, so her door is here. She opens Anti
      // Infective / Pedia / CNS through the line picker and exports the full workbook for each.
      // Medical Rep added 2026-09-16 (owner) — scoped to their OWN area(s), never their region.
      { href: "/employee-portals/monthly-closing", icon: CalendarRange, label: "Monthly Closing", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Performance Review — the presentation cut of the same closing, in each sales manager's own
      // account (owner, 2026-10-13: "show performance review tab in each district manager account …
      // and of course, everyone sees only his scope"). Roles mirror PORTAL_PERFORMANCE_REVIEW_ROLES:
      // the three TERRITORY tiers only. A Medical Rep is deliberately absent — the review ranks reps
      // against one another, which is exactly what his own area bound withholds from him — and so
      // are the product and marketing roles, who read the closing but were not named for this.
      // The enforcing gates are canOpenPortalClosingPerformanceReview and the per-viewer bound in
      // loadScopedClosingPerformanceReview; published-gated, from July 2026 upward (owner, same day:
      // "no show performance review in emp portal starting from july").
      { href: "/employee-portals/monthly-closing/performance-review", icon: Trophy, label: "Performance Review", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
      // Sales vs Target — catalogued (rather than listed as intentionally uncuratable) so an admin
      // can hide it per role from Modules Control. Roles mirror showSalesVsTargetTab in
      // src/lib/employee-portal/navigation.ts; the enforcing gate is resolveVsTargetBound, and a
      // role here with no resolvable territory still fails closed to an empty scope.
      { href: "/employee-portals/sales-vs-target", icon: Gauge, label: "Sales vs Target", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Make It Happen — roles mirror showMakeItHappenTab; the enforcing gate is canUseMakeItHappen.
      { href: "/employee-portals/make-it-happen", icon: Sparkles, label: "Make It Happen", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // Portal counterpart of /business-review, scoped per viewer. The Medical Rep is included since
      // 2026-09-30 (owner) — the module was opened to a rep on 2026-09-26, own list only and
      // downward-only, and this surfaces the sidebar link. CEO/SFE Manager/Super Admin reach it
      // through the admin entry instead, since that is the shell they land in.
      // The real gate is the access map in src/lib/business-review/portal-scope.ts; this list is
      // UX only, and a role here with no seat in that map still resolves to no access.
      { href: "/employee-portals/business-review", icon: LayoutDashboard, label: "Business Review", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      // RETIRED 2026-08-28 (owner's instruction, in the conversation): "Doctor Coverage" and
      // "Doctor Coverage Settings" were listed here for the seven portal-mode sales roles. Both are
      // withdrawn along with the admin twins — see the retirement note on crmPageItems below for
      // why. DO NOT RE-ADD either row: the board they point at scores every doctor against the
      // GRADE norm instead of the rep's own planned call count, which the owner has ruled is the
      // wrong measure. A replacement is being built; it gets its own entry when it ships.
      // The four sales roles plus Super Admin / CEO (who drill any one line nationwide via the line
      // picker) — see TERRITORY_DRILLDOWN_ROLES in src/lib/sales/territory/service.ts, the
      // server-side gate this list must match.
      { href: "/employee-portals/territory-drilldown", icon: MapPinned, label: "Sales Drilldown", permissions: [{ resource: "sales" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Super Admin", "CEO"] },
      // Portal-shell counterpart of /sales/territory-management — same component, own-scope data.
      // Medical Rep is deliberately excluded: this compares MULTIPLE areas' bricks against each
      // other, which is a District-Manager-and-up decision, not a single rep's own area view.
      { href: "/employee-portals/territory-management", icon: Waypoints, label: "Territory Management", permissions: [{ resource: "territory" }], roles: ["District Manager", "Regional Manager", "National Sales Manager"] },
      // Read-only Targets (owner decision 2026-07-30). Mirrors PORTAL_TARGETS_ROLES plus
      // PORTAL_REP_TARGETS_ROLES — a Medical Rep is served their OWN targets only (owner, 2026-09-16).
      // Editing and upload stay on the admin surface with SFE Manager / Super Admin.
      { href: "/employee-portals/targets", icon: Target, label: "Targets", permissions: [{ resource: "sales", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] },
      // Spotlight (self) — one's OWN recognition sheet over any period. A Medical Rep is measured as
      // himself; a District Manager as his DISTRICT, which is what a DM's achievement is (owner,
      // 2026-09-30). Catalog entry so the command palette can find it and the tab is titled; the
      // rendered sidebar link sits under Sales in employee-portal-layout.tsx, and the page and the
      // /api/spotlight/me routes gate on spotlight_self and resolve the caller's own HR id.
      { href: "/employee-portals/spotlight", icon: Sparkles, label: "Spotlight", permissions: [{ resource: "spotlight_self", action: "read" }], roles: ["Medical Rep", "District Manager"] },
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
      // src/lib/crm/doctor-list-roles.ts) does not admit the role at all.
      //
      // DOCTOR_LIST_PORTAL_ROLES verbatim, and it must stay that way — tests/reps-list.test.ts pins
      // the two lists equal. Widened 2026-09-03 from three seats to seven, on the owner's
      // instruction to show the rep list, the plans and the KPIs to the marketing and field-support
      // seats. Widening it here grants nothing on its own: getDoctorListScope decides whose reps
      // each viewer sees and getRepsListBoard applies it to the cascade before it derives an option,
      // so the picker is never wider than the viewer.
      { href: "/employee-portals/reps-list", icon: BookUser, label: "Reps List", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Regional Manager", "District Manager"] },
      // My List's sidebar row was retired 2026-09-25 (owner: "hide"/"delete the dormant My List board
      // code") — the rep's own contact list lives in Phoenix CRM's List tab now. The old
      // /employee-portals/my-list route survives only as a redirect onto it, so it has no catalog row.
      // KPIs — THE 2026-08-28 REBUILD. Doctor Coverage stood here until the owner retired it that
      // day with "rebuild from the beginning"; this is the entry that comes back in its place, and
      // the drift check retired with it comes back too (tests/doctor-coverage-scope.test.ts).
      //
      // The role list is DOCTOR_COVERAGE_PORTAL_ROLES verbatim and must stay that way — the seven
      // portal-mode roles the retired board offered, plus Training Manager, added 2026-09-03 with
      // the owner's instruction to show the rep list, the plans and the KPIs to the marketing and
      // field-support seats. Super Admin, CEO and SFE Manager are absent because they are admin-mode
      // and land on /admin/kpis instead. Widening this list here grants nothing: getDoctorCoverageScope
      // inside getKpisBoard decides whose reps each viewer sees, and it is asked on every load.
      { href: "/employee-portals/kpis", icon: TrendingUp, label: "KPIs", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      // The three measures that left the KPIs page for a page each (owner, 2026-10-14). The role list and
      // the permission are the KPIs row's own, verbatim — the pages are that board sliced by measure, and
      // getDoctorCoverageScope inside getKpisBoard still decides whose reps each viewer sees.
      { href: "/employee-portals/kpis/frequency", icon: Repeat2, label: "Frequency", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/kpis/coverage", icon: Radar, label: "Coverage", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/kpis/call-rate", icon: PhoneCall, label: "Call Rate", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      // Reps Plans stood here until 2026-09-21, when the owner merged it into Reps List ("merge the 2
      // modules into 1 module WHICH REPS LIST"). Its board is the Call rate tab on the Reps List row
      // above, behind the same REPS_PLANS_PORTAL_ROLES gate, and /employee-portals/reps-plans forwards
      // there — so the separate row went, rather than two rows opening one module.
    ],
    label: "Sales Operations",
  },
  {
    id: "coaching",
    items: [
      { href: "/employee-portals/double-visit-analytics", icon: Activity, label: "Double-Visit Analytics", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/dv-planner", icon: CalendarDays, label: "DV Planner", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Training Manager"] },
      { href: "/employee-portals/double-visit-report", icon: FileSpreadsheet, label: "Double Visit Report", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Training Manager"] },
      // Field Activity — one person's field days end to end. The role list is the module's own
      // (src/lib/field-activity/access.ts) and deliberately omits the Medical Rep and the two staff
      // seats that hold the DV board for its counts rather than for a person's day.
      //
      // 🔴 THE HREF IS THE PORTAL ONE, and SFE Manager is NOT in this row. Both were wrong when the
      // module shipped: an /admin/ href in the PORTAL catalog, listing a role that never renders
      // this catalog at all. `app/(admin)/layout.tsx` bounces every portal-mode viewer out of
      // /admin/**, so the row led its five field seats nowhere. SFE Manager, Super Admin and CEO are
      // admin-mode and have their own row in adminNavigationSectionSeeds.
      //
      // This catalog drives the command palette and Modules Control. It does NOT drive the portal
      // rail — that is built by hand in buildEmployeePortalSections, off showFieldActivityTab. A row
      // here alone is exactly how Early Birds became URL-only; both halves move together or the
      // module is invisible again.
      { href: "/employee-portals/field-activity", icon: MapPinned, label: "Field Activity", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
      // Coaching Analytics was removed from the portal catalog on 2026-09-29 (owner: hide coaching +
      // training manager system-wide in the portal). Only the double-visit / field-activity items
      // remain in this section, so its heading is no longer "Coaching".
    ],
    label: "Double Visits",
  },
  {
    id: "employee-market-awareness",
    items: [
      {
        href: "/employee-portals/market-awareness",
        icon: Sparkles,
        label: "Market Awareness",
        // The whole audience: the Group Product Manager, both Product Managers and the Marketing
        // Manager raise activities; the informed roles (NSM, SFE, Finance) and the CEO read them.
        // The DISTRICT MANAGER was an informed reader here until 2026-09-12 and is now out at the
        // owner's instruction — see MARKET_AWARENESS_PORTAL_ROLES, which this list mirrors. This
        // list is UX only — every route calls assertPermission(market_awareness) and then narrows
        // by identity, because the matrix has no per-row layer and a Product Manager sees only his
        // own.
        permissions: [{ resource: "market_awareness", action: "read" }],
        roles: [
          "Product Manager",
          "Group Product Manager",
          "Marketing Manager",
          "National Sales Manager",
          "SFE Manager",
          "Finance Manager",
          "CEO",
          "Super Admin",
        ],
      },
      {
        href: "/employee-portals/market-awareness/inbox",
        icon: Inbox,
        label: "Awareness Approvals",
        // Its own badge kind. Market Awareness is deliberately outside the consolidated approvals
        // hub (the owner asked for a separate queue), so "approvals-hub-pending" counts everything
        // EXCEPT this inbox — the link would sit silent while a decision waited behind it.
        navBadge: "market-awareness-approvals-pending",
        // The DECISION surface, not the module — so a much shorter list than the tab above: the
        // parallel group (the Marketing Manager and each line's National Sales Manager), the Group
        // Product Manager for the retired single-manager step, and the CEO. Like every list here it
        // is UX only. listDecisionInbox calls assertPermission(market_awareness, read) and then
        // filters through the same canDecideStep the decision route enforces, so a role on this list
        // who holds no decision sees an empty queue rather than a refusal, and one off it could not
        // act even if the link were rendered.
        //
        // Kept in step with MARKET_AWARENESS_DECIDER_ROLES, which is what actually draws this link
        // in the portal shell — these seeds do not.
        permissions: [{ resource: "market_awareness", action: "read" }],
        roles: [
          "Group Product Manager",
          "Marketing Manager",
          "National Sales Manager",
          "CEO",
          "Super Admin",
        ],
      },
    ],
    label: "Market Awareness",
  },
  {
    id: "employee-visual-aids",
    items: [
      {
        href: "/employee-portals/visual-aids",
        icon: Presentation,
        label: "Visual Aids",
        // The flyers a rep shows a doctor on the tablet (owner, 2026-09-18). Mirrors
        // VISUAL_AIDS_PORTAL_ROLES (src/lib/visual-aids/rules.ts), which is what actually draws the
        // portal link — these seeds do not. UX only: every /api/visual-aids route asserts
        // visual_aids and then narrows to the viewer's own line.
        permissions: [{ resource: "visual_aids", action: "read" }],
        roles: [
          "Medical Rep",
          "District Manager",
          "Regional Manager",
          "National Sales Manager",
          "Group Product Manager",
          "Marketing Manager",
        ],
      },
    ],
    label: "Visual Aids",
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
      // THE MEDICAL REP IS DELIBERATELY ABSENT from this row and from the Approval Inbox row below
      // (owner, 2026-09-18): a rep's job in this module is the field capture on Customer Validation
      // above, and the spend request against what they validated is raised by their District
      // Manager. Mirrors canUseEmployeePortalMarketingRequests; the boundary is server-side
      // (assertMarketingDraftWorkspaceAccess / assertMarketingRequestCreationAccess).
      {
        href: "/employee-portals/marketing-requests",
        icon: Megaphone,
        label: "Marketing Requests",
        roles: [
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
      // Restored 2026-09-15 with the owner's release rules: a week reaches this page only after
      // the Super Admin releases it from /attendance/weekly-review, and the page shows the
      // viewer's OWN released weeks and nothing else (the 2026-09-08 removal was the holding
      // position while those rules were settled).
      { href: "/employee-portals/attendance/digests", icon: CalendarCheck, label: "Weekly Attendance", permissions: [{ resource: "attendance", action: "read" }] },
      // MY DISPUTES — the employee's own half of the Dispute Center: a calendar day, a deduction or
      // a flagged attendance day, each with its whole conversation and the reason for the decision.
      { href: "/employee-portals/disputes", icon: Scale, label: "My Disputes", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/employee-portals/visits", icon: MapPinned, label: "My Visits", permissions: [{ resource: "crm_visits", action: "read" }] },
      // Phoenix CRM's portal address, beside My Visits because that page held its only door until
      // 2026-09-23. This catalog does not drive the sidebar — employee-portal-layout.tsx does — but
      // it is what the Cmd/Ctrl+K palette searches and what names the browser tab, so the page is
      // listed here as well. The real gate is inside the page (the phoenix_crm permission, a
      // territory, and an open line); the coarse permission below only keeps the palette honest.
      { href: "/employee-portals/field-crm", icon: ClipboardList, label: "Phoenix CRM", permissions: [{ resource: "phoenix_crm", action: "read" }] },
      // Place checks — a district manager's own team's place validations (owner, 2026-10-13). Listed
      // here for the Cmd/Ctrl+K palette and the browser tab's name, exactly as the row above is; the
      // sidebar row itself is in employee-portal-layout.tsx and the real gate is inside the page
      // (`readsTeamPlaceChecks` — a district or acting-district seat).
      //
      // 🔴 NO `roles:` LIST HERE, DELIBERATELY, exactly like the Phoenix CRM row above it. An ACTING
      // district manager holds the seat without holding the role name, so a roles list would hide the
      // palette entry from somebody the page itself admits — and `Manager`, the name that was here
      // first, holds no phoenix_crm grant at all, so it granted nothing and reddened
      // `tests/nav-roles-name-only-permission-holders.test.ts`. The permission keeps the palette
      // honest and the page's own gate is the boundary.
      { href: "/employee-portals/place-checks", icon: MapPinCheck, label: "Place checks", permissions: [{ resource: "phoenix_crm", action: "read" }] },
      // Visit report — a district manager's own team (owner, 2026-10-15), listed for the palette and the tab
      // name exactly as the row above is, with NO `roles:` list for the same reason: an acting district
      // manager holds the seat without the role name. The page's own gate (`canReadVisitReport`) is the boundary.
      { href: "/employee-portals/visit-report", icon: ClipboardList, label: "Visit report", permissions: [{ resource: "phoenix_crm", action: "read" }] },
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
// FLAT, NOT HUBBED. This was written as "deliberately different from the admin shell", because the
// admin sidebar collapsed a module into one hub button and made you open a card grid to reach the
// page you wanted. On 2026-09-05 the owner made the admin shell flat too — "I do not want any
// subtitle to be the one that when I press, it redirects me to a page with big modules" — so the
// difference is gone and this catalogue is no longer the exception. With ~30 pages across 8 sections
// and collapsible headings, every HR page is ONE click from anywhere.
//
// Three rows here were themselves hub doors and did not survive that rule: "Attendance"
// (/attendance), "Leave Management" (/leave-management) and "Payroll Management"
// (/admin/payroll-management). Each is replaced by the cards behind it that this list did not
// already carry — five rows in total — and each replacement is annotated where it sits. The hub
// pages themselves still exist and still work under /hr/… if a link lands on one; nothing on the
// rail opens one.
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
      // The Talent Acquisition seat (2026-10-08) — the owner's answers in chat on 2026-10-08. The board shows her only the queues
      // she holds a rung on; the owner-only ones read "not yours" (src/lib/needs-you/sources.ts).
      { href: "/hr/admin/needs-you", icon: BellRing, label: "Needs You", roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
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
      { href: "/hr/employee-360", icon: Contact, label: "Employee 360", permissions: [{ resource: "employee_profile", action: "read" }] },
      { href: "/hr/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      // Beside the Organogram since 2026-10-16: it is the same seat model read as a list of the empty
      // chairs, and the two answer one question — who sits where, and where nobody does.
      { href: "/hr/reports/vacancies", icon: UserRoundSearch, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
      // Owner instruction 2026-09-07: "territory management is not appearing in hr business partner
      // account make it appear to her." It sits next to the Organogram because that is what it is —
      // the same seat model seen as geography rather than as a chart.
      //
      // The address is the `/hr` spelling of the ADMIN page (proxy.ts rewrites /hr/sales/... to
      // /sales/...), not a third copy of the module. There are already two — the admin page and the
      // portal twin for the sales ladder — and a third would be the fourth place to forget when the
      // map changes.
      //
      // `roles` pins it to HR Advisory even though the permission would do it alone: HR Operations
      // holds no `territory` grant today, and if she ever gains one it should be because somebody
      // decided that, not because this row was written permission-only.
      // NO Territory Management row since 2026-10-08: it existed for the HR Business Partner alone, and
      // the owner retired that seat. The Super Admin reaches the map from the admin rail.
      // ONBOARDING PAPERWORK — HER COPY of the two rows the Recruitment section carries below.
      // Listed twice with mutually-exclusive gates, the same pattern Organogram already uses:
      // getSections dedupes by href and keeps the FIRST occurrence, so for HR Operations this copy
      // wins, the Recruitment copies drop out, and that section is left with zero visible rows for
      // her — which removes the heading entirely rather than hiding it.
      //
      // Why the move: both screens gate on `employee_documents`, a personnel-file grant she holds
      // company-wide since #2806. They are onboarding paperwork, not recruiting. Reading them under
      // a "Recruitment" heading advertised a function this seat does not hold — on the very seat the
      // owner had just blocked from the CV Database — which is the same defect class as the role key
      // that leaked into the Attendance hero on 2026-09-01 (#2842): correct page, wrong label.
      //
      // HR Advisory is unaffected: `roles` hides this copy from her, so she keeps both rows under
      // Recruitment where they belong for a recruiting seat. `excludedRoles` keeps the Super Admin
      // there too — navigationItemVisible waives the `roles` check for that role but never
      // `excludedRoles`, so without it these rows would silently relocate on his rail as well.
      { href: "/hr/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }], roles: ["HR Operations"], excludedRoles: ["Super Admin"] },
      { href: "/hr/hiring-pack", icon: FileSignature, label: "HR Forms", permissions: [{ resource: "employee_documents" }], roles: ["HR Operations"], excludedRoles: ["Super Admin"] },
      { href: "/hr/business-cards", icon: IdCard, label: "Business Cards", permissions: [{ resource: "employee_documents" }], roles: ["HR Operations"], excludedRoles: ["Super Admin"] },
      // The Interview Calendar, for HR Operations — the owner made her its admin on 2026-09-21 ("full
      // access and control to it as admin"), so isInterviewCalendarOwner admits her seat. The
      // Recruitment copy is gated on the recruitment grant she does not hold, and she must never be
      // shown a "Recruitment" heading (tests/cv-database-recruiting-boundary.test.ts), so her row
      // lives here. No permission: the calendar's own ownership is the gate, and every API route
      // asserts it. `excludedRoles` keeps the Super Admin's row under Recruitment, as above.
      { href: "/hr/recruitment/interview-calendar", icon: CalendarClock, label: "Interview Calendar", roles: ["HR Operations"], excludedRoles: ["Super Admin"] },
      // CV Lookup — owner, 2026-09-30: HR Operations may SEARCH the CV database and open only what
      // the search returns, and must not have the database itself.
      //
      // IT LIVES HERE, UNDER "People", FOR THE SAME REASON THE ROWS ABOVE DO: she must never be
      // shown a "Recruitment" heading (tests/cv-database-recruiting-boundary.test.ts), because a
      // heading advertises a function this seat does not hold. No `roles` and no `excludedRoles` —
      // `cv_lookup` is held by HR Operations and the Super Admin and by nobody else, so the grant
      // picks the audience on its own, and the owner finding it here is right: it is the screen he
      // has to be able to open in order to see exactly what she sees.
      //
      // Naming `cv_lookup` rather than `recruitment` or `candidates` is what keeps the row honest:
      // the page and both API routes assert this resource, so the row and the gate answer the same
      // question. A row naming a resource its page does not assert is the CV Database's own
      // `vacancies`/`recruitment` drift, which cost this exact seat an unintended screen.
      { href: "/hr/cv-lookup", icon: FileSearch, label: "CV Lookup", permissions: [{ resource: "cv_lookup" }] },
      // Probation moved OUT of this section on 2026-09-01, down to its own "Probation" section,
      // where it sits beside the outcomes dashboard. It is one module and it was in two minds
      // here: People is who is on the payroll, probation is how a new joiner is performing.
      { href: "/hr/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
      { href: "/hr/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
      // The offboarding arc, in the order it actually happens: the departure is recorded, the
      // mailbox is closed, the conversation is captured. Each row advertises the permission its
      // page really gates on - the Deductions note under Payroll is what happens when they drift.
      //
      // Only ONE of these two ever renders for a given seat, by design. Mailbox Revocation is in
      // people_records (HR Operations); Retention is in engagement_retention (HR Advisory). The
      // sidebar does not enforce that - the route handler does - but the split is the reason a
      // reader of this file should not "helpfully" grant both to both.
      { href: "/hr/mailbox-offboarding", icon: MailX, label: "Mailbox Revocation", permissions: [{ resource: "mailbox_offboarding" }] },
      // The joiner's end of the same job, on the same grant: a new hire's company mailbox, created in
      // Turbify and handed to Phoenix so their My email works on day one (owner, 2026-09-18).
      { href: "/hr/new-hire-mailboxes", icon: MailPlus, label: "New Hire Mailboxes", permissions: [{ resource: "mailbox_offboarding" }] },
      // Device Custody sits with the other two because it closes the same way they do — the
      // custody receipt's البند (7) has the device returned "قبل استلام مستحقاتي النهائية", before
      // final dues. It is not offboarding-only: the same register issues the machine on a joiner's
      // first morning, which is why the label names the OBLIGATION rather than either end of it.
      { href: "/hr/devices", icon: Laptop, label: "Device Custody", permissions: [{ resource: "company_devices" }] },
      // The Retention Register row left the HR rail on 2026-10-08 with the HR Business Partner seat:
      // retention is the Super Admin's now (read by the CEO), and no HR seat holds it.
      // NO Distribution Lists and NO Sato Email Composer row here since 2026-10-08. Both rows existed
      // for the HR Business Partner alone, and the owner retired that seat ("Leave it for system
      // administrator now"); the Super Admin keeps both on the admin rail.
    ],
    label: "People",
  },
  // Recruitment and its WhatsApp & Posts band (2026-10-16) — the Talent Acquisition seat's whole
  // job, straight after the four People rows. They cannot go above People: HR Operations' copies of
  // the paperwork rows must be met before Recruitment's, or she would be shown a Recruitment
  // heading (tests/cv-database-recruiting-boundary.test.ts). No other HR seat holds
  // `recruitment`, so for HR Operations nothing here renders.
  {
    id: "hr-recruitment",
    // ORDERED AS THE WORK RUNS (premium sweep of the Talent Acquisition rail, 2026-10-16): the
    // pipeline, the queue she screens, the candidates she owns, the interview, the offer, then the
    // numbers about all of it. The WhatsApp and posting tools are their own section below — this one
    // held 13 rows, and the owner has said more than once that a crowded rail IS the defect.
    items: [
      { href: "/hr/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment" }] },
      // The Talent Acquisition seat (2026-10-08) — ticked for her by the owner, see the note under Employee Requests.
      { href: "/hr/recruitment/screening", icon: ListChecks, label: "Screening Queue", permissions: [{ resource: "recruitment", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/recruitment/candidates", icon: Inbox, label: "My Candidates", permissions: [{ resource: "hiring_interviews", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // The HR shell's own row for /recruitment/interview-calendar (2026-09-18). Whether the calendar
      // opens is its own sharing, not this clause. HR Operations reaches it from "People" instead (see
      // the copy there): she is its admin, but she holds no recruitment grant and is never shown a
      // Recruitment heading.
      { href: "/hr/recruitment/interview-calendar", icon: CalendarClock, label: "Interview Calendar", permissions: [{ resource: "recruitment" }] },
      // `recruitment`, matching the page's own gate — NOT `vacancies`. Owner instruction
      // 2026-09-01, "block the cv database for her too": HR Operations was granted
      // vacancies:read for the Vacancies Report, which handed her this recruiting screen as a
      // side effect. Naming the resource the page actually asserts removes the row AND shuts the
      // door in one place. A merge that restores `vacancies` here silently reopens it —
      // tests/cv-database-recruiting-boundary.test.ts is what catches that.
      { href: "/hr/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "recruitment" }] },
      { href: "/hr/offers", icon: MailCheck, label: "Job Offers", permissions: [{ resource: "offers" }] },
      { href: "/hr/recruitment/hiring-analytics", icon: ChartNoAxesColumnIncreasing, label: "Hiring Analytics", permissions: [{ resource: "candidates", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // Added 2026-09-01. The audience is a ROLE SET, not a permission — canViewManagerCvEngagement
      // — so this row carries `roles` rather than a grant, and the two must be read together: the
      // owner amended that list the same day to add HR Advisory and nobody else in HR.
      // Labelled "Manager CV Engagement", matching the page h1, the admin row, the portal tab and
      // the portal page title — every other surface in the app. It was briefly shortened to
      // "Manager Engagement" to fit a 137px budget the width model charged this label; that charge
      // was an ADMIN rail + hub-chrome pairing an HR seat provably never renders, and once
      // sidebar-label-width stopped charging it the reason for the short name went away. The full
      // name measures 153px against this rail's 157px budget, so it fits and the drift is closed.
      { href: "/hr/recruitment/manager-engagement", icon: Radar, label: "Manager CV Engagement", permissions: [{ resource: "recruitment" }], roles: ["HR Resourcing"] },
      { href: "/hr/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }] },
      { href: "/hr/hiring-pack", icon: FileSignature, label: "HR Forms", permissions: [{ resource: "employee_documents" }] },
      { href: "/hr/business-cards", icon: IdCard, label: "Business Cards", permissions: [{ resource: "employee_documents" }] },
      // NO Returned CVs and NO CV Sheet Links row here since 2026-10-08. Both were the HR Business
      // Partner's, and recruiting moved off her seat that day; the Talent Acquisition seat holds the
      // key but the owner fenced both pages off it (src/lib/auth/seat-page-fences.ts). No HR seat can
      // open either, so a row would only offer a redirect. They stay on the admin rail for the Super
      // Admin.
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
    ],
    label: "Recruitment",
  },
  {
    id: "hr-outreach",
    // The Talent Acquisition seat's WhatsApp and posting tools, split out of Recruitment on
    // 2026-10-16 so neither section is a 13-row wall. Every row keeps the gate it always had; only
    // the heading moved. HR Operations holds no `recruitment` grant, so this heading never renders
    // for her (tests/cv-database-recruiting-boundary.test.ts).
    items: [
      // The HR shell's own row for /recruitment/whatsapp-applicants, added with the page on
      // 2026-09-18. The admin row alone would leave the seat that works in this shell able to reach
      // it only by typing the address (see WhatsApp Templates below). Only a `recruitment` holder is
      // offered it, so HR Operations never is.
      { href: "/hr/recruitment/whatsapp-applicants", icon: UserRoundPlus, label: "WhatsApp Applicants", permissions: [{ resource: "recruitment" }] },
      { href: "/hr/recruitment/whatsapp-replies", icon: Reply, label: "WhatsApp Replies", permissions: [{ resource: "recruitment" }] },
      // The Talent Acquisition seat (2026-10-08) — the owner's answers in chat on 2026-10-08. Both company numbers, every chat;
      // canUseWhatsAppInbox (src/lib/whatsapp-inbox/access.ts) is the gate this row mirrors.
      { href: "/hr/recruitment/whatsapp-inbox", icon: MessageCircle, label: "WhatsApp Inbox", permissions: [{ resource: "recruitment", action: "update" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // WhatsApp Templates — the HR shell's own row for /recruitment/whatsapp-templates.
      //
      // THE ADMIN ROW IS NOT ENOUGH, and that is the whole reason this exists. The Talent
      // Acquisition seat works in the `/hr` shell, which renders from THIS catalogue, so the
      // admin-shell row added with the feature was invisible to the one person who uses it most: she
      // could reach the page only by typing the URL. Measured 2026-09-08 by signing in as the seat
      // and watching the redirect land on /hr/recruitment/whatsapp-templates with no row to click.
      //
      // `roles: ["HR Resourcing"]` matches Manager CV Engagement, and it is required rather than
      // cosmetic: the other HR seats also render this shell, and `canSendWhatsAppTemplate` redirects
      // them — an offered link that redirects is what every-offered-link-opens.test.ts exists to
      // catch. It named "HR Advisory" until the owner moved recruiting off the HR Business Partner on
      // 2026-10-08. "HR Resourcing" is the permission key; "Talent Acquisition" is the title shown
      // for it (displayTitleForRole), never a role in its own right.
      { href: "/hr/recruitment/whatsapp-templates", icon: MessageSquareText, label: "WhatsApp Templates", permissions: [{ resource: "recruitment", action: "update" }], roles: ["HR Resourcing"] },
      // Job Posts (owner, 2026-10-15) — the HR shell's own row, for the same reason WhatsApp
      // Templates has one: the Talent Acquisition seat works in this shell. canBuildJobPosts is the gate.
      { href: "/hr/recruitment/job-posts", icon: Megaphone, label: "Job Posts", permissions: [{ resource: "recruitment", action: "update" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // Added 2026-09-01. The page was `admin:update` — Super Admin alone — and was re-gated to
      // `recruitment:update` rather than the resource being widened, because `admin:update` also
      // opens module locks, scope visibility, salary flags and a notification TEST-SEND endpoint.
      // See assertScreeningQuestionsAccess in whatsapp-screening-questions-admin.ts.
      { href: "/hr/admin/screening-questions", icon: CircleQuestionMark, label: "Screening Questions", permissions: [{ resource: "recruitment", action: "update" }] },
    ],
    label: "WhatsApp & Posts",
  },
  {
    id: "hr-requests",
    // The request desks, out of People since 2026-10-16 (premium sweep of the Talent Acquisition
    // rail): People is who works here, and these are what employees ASK for — a support ticket, a
    // business card, and the print run that answers it. Both seats that work a desk keep every row
    // and every gate they had; only the heading is new.
    items: [
      { href: "/hr/admin/support-requests", icon: LifeBuoy, label: "HR Support Requests", permissions: [{ resource: "support_requests" }] },
      { href: "/hr/admin/business-card-requests", icon: ClipboardList, label: "Business Card Requests", permissions: [{ resource: "business_card_requests" }] },
      // Business Cards — the Talent Acquisition seat's copy. HR Operations prints from People, on
      // employee_documents, and the Super Admin from Recruitment; getSections keeps the first href
      // it meets, and each seat is offered exactly one.
      // ── The Talent Acquisition seat's own rows (HR Resourcing, 2026-10-08) ──────────────────────
      // Every row gated `roles: ["HR Resourcing"]` in this catalogue is a page the owner ticked for
      // her on the access blueprint that no other HR seat is offered here. `excludedRoles` keeps the
      // Super Admin's HR rail exactly as it was (navigationItemVisible waives `roles` for him, never
      // `excludedRoles`). Business Cards opens for her on the request desk she works, not on
      // employee_documents, which she does not hold — src/lib/business-cards/access.ts.
      { href: "/hr/business-cards", icon: IdCard, label: "Business Cards", permissions: [{ resource: "business_card_requests", action: "update" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
    ],
    label: "Employee Requests",
  },
  {
    id: "hr-attendance",
    items: [
      // ── 2026-09-05: this was ONE row, "Attendance", pointing at /attendance — the hub PAGE ─────
      //
      // Attendance is named in the HR Business Partner job description too ("use HR data to identify
      // turnover, vacancy, attendance, performance or engagement patterns that need management
      // attention"), so Advisory's attendance:read was right and so was the row. What was wrong was
      // the destination, twice over. First the hub listed 0 of 12 for her and 3 of 12 for Operations,
      // which was fixed by widening the cards. Then the owner removed every rail row that opens a
      // page of modules — "I do not want any subtitle to be the one that when I press, it redirects
      // me to a page with big modules" — and this row was one, in a catalogue whose own header says
      // it is FLAT, NOT HUBBED. So the cards each seat clears and this list did not already carry are
      // written out here, and the hub door is gone. Gates copied from attendanceManagementPageItems,
      // narrowed to the two seats this catalogue serves.
      { href: "/hr/attendance/monthly-summary", icon: CalendarCheck, label: "Monthly Summary", permissions: [{ resource: "employees" }] },
      { href: "/hr/attendance/fingerprint-report", icon: FileSpreadsheet, label: "Fingerprint Report", permissions: [{ resource: "employees" }], roles: ["HR Operations"] },
      { href: "/hr/attendance/holiday-calendar", icon: CalendarClock, label: "Holiday Calendar", permissions: [{ resource: "employees", action: "read" }], roles: ["HR Operations"] },
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
      // The Talent Acquisition seat (2026-10-08) — ticked for her by the owner, see the note under
      // Employee Requests. "Events Calendar" because "Company Calendar" above is already /hr/hr-calendar; this
      // is the admin host of the portal events calendar (events, holidays, leave and birthdays).
      { href: "/hr/admin/company-calendar", icon: CalendarHeart, label: "Events Calendar", permissions: [{ resource: "attendance", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/admin/private-calendars", icon: CalendarFold, label: "Private Calendars", permissions: [{ resource: "attendance", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // Last of the calendars on purpose (2026-10-16): the three above are the company's own — official,
      // events, private — and this one is the field force's submitted plans, a different thing.
      // Owner instruction 2026-09-01 for HR Operations, and independently added for HR Advisory
      // the same day — so the row carries NO roles gate and both seats get it on the
      // weekly_plans:read grant alone. HR Advisory has held that through workforce_insight all
      // along; HR Operations was granted it in the same change (src/lib/auth/hr-functions.ts).
      //
      // Labelled "Planning Calendar", NOT "Company Planning Calendar" as the admin module
      // registry spells it, and deliberately: the Company Calendar row is the OFFICIAL company
      // calendar (holidays, HR events) and this one is the field force's submitted weekly and
      // monthly plans. Two adjacent rows both beginning "Company Calendar" is a pair nobody can
      // tell apart from the rail, and the rail is where the choice is made.
      //
      // The plans LIST at /admin/weekly-plans opens on this same grant and is deliberately NOT a
      // row: it is the plan APPROVAL workspace, which belongs to the sales ladder, and neither
      // HR seat holds a weekly_plans write action.
      { href: "/hr/admin/weekly-plans/calendar", icon: CalendarRange, label: "Planning Calendar", permissions: [{ resource: "weekly_plans", action: "read" }] },
    ],
    // Renamed from "Attendance" on 2026-09-01: with the Company Calendar visible to both seats and
    // the Planning Calendar added, two of the rows in here are calendars rather than attendance.
    label: "Attendance & Calendars",
    // Every row the Talent Acquisition seat sees here is a calendar and none is attendance, so the
    // heading says so for her (2026-10-16).
    labelByRole: { "HR Resourcing": "Calendars" },
  },
  {
    id: "hr-leave",
    items: [
      // ── 2026-09-05: this was the "Leave Management" row, pointing at /leave-management, the hub ─
      //
      // It was already excluded for HR Advisory (2026-08-29): leave administration appears NOWHERE in
      // the HR Business Partner job description — it is HR Operations' second area ("Maintain leave
      // balances and ensure approved leave is correctly recorded"). Advisory holds leave:[read,
      // create] for her OWN requests, which the "Request Vacation" row under My Requests serves, so
      // the row opened a hub listing 0 of 3 for her. Now the hub door is gone for everyone, per the
      // owner's 2026-09-05 rule, and the one card it offered that this list did not already carry is
      // written out instead — Vacation Control below was the second, and the third was the hub itself.
      { href: "/hr/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }], roles: ["HR Operations"] },
      { href: "/hr/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      // HR Operations only — the org-wide leave register. It lives in peopleManagementPageItems,
      // a hub this catalogue has no row for, so without this line the seat passes the gate
      // (companyVacationReportReaderRoles) and still cannot find the page.
      // Labelled "Company Vacation Report", the page's own hero, restored 2026-09-05. It was
      // shortened to "Vacation Report" because the full name measured 158px against the admin rail's
      // 157px budget; re-measured after the premium type pass it is 151px, so that reason is gone.
      // And it now has to be the full name: /hr/leave-management/vacation-report joined this same
      // section in that change and its own page is titled "Vacation Report", so two rows reading
      // "Vacation Report" in one section would be a pair nobody can tell apart from the rail. The
      // company-wide register is this one; the leave module's own report is the row above.
      { href: "/hr/admin/vacation-report", icon: FileSpreadsheet, label: "Company Vacation Report", permissions: [{ resource: "leave", action: "read" }], roles: ["HR Operations"] },
      // "Other Approvals" IS NOT ON THIS RAIL AT ALL — retired from /hr on 2026-09-01, in two steps
      // on the same day and for two DIFFERENT reasons, which is why it is written down.
      //
      //   HR Advisory  the inbox could never hold a row for her (#2842). It shows resignation,
      //                contract renewal and outstation; her composed matrix holds none of the
      //                three, and the row was offered on `leave:read` — the grant everyone has for
      //                their OWN vacation. An always-empty inbox carrying a pending badge.
      //   HR Operations  the owner asked for it off her rail while tidying the seat: "Remove other
      //                approvals from the sidebar." Hers was NEVER empty — she holds resignations
      //                and contracts at read/create/update/export — so no emptiness argument
      //                applies and re-deriving this from grants will get it wrong.
      //
      // With both seats gone the row served nobody in a namespace that exists for those two seats,
      // so it is deleted rather than excluded twice; tests/hr-url-namespace.test.ts enforces exactly
      // that ("no /hr row may be invisible to BOTH seats") and is what caught the half-measure.
      // The page is untouched: the ADMIN rail keeps /admin/approvals-hub, and the URL still works.
    ],
    label: "Leave Management",
  },
  {
    id: "hr-payroll",
    items: [
      // ── 2026-09-05: this was "Payroll Management", pointing at /admin/payroll-management, the hub ─
      //
      // It was already excluded for HR Advisory (2026-08-29): payroll appears NOWHERE in the HR
      // Business Partner job description, her Role Boundaries bar her from salary changes outright,
      // and payroll inputs and monthly closure are HR Operations' third area. She reached the row
      // through payslips:read — the grant that shows her HER OWN payslip — and the hub then listed
      // 0 of 7. Her own payslip is unaffected either way: that is the employee-portal path.
      //
      // The hub door is now gone per the owner's rule, and of the three cards HR Operations clears on
      // it, two (Payslips Center, Deductions) are already rows below. This is the third. Gate copied
      // from the card: payroll:read, which she holds with export and no write action.
      { href: "/hr/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }] },
      // Owner instruction 2026-09-01, and the only row in this change that needed NO permission
      // work at all: HR Operations was given payslips:[read, export] when the seat was composed,
      // and getPayrollScope was widened to return COMPANY for her on 2026-08-29 specifically so
      // this page would stop bouncing her. Both gates have admitted her for three days; nothing
      // ever linked the page, so the capability shipped and was reachable by nobody — the exact
      // shape AGENTS.md records as "granted, deployed, and reachable by NOBODY".
      //
      // excludedRoles: HR Advisory, for the same reason as the row above. Payroll appears nowhere
      // in the HR Business Partner job description, and her payslips:read is the grant that shows
      // her HER OWN payslip through the employee-portal path, which this row does not affect.
      { href: "/hr/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips", action: "read" }] },
      // Deductions, added 2026-09-03. This row did not exist between the C6 cutover (2026-08-30) and
      // that date, and the note left in its place explained why: the unified replacement
      // app/(admin)/admin/deductions/page.tsx gated on a hard-coded `VIEW_ROLES = {Super Admin, CEO}`
      // — a role set, not a permission — so a row offered on `deductions:read` would have been
      // admitted by this catalogue and then refused by the page. A dead link, which is worse than no
      // link. The note said widening VIEW_ROLES was the owner's call; he made it on 2026-09-03,
      // asked because the employee-comment thread now mails HR and the link in that mail bounced.
      //
      // excludedRoles: HR Advisory, for the same reason as the two rows above — payroll appears
      // nowhere in the HR Business Partner job description. It is belt-and-braces here rather than
      // the gate: she does not hold `deductions:read` at all (payroll_inputs is in the HR Operations
      // bundle alone), so the permission would refuse her first. Named anyway, so that a future
      // widening of her grant for some other surface cannot quietly hand her this one.
      //
      // What she sees is bounded by the page: READ ONLY, and no download. Her grant is
      // deductions:["read"] with no `export`, so /api/admin/deductions/export refuses her while the
      // screen renders — the same split the owner set for her payslips on 2026-09-01, figures on
      // screen and no document out of the building. No decision control renders (canDecide is Super
      // Admin alone) and every mutating route asserts deductions:approve or deductions:create,
      // which HR_ROLE_BOUNDARIES pins ABSENT from both seats. Her HR command center keeps its
      // read-only deduction count tiles; this row is the drill-through those tiles never had.
      { href: "/hr/admin/deductions", icon: ReceiptText, label: "Deductions", permissions: [{ resource: "deductions", action: "read" }] },

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
      // The Talent Acquisition seat (2026-10-08) — ticked for her by the owner, see the note under
      // Employee Requests. The tracker row above is fenced for her (src/lib/auth/seat-page-fences.ts), so the hub
      // takes the label "Probation" it carries in the admin catalogue without two rows reading alike.
      { href: "/hr/probation/analytics", icon: Activity, label: "Probation Analytics", permissions: [{ resource: "probation", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/admin/ceo-probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
    ],
    label: "Probation",
  },
  {
    id: "hr-performance",
    items: [
      // The coaching grant is real and JD-traced (performance follow-up), so the page is listed
      // rather than left reachable-but-hidden.
      { href: "/hr/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      // Coaching Analytics was deliberately NOT here until 2026-09-01 — this note read "the Field
      // Coaching HUB and Coaching Analytics are the SFE Manager's sales-management surfaces". The
      // owner named the page explicitly, had that earlier decision put back to him, and reversed
      // it. The grant was always hers (coaching:read, via performance_probation) and the page's own
      // gate admits her; only the link was missing.
      { href: "/hr/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
      // The Talent Acquisition seat (2026-10-08) — the owner's answers in chat on 2026-10-08: KPIs on the CRM visit read, Spotlight
      // and Milestones on the recognition function (src/lib/auth/hr-functions.ts).
      { href: "/hr/admin/kpis", icon: TrendingUp, label: "KPIs", permissions: [{ resource: "crm_visits", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      // KPIs lead her rows (2026-10-16): the performance read first, then the recognition boards.
      // The Talent Acquisition seat (2026-10-08) — ticked for her by the owner, see the note under
      // Employee Requests. Read only: confirming a fortnight stays with each District Manager.
      { href: "/hr/admin/early-birds", icon: Sunrise, label: "Early Birds", permissions: [{ resource: "early_birds", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/admin/ranks", icon: Medal, label: "Phoenix Ranks", permissions: [{ resource: "early_birds", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/spotlight", icon: Trophy, label: "Spotlight", permissions: [{ resource: "spotlight", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/milestones", icon: Award, label: "Milestones", permissions: [{ resource: "milestones", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
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
      // The Talent Acquisition seat (2026-10-08) — ticked for her by the owner, see the note under
      // Employee Requests. Her OWN workspace and punches; the company Fingerprint Report row is fenced for her,
      // so this one reads "Fingerprint Report" as it does for the Finance Manager.
      { href: "/hr/workspace", icon: Briefcase, label: "My Workspace", permissions: [{ resource: "employee_profile" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/workspace/leave-management/vacation-request", icon: CalendarCheck, label: "Request Vacation", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/hr/workspace/excuses", icon: Clock, label: "Submit Excuse" },
      { href: "/hr/workspace/fingerprint-report", icon: Fingerprint, label: "Fingerprint Report", permissions: [{ resource: "attendance", action: "read" }], roles: ["HR Resourcing"], excludedRoles: ["Super Admin"] },
      { href: "/hr/admin/report-it/new", icon: ShieldAlert, label: "Report It" },
    ],
    label: "My Requests",
  },
] as const satisfies readonly NavigationSectionSeed[];

// `adminNavigationSections` is NOT declared here. It is built at the bottom of this file by
// `promoteHubRows`, which needs the `*PageItems` arrays — all of which are declared below this
// point. Declaring it here would read those in their temporal dead zone: a ReferenceError at
// module load, with a green typecheck.
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
    // card from being offered to someone who would be redirected straight past it. Its gate is
    // `territory` read, NOT `sales:import` like the mapping cards around it — a narrower key than
    // its neighbours, which is correct and must not be "tidied" into line with them. It read
    // `sales` until 2026-09-07; the resource was split out then so the map could reach the HR
    // Business Partner without the money pages, and it grants these three roles exactly what they
    // had before.
    href: "/sales/territory-management",
    icon: Waypoints,
    label: "Territory Management",
    description: "Bricks, areas and territory coverage.",
    // HR Advisory (the HR Business Partner) was on this list from 2026-09-07 until the owner retired
    // the seat on 2026-10-08.
    permissions: [{ resource: "territory" }],
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
    href: "/admin/distribution-lists",
    icon: Users,
    label: "Distribution Lists",
    description: "Named recipient groups resolved from the live directory, and the register of company email aliases on Turbify.",
    // The HR Business Partner sees only the HR-owned lists — that narrowing lives in
    // @/lib/distribution-lists/access, not here. A nav entry decides whether the link is offered,
    // never what is behind it.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/sato-email",
    icon: Mail,
    label: "Sato Email Composer",
    description:
      "Write an email to a distribution list or to named colleagues, from a fixed template or in your own words, in the company's identity.",
    // Both seats, gated by @/lib/sato-email/access. ⚠ This entry is INERT for the HR Business
    // Partner: an HR seat renders the `hr` shell and app-shell.tsx redirects a bare /admin/… address
    // into /hr/admin/…, so her row is the /hr/admin/sato-email one in hrNavigationSections. Listing
    // her here offers the card in the Admin Tools hub and the admin command palette, both of which
    // she does not render — it is kept so the two lists agree about who the module is for.
    roles: ["Super Admin"],
  },
  {
    href: "/admin/ceo-email",
    icon: PenLine,
    label: "CEO Email Composer",
    description:
      "Write a letter from the chief executive to a distribution list or to named colleagues — typed, dictated in any language, or built from a document — on the chief executive's own letterhead and signature.",
    // The CEO and the Super Admin, gated by @/lib/ceo-email/access. Unlike the Sato composer's row
    // above, this one is INERT FOR NOBODY: resolveNavigationMode pins the CEO to the admin shell, so
    // both seats render this exact address and there is no /hr twin to keep in step.
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
    // Owner 2026-09-11: Super Admin only. This is a COMPANY-WIDE log naming the subject and the
    // recipient of every mail the system sends, payroll and resignation and offer mail included.
    // It was Super-Admin-only by ACCIDENT until `hr_communication` gave a second seat
    // `communication`. The PAGE carries the same check — this row only stops the sidebar offering
    // a link that redirects. `roles` ANDs with `permissions` in the gate, so this narrows.
    permissions: [{ resource: "communication" }],
    roles: ["Super Admin"],
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
    href: "/admin/test-accounts",
    icon: UserCog,
    label: "Test Accounts",
    description: "Your own logins that live inside a real person's employee portal and never save as them.",
    roles: ["Super Admin"],
  },
  {
    href: "/admin/screening-questions",
    icon: ListChecks,
    label: "WhatsApp Screening Questions",
    description: "Add, reorder or retire the extra questions the CV-intake bot asks after the fixed six.",
    roles: ["Super Admin", "HR Resourcing"],
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
    href: "/sales/weekly/stock",
    icon: Package,
    label: "Weekly Stock",
    description: "Stock on hand per product at every branch, with weeks of cover, filters and export.",
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
    // Owner, 2026-09-21: the SFE Manager sees it VIEW ONLY. The button that writes a pharmacy into
    // Direct Orders stays Super Admin only (2026-08-22) — enforced in the service, not here.
    roles: ["SFE Manager", "Super Admin"],
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
    // TWO clauses, OR'd, and the second one is not decoration. The page's real gate is
    // canAccessFingerprintReport — "CEO, or employees:read" — a page-scoped exception to the
    // employees hard boundary, and the CEO holds attendance:read but NOT employees:read. This card
    // therefore under-described its own page, and the attendance hub page papered over the gap by
    // special-casing this href against the helper instead of the card.
    //
    // That was survivable while the card was only ever rendered by that page. On 2026-09-05 the
    // owner removed every rail row that opens a page of modules, so this card became a SIDEBAR ROW,
    // where nothing bridges the difference — and the CEO silently lost his only route to a report he
    // is explicitly allowed to open. attendance:read is what he holds, so it is the clause that
    // makes the row honest; `roles` still keeps the pair to the three seats named below.
    permissions: [{ resource: "employees" }, { resource: "attendance", action: "read" }],
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
    href: "/attendance/weekly-review",
    icon: CalendarCheck,
    label: "Weekly Attendance Review",
    description:
      "Pick a week — it shows its flagged days up to yesterday — tick the days to deduct and set their days, then release the days so far at any time; unticked days are cleared, and nothing reaches an employee until it is released here.",
    permissions: [{ resource: "attendance", action: "read" }],
    // The page and its APIs gate again on canReviewDisputes (Super Admin or the configured
    // reviewer list); ticking days, refreshing a week and releasing it are the Super Admin's
    // alone (canManageWeeklyReview). This row only decides who SEES the link.
    roles: systemAdministratorNavigationRoles,
  },
  {
    href: "/attendance/disputes",
    icon: Fingerprint,
    label: "Attendance Disputes",
    description:
      "Days an employee says are wrong in their weekly digest, with the leave and CRM evidence for each one. A disputed day never settles until it is decided here.",
    permissions: [{ resource: "attendance", action: "read" }],
    // The page itself gates again on canReviewDisputes (Super Admin or the configured
    // reviewer list) and redirects otherwise — this row only decides who SEES the link.
    // system-navigation hiding a link is UX; the page-level check is the boundary.
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
    roles: ["Super Admin", "HR Operations"],
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
    // Both HR seats added 2026-09-01: HR Operations by owner instruction, HR Advisory in the
    // seventeen-module change the same day. The /hr namespace may only NARROW this registry
    // (tests/hr-url-namespace.test.ts), so a seat must appear HERE before it can have a row.
    roles: ["CEO", "Super Admin", "HR Operations"],
  },
  {
    href: "/hr-calendar",
    icon: CalendarDays,
    // "HR Calendar", not "Company Calendar" (2026-09-05). It carried the longer name and was
    // shortened only on the RAIL, through HUB_ROW_RAIL_LABELS; that entry is gone because the
    // card now says the same thing in both places. It had to move: /admin/company-calendar took
    // the name "Company Calendar" in the same change, and two cards reading identically on one
    // hub page is the defect tests/sidebar-rows-read-uniquely.test.ts catches on the rail and
    // nothing catches here.
    label: "HR Calendar",
    description: "Company-wide events, holidays, and leave calendar.",
    permissions: [{ resource: "hr_calendar" }],
  },
  {
    href: "/admin/company-calendar",
    icon: CalendarDays,
    label: "Company Calendar",
    description: "Admin host of the portal events calendar — events, holidays, leave, and birthdays.",
    permissions: [{ resource: "attendance", action: "read" }],
    // HR Resourcing (the Talent Acquisition seat), read only, since 2026-10-08.
    roles: ["Super Admin", "HR Resourcing"],
  },
  {
    href: "/admin/private-calendars",
    icon: CalendarDays,
    label: "Private Calendars",
    description: "Executive private calendar management.",
    permissions: [{ resource: "attendance", action: "read" }],
    // HR Resourcing (the Talent Acquisition seat) since 2026-10-08.
    roles: ["CEO", "Super Admin", "HR Resourcing"],
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
    // HR Operations was excluded here 2026-08-29 and is admitted again 2026-09-03. The exclusion was
    // never about her authority: her seat has held deductions:read since it was composed, so this
    // card already admitted her, but app/(admin)/admin/deductions/page.tsx gated on a hard-coded
    // {Super Admin, CEO} and bounced her to /employee-portals — a dead link, so the row went. The
    // note left with it said widening VIEW_ROLES was the owner's call. He made it, in these words:
    // "yes give HR access to the deductions screen." The page now names her, so the link resolves
    // and the card is honest again. She READS ONLY: her grant carries no `export`, so this route's
    // sibling /api/admin/deductions/export still refuses her, as does every mutating route and every
    // control on the page (see the page's own note). The Finance Manager above is the opposite case
    // — he holds read AND export, and lost the screen.
    //
    // HR Advisory is NOT admitted, and deductions:read is why she never was — she does not hold it.
    // The seats compose differently: payroll_inputs is in the HR Operations bundle alone.
    excludedRoles: ["Finance Manager"],
  },
  {
    href: "/admin/daily-deductions",
    icon: ReceiptText,
    label: "Daily Deductions",
    description: "Count deductions day by day over any date range and publish a running tally on demand — for the payroll sheet finalized before month-end. A reviewed reporting snapshot; it feeds no salary run.",
    permissions: [{ resource: "deductions", action: "read" }],
    // Gate copied verbatim from the month Deductions card above — the two are two views of the same
    // money and admit the same audience. The page enforces the same {Super Admin, CEO, HR Operations}
    // VIEW_ROLES set, so this card's audience and the page's gate agree (the drift the note above
    // warns about is exactly what this mirrors to avoid). Finance Manager excluded by name for the
    // same reason: deductions:read admits him but the owner revoked the reporting screens.
    excludedRoles: ["Finance Manager"],
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
    href: "/admin/market-awareness",
    icon: Sparkles,
    label: "Market Awareness",
    description: "Conferences, round tables and speaker programmes raised by the product managers, with the brick and area sales that follow them.",
    permissions: [{ resource: "market_awareness", action: "read" }],
    roles: ["Super Admin", "CEO", "Marketing Manager", "Group Product Manager", "Finance Manager"],
  },
  {
    href: "/admin/visual-aids",
    icon: Presentation,
    label: "Visual Aids",
    description: "The flyers and visual aids reps show doctors on their tablets — upload one against a line, retire it, or replace it with a newer version.",
    permissions: [{ resource: "visual_aids", action: "update" }],
    roles: ["Super Admin", "Marketing Manager", "Group Product Manager"],
  },
  {
    href: "/admin/marketing-requests/roi-tracking",
    icon: ChartColumnBig,
    label: "ROI Tracking",
    description: "Read-only executive report to filter and audit individual marketing requests.",
    roles: ["Super Admin"],
  },
  // Owner instruction, 2026-10-09: "you will make a new tab in the sidebar … this report will
  // list all the managers who did marketing requests, approved marketing requests, and show the
  // total … the total value of the total request … the sum of the total ROI … the sum of the
  // actual that gained until now." Roles mirror the Coverage Report's row rather than ROI
  // Tracking's Super-Admin-only one: the CEO and the SFE Manager are exactly the seats that read
  // spend per manager. The PAGE gate is wider (assertMarketingAdminPageAccess with company
  // oversight) — this is the discoverability list, not the door.
  {
    href: "/admin/marketing-requests/manager-scorecard",
    icon: Users,
    label: "Manager Scorecard",
    description: "Marketing spend per manager: requests raised and approved, their value, the forecast ROI, and the sales that have actually come back.",
    roles: ["Super Admin", "CEO", "SFE Manager"],
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
    // `recruitment`, not `vacancies` — this card opens the candidate pool, and the page's own gate
    // asserts recruitment:read (app/(admin)/cv-database/page.tsx carries the reasoning and the
    // measurement). Naming the same resource here is what keeps card and page agreeing with nothing
    // to maintain: HR Operations holds vacancies:read for the Vacancies Report and no recruitment at
    // all, so she drops off this card BY GRANT rather than by an excludedRoles list — which is what
    // sat here for part of 2026-09-01 and hid the card while leaving the URL open.
    // tests/recruitment-hub-portal-coverage.test.ts pins the rule this protects: she may clear the
    // two SHARED hiring-paperwork cards and no recruiting one.
    permissions: [{ resource: "recruitment" }],
    roles: hrAuthorityNavigationRoles,
  },
  // NO "CV Lookup" CARD HERE, and the omission is the point. The screen exists for HR Operations
  // (owner, 2026-09-30) and its card lives under "People Management" instead, beside Employees:
  // "Recruitment & Hiring" is a heading that announces a function this seat does not hold, which is
  // the wrong-label defect the CV Database boundary rule exists to stop. Moving it here to sit
  // beside the CV Database would also have handed her a card in a recruiting hub, which
  // tests/recruitment-hub-portal-coverage.test.ts pins against.
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
    href: "/business-cards",
    icon: IdCard,
    label: "Business Cards",
    description: "Print-ready Sato Pharma business cards for any employees — one PDF for all, or one per person.",
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
  {
    // CV Lookup — the search-only CV access the owner asked for on 2026-09-30. Under PEOPLE
    // MANAGEMENT and not "Recruitment & Hiring", which is where the CV Database sits: the seat this
    // exists for holds no recruiting function, and a heading that says she does is the wrong-label
    // defect tests/cv-database-recruiting-boundary.test.ts exists to stop. Her sidebar row is in the
    // HR rail's own "People" section for the same reason.
    //
    // 🔴 THIS CARD IS LOAD-BEARING FOR EXACTLY THE REASON WRITTEN ON THE `/employees` CARD ABOVE,
    // and it was learned the same way — by CI, not by reading. It first shipped in the recruiting
    // list restricted to the Super Admin, and `validate` went red: `tests/hr-url-namespace.test.ts`
    // derives each HR seat's admin closure from THESE lists and requires every `/hr` row to point
    // inside one, so `/hr/cv-lookup -> /cv-lookup` read as "a page neither seat's permissions admit"
    // — the namespace inventing access rather than mirroring it. The card is the grant; the `/hr`
    // row is the mirror. Narrow this card's audience and her own screen becomes a widening.
    //
    // It is also what makes the bare `/cv-lookup` an OFFERED link rather than one reachable only by
    // typing it (tests/navigation-granted-but-unreachable.test.ts).
    href: "/cv-lookup",
    icon: FileSearch,
    label: "CV Lookup",
    description: "Search the CV database and open only the candidates the search returns.",
    permissions: [{ resource: "cv_lookup" }],
    // Named rather than left to the permission alone, the same style as Employees above: only these
    // two hold `cv_lookup` today, so this changes nothing now and keeps the audience a decision.
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
    href: "/mailbox-offboarding",
    icon: MailX,
    label: "Mailbox Revocation",
    description: "Every leaver still holding a company mailbox, and what has been done about it.",
    permissions: [{ resource: "mailbox_offboarding" }],
  },
  {
    href: "/new-hire-mailboxes",
    icon: MailPlus,
    label: "New Hire Mailboxes",
    description: "Every new hire waiting for a company email, and the app password that connects it.",
    permissions: [{ resource: "mailbox_offboarding" }],
  },
  {
    href: "/devices",
    icon: Laptop,
    label: "Device Custody",
    description: "Every laptop, tablet and phone the company owns, and who signed for it.",
    permissions: [{ resource: "company_devices" }],
  },
  // 🔴 `action: "approve"` is the whole point of this card, not decoration. Device Custody above is
  // paperwork and HR Operations runs it; this one publishes software onto every rep's tablet, and
  // `approve` is the only action on this resource the matrix reserves to the Super Admin. That is
  // also why it is HERE and not in the /hr rail beside Device Custody: neither HR seat can open the
  // page, and an /hr row reaching a page no HR seat is admitted to is a dead row — the thing
  // tests/hr-url-namespace.test.ts refuses. The page and all three route handlers assert the same
  // permission.
  {
    href: "/devices/managed-play",
    icon: Store,
    label: "Managed Google Play",
    description: "Approve which apps the company tablets are allowed to run.",
    permissions: [{ resource: "company_devices", action: "approve" }],
  },
  // Same gate, same reason, same rail as Managed Google Play: the rules on this page reach every
  // enrolled rep tablet at once, and an enrollment code brings a new tablet under them.
  {
    href: "/devices/tablets",
    icon: Tablet,
    label: "Rep Tablets",
    description: "Enroll a company tablet with a QR code and set the rules every rep tablet follows.",
    permissions: [{ resource: "company_devices", action: "approve" }],
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
  {
    href: "/admin/business-card-requests",
    icon: IdCard,
    label: "Business Card Requests",
    description: "Employee business-card print requests, worked through by HR.",
    permissions: [{ resource: "business_card_requests" }],
    roles: hrAuthorityNavigationRoles,
  },
] as const satisfies readonly AdminToolsPageItem[];

// ── Outstation Expenses hub (app/(admin)/admin/outstation-expenses/page.tsx) ────
// The tools formerly listed individually under the admin sidebar's "Outstation
// Expenses" section (see adminNavigationSectionSeeds above, now collapsed to
// one link). Expense Requests / Add Manual Expense are query-string views of
// the same Expense Command Center page, preserved exactly as before.
export const outstationExpensesPageItems: readonly AdminToolsPageItem[] = [
  // EXPENSE APPROVALS LEFT THIS HUB ON 2026-10-08 for the "Approvals Hub" band in
  // adminNavigationSectionSeeds (owner: every approval queue under one heading). It is a seed row
  // there now, gated with this card's own net effect — `expenses` AND Super Admin — so nobody
  // gained or lost the route; the card is gone from here rather than duplicated, because
  // promoteHubRows would otherwise put a second "Expense Approvals" row on the same rail.
  // Its href also left the "Expense Desk" split below, which would simply have stopped matching.
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
    // Named for the page, not the module. This card sits INSIDE the Outstation Expenses hub and
    // used to be labelled "Outstation Expenses" too, so the hub door and the dashboard read as
    // one destination in Cmd+K and as the same words twice on the hub page. The page's own
    // header is "Outstation Expenses Dashboard"; the siblings here drop the module prefix
    // ("Expense Approvals", "Expense Command Center", "Expense Requests"), so this follows them.
    label: "Expenses Dashboard",
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
    // Named for the page, not the module — same reason as Expenses Dashboard above. The hub door
    // (/admin/field-coaching) is the one that keeps the module name "Field Coaching"; this is the
    // evaluations list inside it, and it reads beside "Coaching Analytics" in the same hub.
    label: "Coaching Evaluations",
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
    // Both HR seats added 2026-09-01, same reason as the Planning Calendar above. The page's
    // own gate, canViewAllProbation, already named both by role — this closes the gap between
    // a page that let them in and a registry that never offered it.
    roles: ["Super Admin", "Training Manager", "Marketing Manager", "SFE Manager", "HR Operations"],
  },
  {
    href: "/probation/analytics",
    icon: Activity,
    label: "Probation Analytics",
    description: "Outcome and scoring analytics across probation cases.",
    permissions: [{ resource: "probation", action: "read" }],
    // HR Resourcing (the Talent Acquisition seat) since 2026-10-08 — canViewProbationAnalytics admits her.
    roles: ["Super Admin", "Training Manager", "Marketing Manager", "SFE Manager", "HR Resourcing"],
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
    // Field Activity, the ADMIN half. The other five roles in FIELD_ACTIVITY_ROLES are PORTAL
    // seats and reach /employee-portals/field-activity instead — the (admin) layout bounces them
    // out of this shell before any page in it runs, which is how the module shipped invisible to
    // them in #4647.
    //
    // 🔴 A CARD ON THIS HUB, NOT A ROW IN A SEED SECTION. `promoteHubRows` replaces a hub door with
    // its bands and keeps the section id, so a plain row left beside one ends up in a section whose
    // id the promoted band ALSO uses — and `groupAdminSections` keys its map by id, so one of the
    // two is silently overwritten and its rows stop being drawn. Both `crm` and `field-coaching`
    // behave this way; tests/sidebar-domains caught each attempt as "197 rows in, 196 out".
    href: "/admin/field-activity",
    icon: MapPinned,
    label: "Field Activity",
    description: "One person's field days end to end: every stop, its GPS, the door clock against the log clock, and the outstation claim behind them.",
    permissions: [{ resource: "double_visit_analytics", action: "read" }],
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
      "Which Source-of-Sales bricks each rep actually reaches, against the bricks that carry their sales — weighted by selling units, with the blind spots named.",
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
      "Filter to a line, region and area, then open a rep to see their whole CRM contact list grouped by the brick each contact sits in, their weekly plans, and their call rate against two AM and ten PM a day.",
    roles: ["Super Admin", "CEO", "National Sales Manager", "SFE Manager", "Regional Manager", "District Manager"],
  },
  {
    // KPIs — the owner's three field measures on one board, ordered 2026-09-02. It REPLACES the
    // Doctor Coverage card that stood in this group until 2026-08-28 ("rebuild from the beginning"),
    // and it adds no fourth measure: call rate, coverage and frequency were each already computed,
    // by three modules that had no single door.
    //
    // ADMIN-MODE ROLES ONLY, exactly as the retired card was. Every other role with a seat — Medical
    // Rep, DM, RM, NSM, PM, GPM, Marketing Manager — reaches the identical board through the portal
    // twin at /employee-portals/kpis, because app/(admin)/layout.tsx redirects them out of this
    // shell before this page's own gate could run.
    //
    // The enforcing gate is canSeeDoctorCoverage plus crm_visits:read, both asked by the page, and
    // getDoctorCoverageScope decides whose reps the viewer sees. This list is UX only.
    href: "/admin/kpis",
    icon: TrendingUp,
    label: "KPIs",
    description:
      "Call rate, coverage and frequency per rep for any month or week — the visits each rep made over their own working days, how much of their monthly plan they have reached, and whether they hit the visit count they planned per doctor.",
    // HR Resourcing (the Talent Acquisition seat) since 2026-10-08, the owner's answers in chat on 2026-10-08.
    roles: ["Super Admin", "SFE Manager", "CEO", "HR Resourcing"],
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
    // Doctor lists maintained in Phoenix (CRM phase 7, owner 2026-09-14: "Rep asks, DM approves, SFE and
    // system admin can edit, add or delete"). The editing half: the SFE Manager and the administrator
    // add, remove or re-grade a doctor on any rep's list directly. Reps and managers use the portal twin.
    // NOT the retired "Rep Doctor Lists" board under a new name — that one scored plans; this one edits
    // the list itself. The enforcing gate is crm_contact_lists `update` inside the service.
    href: "/admin/doctor-list-changes",
    icon: ListChecks,
    label: "Doctor List Changes",
    description: "Add a doctor to a rep's AM or PM list, remove one or change a grade — applied at once — and see the requests still waiting for a manager.",
    permissions: [{ resource: "crm_contact_lists", action: "update" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // Phoenix CRM (the owner, 2026-09-16): the field force's customer lists with their timings, weekly
    // plans, visits and reports, built clean in Phoenix. It took over this card from the 2026-09-14
    // pilot, whose link the owner asked to hide when this module shipped; the pilot's pages still
    // serve by typed address until it is removed after go-live. The admin-shell holders of
    // phoenix_crm read are these four; reps and their managers open it from My Visits. The enforcing
    // gate is phoenix_crm inside the page and every /api/phoenix-crm route.
    //
    // The Training Manager joined them on 2026-09-22, with the matrix grant he was promised that day
    // and never got. He opens the card for the Doctors directory ALONE: `territoryForRead` refuses
    // him every territory, so the list is where he stops — the owner's ruling, "The list is enough
    // for him", not a gap to close.
    href: "/admin/field-crm",
    icon: ClipboardList,
    label: "Phoenix CRM",
    description: "Customer lists with their timings, weekly plans, visits and reports, entered in Phoenix.",
    permissions: [{ resource: "phoenix_crm", action: "read" }],
    roles: ["Super Admin", "CEO", "SFE Manager", "Training Manager"],
  },
  {
    // 🔒 THE NAME STAYS "Location Integrity" — owner decision, 2026-09-27, asked directly once the
    // board had grown past its name and answered in three words: "keep the name Location integrity".
    // It now carries three kinds of case, not one: the position, the nightly photo sweep (D5) and
    // the per-rep-per-month behaviour pass (D4). Do NOT re-propose a rename when a fourth detector
    // lands, or as tidying — widen this description instead. The label is also pinned in
    // tests/fixtures/sidebar-label-widths.json, so a rename drags a fixture regeneration with it.
    //
    // Location integrity (the owner, 2026-09-25): the captures whose GPS the server could not
    // believe — a mock-location app the phone admitted to, a coordinate used before, a trip nobody
    // could have made. Nothing to confuse with /admin/crm-integrity above, which is the iReports360
    // vendor feed's data quality; this one is about whether a rep was where he said he was.
    //
    // THE SUPER ADMIN'S AND THE SFE MANAGER'S (owner, 2026-09-26, Golden Rule #1: "every violation
    // is then recorded in the admin and the SFE account"). The narrow role list is still the point
    // rather than tidiness: the rep is never told he was flagged — his own app shows nothing at all —
    // so the fewer people who can open the board, the longer it keeps working. The enforcing gate is
    // `canReadIntegrityBoard` inside the service AND the page; this card only draws the link. There
    // is no API route to gate any more: it had no caller and was deleted the same day. Inside the
    // board, the POSITION cases are the Super Admin's alone since 2026-10-02 (`readsPositionCases`):
    // the SFE Manager reads the photo cases and the behaviour months.
    href: "/admin/phoenix-crm/integrity",
    icon: ShieldAlert,
    label: "Location Integrity",
    description: "Visits and validated places that do not hold up — the position, the photograph, and the shape of a rep's month. Checked without anyone being told, shown to no rep.",
    permissions: [{ resource: "phoenix_crm", action: "read" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // One doctor, two rows — the SFE's housekeeping list (the owner, 2026-10-02: "show the
    // same-rep duplicate customers to the SFE").
    //
    // 🔴 THE SAME TWO READERS AS THE BOARD ABOVE, AND DELIBERATELY NOT THE SAME CARD. A duplicate
    // is a typing mistake, not a suspicion, and a rep filed under "Location Integrity" for
    // entering a name twice would be accused of something he did not do. The wording here is
    // housekeeping throughout; the gate is `canReadDuplicateCustomers` inside the page (its own since
    // 2026-10-02, when the board split), and this card only draws the link.
    href: "/admin/phoenix-crm/duplicates",
    icon: CopyCheck,
    label: "Duplicate Customers",
    description: "Where one rep's own list holds the same doctor twice. Housekeeping rather than a flag — nobody is accused, and the rep is never shown it.",
    permissions: [{ resource: "phoenix_crm", action: "read" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // The Visit report generator (owner, 2026-10-15): pick a rep or a district and a period, choose the
    // fields, and read a dashboard, a map and every visit — or download the same choice as one workbook
    // tab. The Super Admin's and the SFE Manager's; the enforcing gate is `canReadVisitReport` inside the
    // page AND the loader, and this card only draws the link. It shows where named people's phones were,
    // so it is a page of its own under /admin that a rep cannot open, never a tab the field app renders.
    // The SFE Manager is offered every field except the mock-location evidence.
    href: "/admin/phoenix-crm/visit-report",
    icon: ClipboardList,
    label: "Visit Report",
    description: "Pick a rep or a district and a period, choose the visit fields you want, and get a dashboard, a map and an Excel file built from exactly that choice. Shown to no rep.",
    permissions: [{ resource: "phoenix_crm", action: "read" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // Captures Phoenix CRM turned away on their LOCATION, and whether the rep got through afterwards
    // (owner, 2026-10-03: "build the refused readings view for the SFE").
    //
    // 🔴 HOUSEKEEPING, NOT A FLAG, AND DELIBERATELY NOT UNDER LOCATION INTEGRITY. The rep read the
    // refusal on his own screen when it happened; the question here is who is stuck and can the SFE
    // help, so a rep turned away eighteen times for a rough GPS fix is never filed beside a mock-location
    // case. The same two readers as the integrity board; the enforcing gate is `canReadRefusedReadings`
    // inside the service AND the page, and this card only draws the link. The mock-location answer
    // inside it is the Super Admin's alone (`readsMockAnswer`).
    href: "/admin/phoenix-crm/refused-readings",
    icon: MapPinOff,
    label: "Refused Readings",
    description: "Reps whose phone was turned away for a missing or rough location, and whether each got through afterwards. Housekeeping rather than a flag — nobody is accused, and the rep is never shown it.",
    permissions: [{ resource: "phoenix_crm", action: "read" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // Places the Google Maps check could not confirm (owner, 2026-10-03: "held for review and only
    // system admin can approve or reject"). The Super Admin's ALONE — not the SFE Manager — and the
    // enforcing gate is `canDecideValidationReviews` inside the page and the route; this card only draws
    // the link. The rep reads the outcome as the system's, never a person's.
    href: "/admin/field-crm/validation-reviews",
    icon: MapPinCheck,
    label: "Place Checks",
    description: "Validations Google Maps had no listing for. Each waits for you to approve or reject; the rep is told only that the system is checking.",
    permissions: [{ resource: "phoenix_crm", action: "update" }],
    roles: ["Super Admin"],
  },
  {
    // Every tap, press and keystroke on Phoenix CRM (owner, 2026-10-03: "every single thing is saved,
    // even if the rep didn't save it"), read a day at a time. The Super Admin's ALONE and for two
    // reasons: it records every pair of hands on the module including a manager's, and it keeps what a
    // rep typed and then deleted. `canReadTouchTrail` is the enforcing gate inside the page; this card
    // only draws the link, and the rep is never shown that the trail exists.
    href: "/admin/field-crm/touch-trail",
    icon: Fingerprint,
    label: "Touch Trail",
    description: "Every tap, press and keystroke on Phoenix CRM, grouped into the page loads that made the day — including what a rep typed and then deleted.",
    permissions: [{ resource: "phoenix_crm", action: "update" }],
    roles: ["Super Admin"],
  },
  {
    // Load a territory's customer list from a sheet — the SFE's third route onto a list (the owner's
    // ask, 2026-10-02): he sends the rep a sheet, the rep fills it in, he uploads it.
    //
    // 🔴 A CARD, NOT A BACKLOG ROW, FOR THE REASON THE CUSTOMER LINKS CARD BELOW RECORDS.
    // `tests/navigation-granted-but-unreachable` caught this page the moment it shipped, and the fix
    // for a page the owner asked for is the link — recording it as unreachable would silence a true
    // report about a screen whose two readers would otherwise have to type the address.
    //
    // `approve`, not `read` and not `update`: it writes a whole list at once WITH the grades, which on
    // the ordinary path is the district manager's decision and SFE's approval taken one customer at a
    // time — and `approve` is the verb the SFE Manager actually holds (`phoenix_crm: ["read",
    // "approve"]`), so naming him against `update` would have granted him nothing anywhere. That is
    // exactly what tests/nav-roles-name-only-permission-holders caught. Same verb as moving a place.
    href: "/admin/phoenix-crm/list-template",
    icon: ClipboardList,
    label: "Load a Customer List",
    description: "Send a rep a sheet for their territory and load their list back from it. Each customer lands under To validate for them to validate at the clinic — the one part no sheet can carry.",
    permissions: [{ resource: "phoenix_crm", action: "approve" }],
    roles: ["Super Admin", "SFE Manager"],
  },
  {
    // Customer Links — Wave 2's review screen, and the door to the 360 view behind it (the owner,
    // 2026-09-30: the system suggests links and the Super Admin confirms each one).
    //
    // 🔴 A CARD, NOT A BACKLOG ROW. `tests/navigation-granted-but-unreachable` caught this page as
    // an orphan the day it shipped: its only inbound link was the back-link on its own 360 view, so
    // the one role that can open it had no way in that did not start with typing the address. That
    // is the finding the guard exists to surface, and the fix is the link — recording it in
    // tests/navigation-reachability-backlog.ts would have silenced a true report about a screen the
    // owner asked for and could not reach.
    //
    // PERMISSION ALONE, no role list: `customer_identity` is granted to the Super Admin and nobody
    // else, so naming him here too would be a second copy of that decision to keep in step. The
    // enforcing gates are the page's own `canAccess(access, "customer_identity", "read")` and
    // `assertPermission` on both /api/customer-identity routes; this card only draws the link.
    href: "/admin/customer-links",
    icon: Link2,
    label: "Customer Links",
    description:
      "Who is the same person across Phoenix CRM, marketing and direct orders — the system proposes, you confirm each one, and nothing is ever merged or moved.",
    permissions: [{ resource: "customer_identity", action: "read" }],
  },
  // Reps Plans had its own card here until 2026-09-21, when the owner merged it into Reps List
  // ("merge the 2 modules into 1 module WHICH REPS LIST"). The board is now the Call rate tab of the
  // Reps List card above, still behind canAccessRepsPlans plus crm_visits:read, and /admin/reps-plans
  // forwards to it.
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
    // Super Admin decides every claim; SFE Manager decides distributor-invoice claims (owner,
    // 2026-09-14) and the service narrows their desk to those. Anyone else would only reach a 403.
    roles: ["Super Admin", "SFE Manager"],
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
    href: "/admin/direct-orders/returned",
    icon: Undo2,
    label: "Returned Ageing",
    description: "Orders sent back to a rep and never answered — no expiry clock, so they age until somebody looks.",
    permissions: [{ resource: "direct_orders", action: "read" }],
    // Same gate as the Held Desk beside it, and for the same reason: the service is System Admin
    // only, so a wider link would lead to a redirect rather than a page.
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
  // Sales Analytics has no group. Ruling 11 — "no analytics module, no sales analytics" — delisted
  // the module, and a group here was the last thing still offering its dashboards, via Cmd+K. The
  // owner then retired the module itself on 2026-09-17: its pages are deleted and next.config.ts
  // redirects their addresses, pinned by tests/sales-analytics-retired.test.ts.
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

// ── Hub rows promoted into the rail (owner, 2026-09-05) ─────────────────────────
//
// The owner's rule, in his words: "I don't want any subtitle to be the one that when I
// press, it redirects me to a page that has big modules. I want a Recruitment and its
// modules under it." So every sidebar row that opened a hub PAGE is gone, replaced by
// that hub's own modules under a heading carrying the hub's name.
//
// WHY THIS LIVES AT THE BOTTOM OF THE FILE rather than inside `adminNavigationSectionSeeds`:
// every `*PageItems` array is declared BELOW the seeds. Spreading one into a seed is a
// temporal-dead-zone ReferenceError at module load — and TypeScript does not model TDZ, so
// typecheck stays green while the rail renders empty in production.
//
// Sales Analytics has no promotion, for the same reason it has no group in `hubPageItemGroups`
// above: ruling 11 delisted it, and the module was retired on 2026-09-17.
type AdminHubPromotion = {
  /**
   * Heading rendered above the promoted rows, via a group in src/config/sidebar-domains.ts.
   * It must not repeat one of its own rows: `groupAdminSections` blanks such a heading, and
   * tests/sidebar-domains.test.ts pins that no heading blanks for any role.
   */
  heading: string;
  /** The hub row being replaced, matched on its href in the seeds. */
  hubHref: `/${string}`;
  /**
   * This promotion's anchor href opens a REAL MODULE, not a grid of modules — so the row survives
   * the promotion instead of being dropped with the doors.
   *
   * Exactly one promotion sets it, and it is a correction rather than a feature: `/admin/direct-
   * orders` is the Direct Orders workspace, and treating it as a door removed the module from
   * every admin-shell rail on 2026-09-05. The full account is on `hubRowsFor`. Setting this on a
   * hub that IS a page of modules puts that door back on the rail and breaks the owner's rule —
   * which is why tests/nav-hub-promotion.test.ts exempts a flagged href from the "no door survives"
   * assertion by NAME, one line per exception, rather than by reading the flag.
   */
  anchorIsAModule?: true;
  items: readonly AdminToolsPageItem[];
  /**
   * Split this hub's rows across SEVERAL bands instead of one.
   *
   * Ten hubs carry more rows than a band should hold — Admin Tools alone was 17, Source of Sales
   * 15 — and a band that long is a wall the eye slides off. Splitting them here rather than in
   * src/config/sidebar-domains.ts is deliberate: that layer groups whole SECTIONS, and it runs
   * after `applyPersonalLayout`, so teaching it to take a subset of a section's rows would make a
   * band's contents depend on whether the viewer had rearranged anything. Emitting real sections
   * keeps every downstream stage — gating, dedupe, personal layout, the domain grouping — working
   * on exactly the shape it already handles.
   *
   * The FIRST entry must reuse `sectionId`, for the same reason `sectionId` reuses the id of the
   * section the hub row occupied: sidebar-layout-editor.tsx saves a per-role layout keyed by
   * section id, so the biggest slice keeps the id any saved arrangement already names.
   *
   * Every row of the hub must appear in exactly one entry. A row named nowhere is NOT dropped —
   * `hubBandsFor` appends it to the first band — but tests/nav-hub-promotion.test.ts fails on it,
   * because landing in the first band silently is how a new module ends up filed under whatever
   * heading happens to come first.
   */
  split?: readonly { heading: string; hrefs: readonly string[]; sectionId: string }[];
  /**
   * Where the promoted rows land.
   *
   * Twelve of these REUSE the id of the section the hub row was the only occupant of, because
   * a section id is not private to this file: src/components/admin/sidebar-layout-editor.tsx
   * saves a per-role layout keyed by it, so renaming one silently orphans a saved layout. The
   * five `hub-` ids are the ones that had to be new — their original section still has rows of
   * its own and keeps its id.
   */
  sectionId: string;
};

/**
 * A rail label wider than its budget lands on `truncate`, and an ellipsis is barred (owner rule),
 * so these cards get a shorter label on the RAIL while the hub page keeps the full one.
 *
 * Two budgets are in play and the tighter one is easy to miss. A row in a section with siblings
 * gets 157px; a section that renders as a SINGLE row is drawn standalone with the ↗ affordance,
 * which costs 20px and leaves 137px. The last two entries here are that case — both are the only
 * row of their band for the CEO, and only for him ("Expense Command Center" at 153px and "Weekly
 * Sales Dashboard" at 141px both fit the 157px budget every other role charges them).
 *
 * Keyed by href, so the two hubs that both offer /admin/notification-confidence shorten alike.
 * Measured, not guessed, by `pnpm run ui:measure-sidebar-labels`;
 * tests/sidebar-label-width.test.ts is what holds it honest.
 *
 * WIDTH IS NOT THE ONLY REASON ANY MORE. /hr-calendar is here because its card label collides.
 * The page it collided with changed on 2026-09-05 and the entry still earns its place: it used to
 * sit a few rows from /admin/weekly-plans/calendar, which the CEO, SFE Manager and Finance Manager
 * knew as "Company Calendar"; that row is now "Planning Calendar", and /admin/company-calendar has
 * taken the name instead. So /hr-calendar still must not be a second "Company Calendar" on the same
 * rail — only the neighbour it would collide with is different. Two different pages under one word
 * is the defect
 * tests/sidebar-rows-read-uniquely.test.ts exists to catch, and the newcomer is the one that
 * gives way — the rail row that was already there keeps its name.
 */
const HUB_ROW_RAIL_LABELS: Readonly<Record<string, string>> = {
  "/admin/customer-pharmacy-mapping": "Pharmacy Mapping",
  "/admin/mailbox-monitor": "Mailbox Compliance",
  "/admin/marketing-requests/coverage-report": "Coverage Report",
  "/admin/notification-confidence": "Notification Confidence",
  "/admin/outstation/expense-command": "Expense Center",
  "/admin/screening-questions": "Screening Questions",
  "/admin/weekly-plans/calendar": "Planning Calendar",
  "/attendance/employee-day-report": "Day-by-Day Report",
  "/sales/weekly/dashboard": "Weekly Dashboard",
  "/sales/weekly/stock": "Weekly Stock",
  "/sales/weekly/distributor-editor": "Distributor Columns",
};

/**
 * Exported for tests/nav-hub-promotion.test.ts, which re-takes the "0 widened, 0 narrowed"
 * measurement described on `promoteHubRows` below on every run rather than trusting that it was
 * taken once. Nothing in the app imports it — `promoteHubRows` consumes it further down this
 * same file.
 */
export const adminHubPromotions: readonly AdminHubPromotion[] = [
  {
    heading: "People Management",
    hubHref: "/admin/people-management",
    items: peopleManagementPageItems,
    sectionId: "hub-people-management",
    split: [
      {
        heading: "Employee Records",
        sectionId: "hub-people-management",
        hrefs: [
          "/employees",
          "/contracts",
          "/resignations",
          "/retention",
          "/mailbox-offboarding",
          "/new-hire-mailboxes",
          "/devices",
          "/devices/managed-play",
          "/devices/tablets",
        ],
      },
      {
        heading: "HR Reports",
        sectionId: "hub-people-reports",
        hrefs: [
          "/reports/vacancies",
          "/admin/vacation-report",
          "/admin/company-activity-report",
        ],
      },
      {
        heading: "Plans & Support",
        sectionId: "hub-people-plans",
        hrefs: [
          "/admin/weekly-plans",
          "/admin/support-requests",
          "/admin/business-card-requests",
        ],
      },
      {
        // ITS OWN BAND, one row, rather than filed under "Employee Records" with the personnel
        // file. A candidate is not an employee, and "Employee Records" holding a CV search is the
        // wrong-label defect this whole feature has been careful about — the same reason the card
        // is not in "Recruitment & Hiring", whose heading announces a function the seat it was
        // built for does not hold.
        //
        // `tests/nav-hub-promotion.test.ts` is why this entry exists at all: a split hub must name
        // every one of its rows, because `hubBandsFor` appends an unnamed row to the FIRST band
        // instead of dropping it — so the row renders, works, and reads as somebody's decision
        // while sitting under a heading nobody chose. CI caught exactly that here.
        // "Candidate CVs" over a row labelled "CV Lookup", and the two MUST differ: a band heading
        // that repeats one of its own visible rows is BLANKED by `groupAdminSections`, and
        // tests/sidebar-domains.test.ts pins exactly which headings blank for which role. Naming
        // this band "CV Lookup" made it the 1 blank heading on the Super Admin's rail — caught
        // locally, after CI had already caught the unnamed-row half above. It reads like every
        // other band here: the heading describes the group, the row names the tool, the way
        // "HR Reports" sits over "Vacancies Report".
        heading: "Candidate CVs",
        sectionId: "hub-people-cv-lookup",
        hrefs: ["/cv-lookup"],
      },
    ],
  },
  { heading: "Probation Tools", hubHref: "/admin/probation-tools", items: probationPageItems, sectionId: "hub-probation-tools" },
  {
    heading: "Recruitment & Hiring",
    hubHref: "/admin/recruitment-hiring",
    items: recruitmentHiringPageItems,
    sectionId: "hub-recruitment-hiring",
    split: [
      {
        heading: "Recruitment & Hiring",
        sectionId: "hub-recruitment-hiring",
        hrefs: [
          "/recruitment",
          "/cv-database",
          "/offers",
          "/hiring-documents",
          "/hiring-pack",
          "/business-cards",
        ],
      },
      {
        heading: "CV Pipeline",
        sectionId: "hub-recruitment-pipeline",
        hrefs: [
          "/recruitment/intake-health",
          "/recruitment/contact-review",
          "/recruitment/whatsapp-replies",
        ],
      },
    ],
  },
  { heading: "Field Coaching", hubHref: "/admin/field-coaching", items: fieldCoachingPageItems, sectionId: "field-coaching" },
  {
    heading: "Attendance",
    hubHref: "/attendance",
    items: attendanceManagementPageItems,
    sectionId: "attendance-management",
    split: [
      {
        heading: "Attendance Reports",
        sectionId: "attendance-management",
        hrefs: [
          "/attendance/fingerprint-report",
          "/attendance/employee-day-report",
          "/attendance/monthly-summary",
          "/attendance/analytics",
          "/attendance/exceptions",
          // Banded with the reports rather than the calendars: a dispute is read
          // alongside the day it argues with, and the same evidence answers both.
          "/attendance/weekly-review",
          "/attendance/disputes",
        ],
      },
      {
        heading: "Calendars",
        sectionId: "attendance-management-calendars",
        hrefs: [
          "/hr-calendar",
          "/admin/company-calendar",
          "/admin/private-calendars",
          "/attendance/holiday-calendar",
          "/admin/weekly-plans/calendar",
        ],
      },
      {
        heading: "Attendance Setup",
        sectionId: "attendance-management-setup",
        hrefs: [
          "/attendance/device-user-mapping",
          "/attendance/policies",
        ],
      },
    ],
  },
  { heading: "Leave Management", hubHref: "/leave-management", items: leaveManagementPageItems, sectionId: "leave-management" },
  { heading: "Payroll Management", hubHref: "/admin/payroll-management", items: payrollManagementPageItems, sectionId: "payroll" },
  {
    heading: "Outstation Expenses",
    hubHref: "/admin/outstation-expenses",
    items: outstationExpensesPageItems,
    sectionId: "expenses-outstation",
    split: [
      {
        heading: "Expense Desk",
        sectionId: "expenses-outstation",
        hrefs: [
          "/admin/outstation/expense-command",
          "/admin/outstation/expense-command?tab=queue",
          "/admin/outstation/expense-command?tab=queue&action=create-manager-expense",
        ],
      },
      {
        heading: "Expense Records",
        sectionId: "expenses-outstation-records",
        hrefs: [
          "/admin/outstation/expenses/dashboard",
          "/admin/outstation/expenses",
          "/admin/outstation/policy",
        ],
      },
    ],
  },
  {
    heading: "Source of Sales",
    hubHref: "/sales/source-of-sales-tools",
    items: sourceOfSalesPageItems,
    sectionId: "sales-source-of-sales",
    split: [
      {
        heading: "Closing & Achievement",
        sectionId: "sales-source-of-sales",
        hrefs: [
          "/sales",
          "/sales/monthly-dashboard",
          "/sales/monthly-closing",
          "/sales/monthly-closing/performance-review",
          "/sales/closing-corrections",
        ],
      },
      {
        heading: "Sales Imports",
        sectionId: "sales-sos-imports",
        hrefs: [
          "/sales/upload",
          "/sales/import",
          "/sales/normalizer",
          "/sales/missing-data",
        ],
      },
      {
        heading: "Sales Mapping",
        sectionId: "sales-sos-mapping",
        hrefs: [
          "/sales/mapping-database",
          "/sales/database-mapping",
          "/sales/territory-management",
          "/sales/distributor-profiles",
        ],
      },
      {
        heading: "Sales Integrity",
        sectionId: "sales-sos-integrity",
        hrefs: [
          "/sales/diagnostics",
          "/sales/truth-check",
        ],
      },
    ],
  },
  { heading: "Weekly Sales", hubHref: "/sales/weekly-tools", items: weeklySalesToolsPageItems, sectionId: "sales-weekly-module" },
  {
    heading: "Direct Orders",
    hubHref: "/admin/direct-orders",
    // The anchor is the workspace itself, so it stays a row. See `anchorIsAModule` and hubRowsFor.
    anchorIsAModule: true,
    items: directOrdersPageItems,
    sectionId: "sales-direct-orders",
    split: [
      {
        // "Order Desk", not "Direct Orders": the band now holds a ROW called Direct Orders (the
        // workspace), and `groupAdminSections` blanks a heading that repeats one of its own rows —
        // which tests/sidebar-domains.test.ts fails on. The row keeps the name the owner uses for
        // the module; the heading is the half that gives way.
        heading: "Order Desk",
        sectionId: "sales-direct-orders",
        hrefs: [
          "/admin/direct-orders",
          "/admin/direct-orders/report",
          "/admin/direct-orders/held",
          "/admin/direct-orders/returned",
          "/admin/direct-orders/approval-exceptions",
          "/admin/direct-orders/rep-counters",
        ],
      },
      {
        heading: "Direct Order Pharmacies",
        sectionId: "sales-direct-orders-pharmacies",
        hrefs: [
          "/admin/direct-orders/pharmacies",
          "/admin/direct-orders/validations",
          "/admin/direct-orders/pharmacy-variances",
          "/admin/direct-orders/cleanup",
        ],
      },
      {
        heading: "Direct Order Setup",
        sectionId: "sales-direct-orders-setup",
        hrefs: [
          "/admin/direct-orders/caps",
          "/admin/direct-orders/reconciliation",
        ],
      },
    ],
  },
  {
    heading: "CRM",
    hubHref: "/admin/crm-tools",
    items: crmPageItems,
    sectionId: "crm",
    split: [
      {
        heading: "CRM Boards",
        sectionId: "crm",
        hrefs: [
          "/admin/crm",
          "/admin/reps-list",
          "/admin/kpis",
          "/admin/plan-verification",
          "/admin/doctor-list-changes",
          "/admin/field-crm",
          // A report he builds from the visits rather than a check on them — a board, not data quality.
          "/admin/phoenix-crm/visit-report",
        ],
      },
      {
        heading: "CRM Data Quality",
        sectionId: "crm-integrity",
        hrefs: [
          "/admin/crm-integrity",
          "/admin/double-visit-analytics",
          "/admin/double-visit-data-integrity",
          "/admin/brick-coverage",
          "/admin/field-workforce-compliance",
          "/admin/field-activity",
          "/admin/phoenix-crm/integrity",
          // Beside the board rather than inside it, and in this band because a duplicate on a
          // rep's list IS a CRM data-quality question — the same kind the two rows above ask.
          "/admin/phoenix-crm/duplicates",
          // A rep turned away on his location: housekeeping like the duplicates row, same band.
          "/admin/phoenix-crm/refused-readings",
          // A place Google Maps could not confirm: the same band, the Super Admin's alone.
          "/admin/field-crm/validation-reviews",
          // Beside it, and in the same band for the same reason: the raw evidence under those
          // integrity rows, and the Super Admin's alone.
          "/admin/field-crm/touch-trail",
          // Beside the duplicates row: both are the SFE's work ON a rep's list rather than a board
          // that measures him, and a card left out of every band is appended to the FIRST one under a
          // heading nobody chose (tests/nav-hub-promotion catches that, and caught the row below).
          "/admin/phoenix-crm/list-template",
          // Data quality rather than a board: it answers whether two rows in two modules are one
          // person, which is the same kind of question as the two integrity rows above it. A card
          // left out of every band here is not dropped — it is appended to the FIRST band and filed
          // under a heading nobody chose, so nothing looks broken; tests/nav-hub-promotion is what
          // catches that, and it caught this one.
          "/admin/customer-links",
        ],
      },
    ],
  },
  {
    heading: "Marketing & ROI",
    hubHref: "/admin/marketing-roi",
    items: marketingRoiPageItems,
    sectionId: "hub-marketing-roi",
    split: [
      {
        heading: "ROI",
        sectionId: "hub-marketing-roi",
        hrefs: [
          "/admin/marketing-roi-tracker",
          "/admin/sales-marketing-intelligence",
          "/admin/marketing-requests/roi-tracking",
          "/admin/marketing-requests/manager-scorecard",
          "/admin/marketing-roi-report",
          "/admin/pm-products",
        ],
      },
      {
        heading: "Requests & Inbox",
        sectionId: "hub-marketing-requests",
        hrefs: [
          "/admin/marketing-requests",
          "/admin/marketing-requests/all",
          "/admin/marketing-requests/bulk-upload",
          // Market Awareness is a REQUEST module — a product manager raises a conference or round
          // table and it goes for approval — so it belongs beside the other request rows rather
          // than under ROI, which is where a reporting-shaped name would have put it. Naming it
          // here is what stops it being appended silently to the FIRST band.
          "/admin/market-awareness",
          // Visual Aids is marketing MATERIAL the field uses, managed like a request's artwork, so it
          // sits beside Market Awareness rather than being appended silently to the first band.
          "/admin/visual-aids",
        ],
      },
      {
        heading: "Validation & Control",
        sectionId: "hub-marketing-control",
        hrefs: [
          "/admin/marketing-requests/coverage-report",
          "/admin/marketing-requests/validation",
          "/admin/marketing-requests/control",
        ],
      },
    ],
  },
  { heading: "Pharmacovigilance", hubHref: "/admin/pharmacovigilance", items: pharmacovigilancePageItems, sectionId: "hub-pharmacovigilance" },
  {
    heading: "Admin Tools",
    hubHref: "/admin/admin-tools",
    items: adminToolsPageItems,
    sectionId: "admin-tools",
    split: [
      {
        heading: "Platform Health",
        sectionId: "admin-tools",
        hrefs: [
          "/admin/monitoring",
          "/admin/system-issues",
          "/admin/data-health",
          "/admin/synthetic-journeys",
          "/admin/activity-control",
        ],
      },
      {
        heading: "Email & Notifications",
        sectionId: "admin-tools-comms",
        hrefs: [
          "/admin/email-control-center",
          "/admin/notification-recipients",
          "/admin/distribution-lists",
          // Beside the lists it sends to, deliberately: it is the only surface under this heading
          // that puts mail in somebody's inbox, and it reads the list directly above it.
          "/admin/sato-email",
          // Beside its older sibling: the same lists, the same send flow, a different letterhead
          // and a different seat. Keeping them adjacent is how somebody looking for "the composer"
          // sees that there are two and which one signs.
          "/admin/ceo-email",
          "/admin/notification-confidence",
          "/admin/notifications/email",
          "/admin/notifications/email-tracking",
          "/admin/mailbox-monitor",
        ],
      },
      {
        heading: "Data & Maintenance",
        sectionId: "admin-tools-data",
        hrefs: [
          "/admin/logs",
          "/admin/data-backup",
          "/admin/system-cleanup",
          "/admin/workflow-control",
        ],
      },
      {
        heading: "My Tools",
        sectionId: "admin-tools-personal",
        hrefs: [
          "/admin/sidebar-layout",
          "/admin/dev-preview",
        ],
      },
    ],
  },
  { heading: "Master Data", hubHref: "/admin/master-data", items: masterDataPageItems, sectionId: "master-data" },
  // NESTED. This one is not a seed row — it is a CARD on the Master Data hub above, and it opens a
  // page of six more modules. It survived the first pass of this promotion invisibly: the rail row
  // "Master Data" became a band, and one of the rows in that band was still a hub door, which is
  // exactly what the owner's rule forbids. `promoteHubRows` runs to a fixed point for it, and the
  // band carries BOTH gates (see NavigationSection.gate). Measured before the change: 8 pages were
  // catalogue-only, 6 of them behind this door.
  { heading: "Customers Database", hubHref: "/admin/customers-database", items: customersDatabasePageItems, sectionId: "hub-customers-database" },
  {
    heading: "Access & Comms",
    hubHref: "/admin/access-communication",
    items: accessCommunicationPageItems,
    sectionId: "access-communication",
    split: [
      {
        heading: "Access Control",
        sectionId: "access-communication",
        hrefs: [
          "/admin/access",
          "/admin/scope-visibility",
          "/admin/module-locks",
          "/admin/test-accounts",
          "/admin/screening-questions",
        ],
      },
      {
        heading: "Comms Templates",
        sectionId: "access-communication-templates",
        hrefs: [
          "/admin/email-reply-composer",
          "/admin/email-templates",
          "/admin/notifications/telegram",
          "/admin/notifications/telegram/templates",
          "/admin/notification-confidence",
        ],
      },
    ],
  },
];

/**
 * A hub's cards as rail rows.
 *
 * Two things happen here and nowhere else. A card pointing back at its OWN hub page is dropped —
 * keeping it would rebuild in a single row exactly the "press it and land on a page of modules"
 * this promotion exists to remove. And the eight over-budget labels are swapped for their short
 * forms.
 *
 * THE ONE EXCEPTION, and the reason `anchorIsAModule` exists (2026-09-06). Direct Orders is the
 * only promotion whose anchor href is not a grid of modules at all: `/admin/direct-orders` is the
 * Direct Orders WORKSPACE — tabs, the needs-action queue, every order — and the hub page it was
 * once paired with (`/sales/direct-orders-tools`) no longer exists on disk. Dropping it as though
 * it were a door took the module's only rail row away from every admin-shell seat that had it:
 * Super Admin, CEO, Finance Manager and the SFE Manager, measured, from 2026-09-05 until this. It
 * read as a hub to `hubRoutesOnDisk()` too, because that scan identifies a hub by the page
 * importing a `*PageItems` array and this page imports `directOrdersPageItems` for a shortcut list
 * INSIDE the workspace — so nothing caught it either.
 *
 * `anchorRow` is the SEED row itself rather than the hub's own card for that href. That is
 * deliberate on two counts: the seed row is gated `direct_orders:read`, which is the gate the page
 * actually enforces (`assertDirectOrdersPageAccess`), while the card claims `create` because it
 * described submitting an order; and the seed row carries `navBadge`, which a card cannot — the
 * unbooked-sales-month badge is the Finance Manager's only chaser for that queue and it went with
 * the row.
 *
 * `description` is deliberately not carried over: it is the hub page's card copy, and the rail
 * has nowhere to render it.
 */
function hubRowsFor(
  hub: AdminHubPromotion,
  anchorRow?: NavigationSectionItem,
): readonly NavigationSectionItem[] {
  const cards = hub.items
    .filter((card) => card.href !== hub.hubHref)
    .map((card) => ({
      excludedRoles: card.excludedRoles,
      href: card.href,
      icon: card.icon,
      label: HUB_ROW_RAIL_LABELS[card.href] ?? card.label,
      permissions: card.permissions,
      roles: card.roles,
    }));
  return hub.anchorIsAModule === true && anchorRow !== undefined ? [anchorRow, ...cards] : cards;
}

type HubBand = { heading: string; items: NavigationSectionItem[]; sectionId: string };

/**
 * A hub's rows as the band or bands it becomes.
 *
 * Unsplit, this is exactly what it always was: one band carrying the hub's name and id. Split, the
 * rows are dealt into the named bands IN THE ORDER THE SPLIT WRITES THEM, which is the reading
 * order they render in — not the order they happen to sit in the hub's own card list.
 *
 * A row named by no band is appended to the first rather than dropped. That is the same choice
 * `UNGROUPED_DOMAIN` makes one layer up and for the same reason: a nav row silently ceasing to
 * exist is invisible in review — the page still works, the link is simply unreachable — so the
 * runtime keeps it and tests/nav-hub-promotion.test.ts is what makes the mistake loud.
 *
 * An EMPTY band is dropped, which is also load-bearing. Its id then appears in
 * src/config/sidebar-domains.ts and nowhere in `adminNavigationSections`, and the "phantom
 * section" assertion in tests/sidebar-domains.test.ts fails — so a split that stops matching the
 * hub's hrefs is caught rather than rendering a heading over nothing.
 */
function hubBandsFor(hub: AdminHubPromotion, anchorRow?: NavigationSectionItem): readonly HubBand[] {
  const rows = hubRowsFor(hub, anchorRow);
  if (hub.split === undefined) {
    return [{ heading: hub.heading, items: [...rows], sectionId: hub.sectionId }];
  }

  const unclaimed = new Map<string, NavigationSectionItem>(rows.map((row) => [row.href, row]));
  const bands: HubBand[] = hub.split.map((band) => {
    const items: NavigationSectionItem[] = [];
    for (const href of band.hrefs) {
      const row = unclaimed.get(href);
      if (row !== undefined) {
        items.push(row);
        unclaimed.delete(href);
      }
    }
    return { heading: band.heading, items, sectionId: band.sectionId };
  });

  if (bands.length > 0) bands[0].items.push(...unclaimed.values());
  return bands.filter((band) => band.items.length > 0);
}

/**
 * Replace every hub row with its hub's modules.
 *
 * A section keeps its own id and position when it still has non-hub rows; when the hub row was
 * its only occupant the section is not emitted at all, and the promotion takes its id instead —
 * which is why `sectionId` above is usually the original.
 *
 * Gating is the part worth reading twice. A row's own card gate is only half of what made it
 * reachable before: the other half was being able to open the hub at all, and dropping that WIDENS
 * the rail. Measured across all 17 roles x 17 hubs, exactly one card set widened — HR Operations
 * holds `employee_documents` but not `recruitment`, so Hiring Documents and HR Forms appeared on a
 * rail that has never carried them. So the hub row's own gate is carried onto the SECTION
 * (`NavigationSection.gate`), where `getSections` ANDs it with each row's; the two halves stay
 * separate instead of being flattened into one row gate, which is what an item can express.
 *
 * The result is exactly the old reachability: a row shows iff the viewer could have opened the hub
 * AND the hub page would have rendered that card for them. Re-measured after the change: 0 rows
 * widened, 0 rows narrowed. What legitimately disappears is a DEAD END — 31 role/hub pairs where
 * the rail offered a hub whose page had nothing at all for that role (Payroll Management for every
 * sales role, Attendance for eleven roles). Those bands are gone rather than empty.
 */
function promoteHubRows(seeds: readonly NavigationSection[]): readonly NavigationSection[] {
  const byHubHref = new Map<string, AdminHubPromotion>(adminHubPromotions.map((hub) => [hub.hubHref, hub]));
  const expanded = new Set<string>();
  let sections: readonly NavigationSection[] = seeds;

  // Runs until nothing moves, because a hub's own card can be another hub: Customers Database is a
  // card on Master Data. One pass promoted Master Data into a band and left that card sitting in it
  // as a live hub door — the rule half-applied, and invisible unless you open the band. `expanded`
  // makes the loop terminate on its own terms rather than on a pass cap: a hub is promoted once,
  // and a config cycle would leave one plain row rather than hanging module load.
  for (;;) {
    const next: NavigationSection[] = [];
    let moved = false;
    for (const section of sections) {
      const kept: NavigationSectionItem[] = [];
      const promoted: NavigationSection[] = [];
      for (const item of section.items) {
        const hub = byHubHref.get(item.href);
        if (hub === undefined || expanded.has(hub.hubHref)) {
          kept.push(item);
          continue;
        }
        moved = true;
        expanded.add(hub.hubHref);
        // The band's gates are its parent's plus the row's own — see NavigationSection.gate for
        // why this is a list. For a seed row the parent list is empty and this is the single
        // gate it always was. Every band of a split hub carries the SAME gate: they are one hub's
        // rows drawn under several headings, not several hubs, so splitting must not change who
        // can reach any of them.
        const gate = [
          ...(section.gate ?? []),
          { excludedRoles: item.excludedRoles, permissions: item.permissions, roles: item.roles },
        ];
        // `item` — the seed row being replaced — is handed through only for a promotion whose
        // anchor is a real module (see hubRowsFor). For every other hub it is the door, and the
        // whole point is that it does not come back.
        for (const band of hubBandsFor(hub, item)) {
          promoted.push({ gate, id: band.sectionId, items: band.items, label: band.heading });
        }
      }
      if (kept.length > 0) next.push({ ...section, items: kept });
      next.push(...promoted);
    }
    sections = next;
    if (!moved) return sections;
  }
}

/**
 * Every section id a hub's rows are drawn in — one, or the several its `split` names.
 *
 * Exists for the tests, and it is not a convenience. Several of them assert something about a band
 * by finding `section.id === "admin-tools"` or `"crm"`, and a split leaves that lookup finding a
 * TRUE SUBSET of the band it used to name — so the assertion keeps running, keeps reading as though
 * it covers the module, and quietly stops covering three quarters of it. Two failed exactly that way
 * when the rebalance shipped, which is the good outcome; the bad one is a test that still passes.
 *
 * Takes the ORIGINAL section id (the one the hub row occupied), because that is what a test written
 * before the split already names.
 */
export function bandSectionIdsFor(sectionId: string): readonly string[] {
  const hub = adminHubPromotions.find((promotion) => promotion.sectionId === sectionId);
  if (hub?.split === undefined) return [sectionId];
  return hub.split.map((band) => band.sectionId);
}

export const adminNavigationSections: readonly NavigationSection[] = promoteHubRows(adminNavigationSectionSeeds);
