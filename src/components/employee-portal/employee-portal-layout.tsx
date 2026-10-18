"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
// Straight from the badge module, NOT the sidebar re-export it used until 2026-09-04: that
// import pulled the whole sidebar — dnd-kit, the layout editor, the preference machinery —
// into every portal page's bundle for a thirty-line badge. See nav-badge.tsx's own header.
import { NavBadge } from "@/components/layout/nav-badge";
import { alarmGlowRef } from "@/components/layout/alarm-glow";
// The brand asset comes from the one documented edit point for it, so a future logo swap is one
// line in one file rather than a hunt through the rail (CLAUDE.md, "Global edit points").
import { systemAssets } from "@/config/system-settings";
import {
  Menu,
  Search,
  CalendarClock,
  Sparkles,
  LogOut,
  Activity,
  CircleDollarSign,
  ReceiptText,
  Scale,
  Award,
  Trophy,
  X,
  Users,
  BriefcaseBusiness,
  ClipboardCheck,
  Building2,
  ChartColumnBig,
  FileCheck2,
  FilePlus2,
  ClipboardList,
  ShieldCheck,
  Database,
  Settings2,
  Home,
  Send,
  FileText,
  FileSpreadsheet,
  Fingerprint,
  FlaskConical,
  Gift,
  IdCard,
  Mail,
  CalendarDays,
  Headphones,
  Lock,
  ChevronDown,
  WalletCards,
  UserCog,
  UsersRound,
  Inbox,
  Target,
  CalendarRange,
  CalendarX2,
  CalendarCheck2,
  MapPinCheck,
  MapPinned,
  Waypoints,
  BookUser,
  TrendingUp,
  Repeat2,
  Radar,
  PhoneCall,
  Package,
  PackageCheck,
  PackageSearch,
  Sunrise,
  Star,
  PanelLeftClose,
  PanelLeftOpen,
  WifiOff,
  Command,
  Keyboard,
  Maximize2,
  Minimize2,
  ChevronRight,
  Check,
  Megaphone,
  LifeBuoy,
  Plus,
} from "lucide-react";
import { EmployeePortalBottomNav } from "@/components/employee-portal/employee-portal-bottom-nav";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { OneSignalProvider } from "@/components/notifications/onesignal-provider";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";
import { DisplayScaleControl } from "@/components/layout/display-scale-control";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import {
  ModuleLockProvider,
  isNavItemLockedFor,
  useLockedModuleKeys,
} from "@/components/layout/module-lock-context";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { PageTransition } from "@/components/ui/page-transition";
import { useDismissOnOutsideInteraction } from "@/hooks/use-dismiss-on-outside-interaction";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { isEmployeePortalOwnedRoute } from "@/lib/employee-portal/routes";
import { resolveDeepestActiveHref } from "@/lib/navigation/active-path";
import { hardNavigate } from "@/lib/navigation/browser-navigation";
import { HEADER_PANEL_MAX_HEIGHT } from "@/lib/navigation/panel-position";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import {
  PORTAL_COLLAPSED_SECTIONS_KEY,
  PORTAL_RECENT_PAGES_KEY,
  availableGoShortcuts,
  breadcrumbFor,
  cairoHour,
  filterSections,
  greetingForHour,
  nextRecentHrefs,
  rowForPath,
  toggleInList,
  togglePinnedHref,
  waitingQueues,
} from "@/lib/employee-portal/portal-chrome";
import {
  readStoredListNow,
  useCollapsePreferenceSet,
  useCollapsedSections,
  useIsOnline,
  useIsWideScreen,
  useRecentPages,
  writeStoredList,
} from "@/components/employee-portal/portal-chrome-hooks";
import {
  PortalAvatar,
  PortalCommandBar,
  PortalPendingCount,
  PortalShortcutsCard,
  WaitingOnYouChip,
  type ChromeAction,
} from "@/components/employee-portal/portal-chrome-widgets";
import { shownDefaultBottomNavHrefs } from "@/components/employee-portal/employee-portal-nav-registry";
import { PORTAL_QUICK_ACTION_ICONS } from "@/components/employee-portal/portal-bottom-nav-widgets";
import { portalQuickActions } from "@/lib/employee-portal/portal-quick-actions";
import { useBottomNavPreference } from "@/components/employee-portal/use-bottom-nav-preference";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminChipDepthClassName, adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/** The default fold set: EMPTY — every section opens expanded (owner, 2026-10-03). Module-level so
 *  its identity is stable across renders, exactly as the useMemo it replaced was. */
const NO_SECTIONS_FOLDED: readonly string[] = [];

const EMPLOYEE_SIDEBAR_COLLAPSED_KEY = "phoenix-employee-sidebar-collapsed";
const EMPLOYEE_SIDEBAR_COLLAPSED_EVENT = "phoenix-employee-sidebar-collapsed-change";
const EMPLOYEE_ROUTE_PENDING_EVENT = "phoenix-employee-route-pending";

function subscribeToEmployeeSidebarCollapsed(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT, callback);

  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT, callback);
  };
}

/**
 * Where the fold is kept when this browser refuses storage (a private window, blocked site data):
 * in memory for the life of the page, so the button still works and simply is not remembered.
 * Replaces the component-level fallback state that used to shadow the stored value for good after
 * the first toggle — which also stopped a second open tab from following along.
 */
let employeeSidebarCollapsedInMemory = true;

function getEmployeeSidebarCollapsedSnapshot() {
  try {
    const stored = window.localStorage.getItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY);
    // No stored choice = collapsed by default (owner, 2026-09-29).
    return stored === null ? true : stored === "true";
  } catch {
    return employeeSidebarCollapsedInMemory;
  }
}

function getEmployeeSidebarCollapsedServerSnapshot() {
  return true;
}

/** Fold or unfold the desktop sidebar — from its buttons and from the `[` shortcut alike. */
function setEmployeeSidebarCollapsed(next: boolean) {
  employeeSidebarCollapsedInMemory = next;
  try {
    window.localStorage.setItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY, String(next));
  } catch {
    // Kept in memory above; nothing to persist to.
  }
  window.dispatchEvent(new Event(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT));
}

// The WHITE sidebar stays (owner, 2026-09-29): a navy label column was tried the same day and
// turned down on sight — "sidebar color is very bad". The power features stand; the colours do not
// move. Do not re-propose a dark sidebar.
function navItemClass(active: boolean) {
  return active
    ? "bg-[#FFF0E7] text-[#F05A1A] shadow-[0_10px_22px_rgba(240,90,26,0.10)]"
    : "text-[#26334F] hover:bg-[#FFF6F0] hover:text-[#F05A1A]";
}

function navIconClass(active: boolean) {
  return active
    ? "text-[#F05A1A]"
    : "text-[#25314A]/76 group-hover:text-[#F05A1A]";
}

/**
 * The standout row's resting face (owner, 2026-09-30, picking option D from four rendered mockups).
 *
 * 🔴 IT CARRIES NO FILL, AND THAT IS THE WHOLE POINT. The first attempt rested on `#FFF6F0`, which is
 * the hover tint one shade off the ACTIVE row's `#FFF0E7`, and the owner turned it down on sight —
 * "you are highlighting it the same" — because a permanent pale-orange row says *you are here* on a
 * page you are not on. So the highlight is now made of things the active state does not use: a heavy
 * 4px orange rail down the left edge, the label and the mark in Phoenix orange, and square edges.
 * The row's background stays the sidebar's own white until you hover it.
 *
 * Which also keeps the two states legible TOGETHER: land on Phoenix CRM and the active face fills in
 * behind the rail, so "special" and "where you are" read as two different things rather than one.
 */
const NAV_HIGHLIGHT_CLASS = "text-[#F05A1A] hover:bg-[#FFF6F0]";

/**
 * Hub roots that must never stay lit on a child route, even when NO deeper sidebar row matches it.
 * Only the portal root qualifies: /employee-portals/profile (and a few other destinations) have no
 * sidebar row of their own, so without this "Command Center" would light up while you sit on them.
 * Every other parent is handled by longest-match below and needs no entry here.
 */
const EXACT_ONLY_PORTAL_HREFS = new Set(["/employee-portals"]);

/**
 * The ONE active sidebar row for a path — the deepest matching href wins.
 *
 * The rule itself lives in src/lib/navigation/active-path.ts (React-free, so the Node test harness
 * can exercise it; this component imports next/navigation at module scope and cannot be imported
 * there). See resolveDeepestActiveHref for why longest-match replaced the old hand-kept list.
 */
function resolveActivePortalHref(pathname: string, sections: readonly EmployeePortalNavSection[]) {
  return resolveDeepestActiveHref(
    pathname,
    sections.flatMap((section) => section.items.map((item) => item.href)),
    EXACT_ONLY_PORTAL_HREFS,
  );
}

type EmployeePortalNavProps = {
  activePathOverride?: string;
  data: EmployeePortalShellData;
  disableSessionGuard?: boolean;
  visibility: EmployeePortalNavVisibility;
};

type EmployeePortalNavItem = {
  href: string;
  label: string;
  icon: typeof Activity;
  /**
   * The sidebar's one standout row (owner, 2026-09-30: "Phoenix CRM highlight a special highlight in
   * side bar"). It stays an ordinary row in its ordinary section — the highlight is a persistent warm
   * face, an orange rail on the left edge and an orange icon, so the row reads as the flagship without
   * a band of its own. Deliberately NOT the launcher that was tried and removed the same day (#4958):
   * no dark face, no glow, no motion, no font of its own, and no badge word.
   *
   * It costs the row NO width — the rail is absolutely positioned inside the row wrapper — which is
   * what the no-horizontal-scroll rule requires here, since the portal's label span has no `truncate`
   * and anything placed beside a long label wraps to a second line.
   */
  highlight?: true;
  // Live pending-count badge (mirrors the admin sidebar's navBadge) — the Vacation/
  // Excuse/Plan/Direct Orders/Marketing Approvals/Awareness Approvals links plus the
  // residual "Other Approvals" inbox carry one.
  navBadge?:
    | "approvals-hub-pending"
    | "vacation-approvals-pending"
    | "excuse-approvals-pending"
    | "plan-approvals-pending"
    | "direct-orders-needs-action"
    | "marketing-approvals-pending"
    | "market-awareness-approvals-pending";
};

type EmployeePortalNavSection = {
  hideTitle?: boolean;
  items: EmployeePortalNavItem[];
  title: string;
  /** "Pinned" and "Recent" are drawn from the real sections; their copies of a row never light up. */
  virtual?: "pinned" | "recent";
};

/**
 * Collapsed-rail icon per section. Every title below MUST map to a DISTINCT icon: the collapsed
 * sidebar shows nothing but this strip of icons, so two sections sharing one are indistinguishable.
 * Previously "Approvals Hub"/"Leave Management" both rendered CalendarDays and "Marketing & ROI"/
 * "Team Operations"/"Recruitment & Hiring" all rendered BriefcaseBusiness.
 */
function sectionRailIcon(title: string): typeof Activity {
  if (title === "Training Manager") return ClipboardCheck;
  // Phoenix CRM's band sits above My Workspace and has no header, but the COLLAPSED rail is nothing
  // but this strip of icons — so without an entry here the band would show the fallback Activity
  // glyph and the star of the system would be the one section a collapsed sidebar cannot name.
  // It reuses the row's own ClipboardList, which is what a rep already associates with the module.
  if (title === "Phoenix CRM") return ClipboardList;
  if (title === "My Workspace") return Home;
  if (title === "Social") return UsersRound;
  if (title === "Approvals Hub") return FileCheck2;
  if (title === "Sales Data") return ChartColumnBig;
  if (title === "Performance") return Trophy;
  if (title === "Forecast & Target") return Target;
  if (title === "Recruitment") return BriefcaseBusiness;
  if (title === "iReports 360") return MapPinned;
  if (title === "KPIs") return TrendingUp;
  if (title === "Marketing & ROI") return Megaphone;
  if (title === "Payroll") return WalletCards;
  if (title === "Outstation Expenses") return ReceiptText;
  if (title === "Leaves Management") return CalendarDays;
  if (title === "Other") return LifeBuoy;
  return Activity;
}

function buildEmployeePortalSections({
  showDashboardTab = true,
  showExcusesTab = false,
  showExpenseActionTab = false,
  showExpenseDashboardTab = false,
  showFingerprintReportTab = false,
  showIncentiveTab = true,
  showMarketAwarenessInboxTab = false,
  showMarketAwarenessTab = false,
  showVisualAidsTab: _showVisualAidsTab = false,
  showMarketingRequestsTab = false,
  showMarketingValidationTab = false,
  showMarketingInboxTab = false,
  showMarketingAllRequestsTab = false,
  showMarketingCustomerDatabaseTab = false,
  showMarketingControlTab = false,
  showMarketingCoverageReportTab = false,
  showMyPerformanceTab: _showMyPerformanceTab = true,
  showTeamPerformanceTab = false,
  showMedRepsPerformanceTab = false,
  showRepsListTab = false,
  showKpisTab = false,
  showMedicalRepExpensesTab = false,
  showSpotlightTab = false,
  showDsmsPerformanceTab = false,
  showTeamCalendarTab = false,
  showFieldAbsenceTab = false,
  showTeamExpensesTab = false,
  showVacanciesTab = false,
  showMyCandidatesTab = false,
  showManagerEngagementTab = false,
  showInterviewCalendarTab = false,
  showProbationTab = false,
  showOrganogramTab = false,
  showPlansTab = false,
  showPlanningCalendarTab = false,
  showSupportTab = false,
  showPrivateCalendarTab = false,
  showMyVisitsTab = true,
  showPhoenixCrmTab = false,
  showTeamPlaceChecksTab = false,
  showDoubleVisitRequestsTab = false,
  showDailyForecastTab = false,
  showDeductionsTab = true,
  showMyCoachingTab: _showMyCoachingTab = false,
  showTeamCoachingTab: _showTeamCoachingTab = false,
  showTrainingManagerCreateCoachingTab = false,
  showTrainingManagerDashboardTab = false,
  showTrainingManagerFieldCoachingTab = false,
  showReportItTab = false,
  showReportItDashboardTab = false,
  showRoiIntelligenceTab = false,
  showSourceOfSalesTab = false,
  showWeeklyTab = false,
  showWeeklyStockTab = false,
  showMonthlyClosingTab = false,
  showPerformanceReviewTab = false,
  showSalesVsTargetTab = false,
  showMakeItHappenTab = false,
  showTerritoryDrilldownTab = false,
  showTerritoryManagementTab = false,
  showCrmMasterTab = false,
  showTargetsTab = false,
  showMarketingRoiTrackingTab = false,
  showBusinessReviewTab = false,
  showDoubleVisitAnalyticsTab: _showDoubleVisitAnalyticsTab = false,
  showDoubleVisitReportTab = false,
  showFieldActivityTab = false,
  showEarlyBirdsTab = false,
  showRanksTab = false,
  showCoachingAnalyticsTab: _showCoachingAnalyticsTab = false,
  showActionsTab = false,
  showDirectOrdersTab = false,
  showAreaDirectOrdersTab = false,
  showMilestonesTab = false,
  showProductionPlanningTab = false,
  showVacationApprovalsTab = false,
  showExcuseApprovalsTab = false,
  showPlanApprovalsTab = false,
  showAttendanceTab: _showAttendanceTab = false,
}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {
  // THE OWNER'S ARRANGEMENT (2026-09-29, his sheet "emp sidebar.xlsx" plus the follow-up placement
  // sheet). Headers, in his order: My Workspace · Approvals Hub · Sales Data · Performance ·
  // Forecast & Target · Recruitment · iReports 360 · KPIs · Marketing & ROI · Payroll · Outstation Expenses
  // · Leaves Management · Other. Training Manager keeps its own section, ahead of the rest, for TMs
  // only. Five rows he moved to "Remove from sidebar" — My Coaching Reports, Team Coaching Reports
  // (both /coaching), Double-Visit Analytics, Coaching Analytics and Visual Aids — are GONE from the
  // rail, the phone bar and the app's Modules list; the pages themselves stay, reached from their
  // command-centre cards and admin twins. Order WITHIN each header is the sensible default, easy to
  // change on his word. Three header spellings corrected with his agreement (Forecast & Target,
  // Recruitment, Outstation Expenses). The app's Modules list follows these sections
  // (src/lib/employee-portal/native-module-directory.ts), held level by
  // tests/mobile-module-directory.test.ts.
  return [
    {
      title: "Training Manager",
      items: [
        ...(showTrainingManagerDashboardTab ? [{ href: "/employee-portals/training-manager", label: "Overview", icon: Home }] : []),
        ...(showTrainingManagerDashboardTab ? [{ href: "/employee-portals/training-manager/coaching", label: "Coaching Dashboard", icon: ChartColumnBig }] : []),
        ...(showTrainingManagerCreateCoachingTab ? [{ href: "/employee-portals/training-manager/create-coaching-report", label: "Create Coaching Report", icon: FilePlus2 }] : []),
        ...(showTrainingManagerFieldCoachingTab ? [{ href: "/employee-portals/training-manager/field-coaching", label: "Field Coaching", icon: ClipboardCheck }] : []),
      ],
    },
    {
      // ── Phoenix CRM — its own band, ABOVE My Workspace (owner, 2026-09-30: "move it above the
      // workspace, my workspace") ───────────────────────────────────────────────────────────────
      // `hideTitle` drops the section header: the one row already carries the name, and a second
      // "Phoenix CRM" above it would just be the same words twice. A headerless band also cannot be
      // folded — `folded` is only ever set by the header button, which does not render — so the row
      // can never hide, and `canFold` needs no new conjunct for it.
      //
      // Gated by the row's own flag, so the empty-section filter below drops the whole band for
      // anyone the module refuses. Its mirror is native-module-directory.ts
      // (NATIVE_MODULE_SECTION_ORDER + MODULE_PLACEMENT) and its collapsed-rail icon is in
      // sectionRailIcon — a title missing from either is a drift test failure, not a silent gap.
      title: "Phoenix CRM",
      hideTitle: true,
      items: [
        // Gated by `phoenixCrmEntryAvailable` — the phoenix_crm permission, a territory of his own or
        // beneath him, and his line opened in phoenix_crm_line_rollout; the page enforces it again.
        // `highlight` makes it the sidebar's one standout row (owner, 2026-09-30) — see the flag's
        // own note on EmployeePortalNavItem. It must stay the ONLY row carrying it: a second one and
        // neither is a standout.
        ...(showPhoenixCrmTab
          ? [{ href: "/employee-portals/field-crm", label: "Phoenix CRM", icon: ClipboardList, highlight: true as const }]
          : []),
        // Place checks — a district manager's own team's place validations, where he comments and
        // recommends (owner, 2026-10-13: "a tab in his sidebar"). Gated by `readsTeamPlaceChecks`
        // through `phoenixCrmSidebarEntries`, never a role list here; the page gates again.
        //
        // 🔴 NO `highlight`. The row above is the sidebar's ONE standout (owner, 2026-09-30) and a
        // second one means neither is. The band's `hideTitle` needs no change either: the highlighted
        // Phoenix CRM row reads as this band's own heading, which is why a second row can sit under it
        // without a header appearing.
        ...(showTeamPlaceChecksTab ? [{ href: "/employee-portals/place-checks", label: "Place checks", icon: MapPinCheck }] : []),
        // Visit report — the district manager's own team's visits, any fields, as a dashboard, a map and a
        // workbook (owner, 2026-10-15). It rides the Place checks flag on purpose: the audience is the same
        // two seat tiers (`readsTeamVisitReport` is `readsTeamPlaceChecks`'s twin), so no fourth argument has
        // to be threaded through every caller of the sidebar. The page gates again (`canReadVisitReport`).
        ...(showTeamPlaceChecksTab ? [{ href: "/employee-portals/visit-report", label: "Visit report", icon: ClipboardList }] : []),
        // Double visit requests — what the reps ask their managers and product managers for, and every
        // person's answer (owner, 2026-10-16: "a new sidebar report … all managers must have access on this
        // report as per their scope upto ceo"). Its own flag, because the audience is wider than the
        // district manager's: `doubleVisitReportAudience` through `phoenixCrmSidebarEntries`, never a role
        // list here; the page gates again. No `highlight` — the Phoenix CRM row is the band's one standout.
        ...(showDoubleVisitRequestsTab ? [{ href: "/employee-portals/double-visit-requests", label: "Double visit requests", icon: UsersRound }] : []),
      ],
    },
    {
      title: "My Workspace",
      items: [
        ...(showDashboardTab ? [{ href: "/employee-portals", label: "Command Center", icon: Home }] : []),
        // Interview Calendar — the interview-calendar access flag (a DM/NSM/HR seat by role, or
        // anyone the owner shared it with).
        ...(showInterviewCalendarTab ? [{ href: "/employee-portals/interview-calendar", label: "Interview Calendar", icon: CalendarClock }] : []),
        ...(showOrganogramTab ? [{ href: "/employee-portals/organogram", label: "Organogram", icon: Building2 }] : []),
        // Open to every role, self-scoped (see src/lib/employee-360/access.ts).
        { href: "/employee-portals/employee-360", label: "Employee 360", icon: IdCard },
        // Business Cards, My Milestones and Spotlight moved to the "Social" band below (owner, 2026-09-30).
        ...(showBusinessReviewTab ? [{ href: "/employee-portals/business-review", label: "Business Review", icon: ChartColumnBig }] : []),
        // Private Calendar — self-scoped; every portal role since 2026-08-01, kept behind its flag so
        // Modules Control can still curate it per role or person.
        ...(showPrivateCalendarTab ? [{ href: "/employee-portals/private-calendar", label: "Private Calendar", icon: CalendarDays }] : []),
        ...(showPlansTab ? [{ href: "/employee-portals/plans", label: "Weekly / Monthly Plan", icon: CalendarDays }] : []),
        ...(showPlanningCalendarTab ? [{ href: "/employee-portals/plans/calendar", label: "Planning Calendar", icon: CalendarClock }] : []),
        // Production Planner — Ivyronc's raw-material buy list, for the five people the owner named
        // by HR id rather than by role (the R&D Manager and the R&D Supervisor are the two who sit
        // in this shell). The flag carries the named list in; the page re-asks the database.
        ...(showProductionPlanningTab ? [{ href: "/employee-portals/production-planning", label: "Production Planner", icon: FlaskConical }] : []),
      ],
    },
    {
      // Social — the employee's own identity and recognition cards, grouped together (owner,
      // 2026-09-30): his business card, his milestone keepsakes and his spotlight sheet. Mirrored in
      // native-module-directory.ts and held level by tests/mobile-module-directory.test.ts.
      title: "Social",
      items: [
        // Open to every employee: their own business card, editable name/number, and a request to HR.
        { href: "/employee-portals/business-cards", label: "Business Cards", icon: IdCard },
        // Email Signature — every employee's own Sato Pharma + Phoenix signature, built from their record as ONE picture (owner, 2026-10-17).
        { href: "/employee-portals/email-signature", label: "Email Signature", icon: Mail },
        // My Milestones — the rep's own service-anniversary and Sato-Pharma birthday keepsake cards,
        // self-scoped and downloadable by him. Medical-Rep only.
        ...(showMilestonesTab ? [{ href: "/employee-portals/milestones", label: "My Milestones", icon: Award }] : []),
        // Spotlight (self) — the rep's own recognition sheet. Kept in sync with the registry entry in
        // employee-portal-nav-registry.ts by the bottom-nav test.
        ...(showSpotlightTab ? [{ href: "/employee-portals/spotlight", label: "Spotlight", icon: Sparkles }] : []),
      ],
    },
    {
      title: "Approvals Hub",
      items: [
        ...(showVacationApprovalsTab ? [{ href: "/employee-portals/approvals/vacation", label: "Leave Approvals", icon: CalendarDays, navBadge: "vacation-approvals-pending" as const }] : []),
        ...(showExcuseApprovalsTab ? [{ href: "/employee-portals/approvals/excuse", label: "Excuse Approvals", icon: CalendarClock, navBadge: "excuse-approvals-pending" as const }] : []),
        ...(showPlanApprovalsTab ? [{ href: "/employee-portals/approvals/plan", label: "Plan Approvals", icon: CalendarRange, navBadge: "plan-approvals-pending" as const }] : []),
        ...(showMarketingInboxTab ? [{ href: "/employee-portals/marketing-requests/inbox", label: "Marketing Inbox", icon: Inbox, navBadge: "marketing-approvals-pending" as const }] : []),
        ...(showMarketAwarenessInboxTab ? [{ href: "/employee-portals/market-awareness/inbox", label: "Awareness Approvals", icon: Inbox, navBadge: "market-awareness-approvals-pending" as const }] : []),
        ...(showActionsTab ? [{ href: "/employee-portals/approvals-hub", label: "Other Approvals", icon: Inbox, navBadge: "approvals-hub-pending" as const }] : []),
      ],
    },
    {
      title: "Sales Data",
      items: [
        ...(showSourceOfSalesTab ? [{ href: "/employee-portals/source-of-sales", label: "Source of Sales", icon: ChartColumnBig }] : []),
        ...(showWeeklyTab ? [{ href: "/employee-portals/weekly-sales", label: "Weekly Sales", icon: CalendarRange }] : []),
        ...(showWeeklyStockTab ? [{ href: "/employee-portals/weekly-stock", label: "Weekly Stock", icon: Package }] : []),
        ...(showTerritoryDrilldownTab ? [{ href: "/employee-portals/territory-drilldown", label: "Sales Drilldown", icon: MapPinned }] : []),
        // The badge the catalog seed and the phone bar have always carried (#2020 never wired it onto
        // this hand-built row until the 2026-09-28 audit).
        ...(showDirectOrdersTab ? [{ href: "/employee-portals/direct-orders", label: "Direct Orders", icon: ReceiptText, navBadge: "direct-orders-needs-action" as const }] : []),
        // A Medical Rep's VIEW-ONLY window onto the direct orders their District Manager booked on
        // pharmacies in the rep's own area (owner, 2026-09-24).
        ...(showAreaDirectOrdersTab ? [{ href: "/employee-portals/direct-orders-in-my-area", label: "Area Direct Orders", icon: PackageSearch }] : []),
      ],
    },
    {
      title: "Performance",
      items: [
        // The field force's most-opened dashboard, and the only one a Medical Rep can open at all.
        ...(showSalesVsTargetTab ? [{ href: "/employee-portals/sales-vs-target", label: "Sales vs Target", icon: Target }] : []),
        ...(showMonthlyClosingTab ? [{ href: "/employee-portals/monthly-closing", label: "Monthly Closing", icon: CalendarRange }] : []),
        // The same closing, ranked — each sales manager over his own territory (owner, 2026-10-13).
        ...(showPerformanceReviewTab ? [{ href: "/employee-portals/monthly-closing/performance-review", label: "Performance Review", icon: Trophy }] : []),
        ...(showTeamPerformanceTab ? [{ href: "/employee-portals/team-performance", label: "Team Performance", icon: Trophy }] : []),
        ...(showMedRepsPerformanceTab ? [{ href: "/employee-portals/med-reps-performance", label: "MRs Performance", icon: ChartColumnBig }] : []),
        ...(showDsmsPerformanceTab ? [{ href: "/employee-portals/dsms-performance", label: "DSMs Performance", icon: Users }] : []),
        ...(showIncentiveTab ? [{ href: "/employee-portals/incentive", label: "Incentive", icon: Gift }] : []),
        ...(showProbationTab ? [{ href: "/employee-portals/probation", label: "Probation Tracker", icon: ClipboardCheck }] : []),
      ],
    },
    {
      title: "Forecast & Target",
      items: [
        ...(showMakeItHappenTab ? [{ href: "/employee-portals/make-it-happen", label: "Make It Happen", icon: Sparkles }] : []),
        // Daily Forecast — the CNS reps' boxes for today, pre-filled from the target (owner,
        // 2026-10-01: "put it under forecast in sidebar"). It is the Phoenix CRM tab of that name, so
        // it is gated by the module's own answer (`forecastIsOffered`: a CNS territory in scope),
        // never a role list — a Pedia or Anti Infective rep is never offered it.
        ...(showDailyForecastTab ? [{ href: "/employee-portals/field-crm/forecast", label: "Daily Forecast", icon: PackageCheck }] : []),
        // Read-only Targets. /sales/targets keeps the authoring tools and bounces portal roles away;
        // a Medical Rep is served their own targets only (owner, 2026-09-16).
        ...(showTargetsTab ? [{ href: "/employee-portals/targets", label: "Targets", icon: Target }] : []),
      ],
    },
    {
      title: "Recruitment",
      items: [
        ...(showVacanciesTab ? [{ href: "/employee-portals/vacancies", label: "Vacancies", icon: BriefcaseBusiness }] : []),
        // Only ever candidates for THIS manager's own open seats.
        ...(showMyCandidatesTab ? [{ href: "/employee-portals/recruitment-candidates", label: "My Candidates", icon: UsersRound }] : []),
        // Brick allocation and the rep-residence map, scope-guarded server-side.
        ...(showTerritoryManagementTab ? [{ href: "/employee-portals/territory-management", label: "Territory Management", icon: Waypoints }] : []),
        // NSM-only, scoped to his line server-side. Silent — the managers it measures never see it.
        ...(showManagerEngagementTab ? [{ href: "/employee-portals/recruitment-engagement", label: "Manager CV Engagement", icon: ClipboardList }] : []),
      ],
    },
    {
      title: "iReports 360",
      items: [
        // Every portal role sees their own CRM visits.
        ...(showMyVisitsTab ? [{ href: "/employee-portals/visits", label: "My Visits", icon: MapPinned }] : []),
        ...(showEarlyBirdsTab ? [{ href: "/employee-portals/early-birds", label: "Early Birds", icon: Sunrise }] : []),
        // The shared board every rep of every line is ranked on (owner, 2026-10-05).
        ...(showRanksTab ? [{ href: "/employee-portals/ranks", label: "Phoenix Ranks", icon: Award }] : []),
        // Full scoped CRM Master — self for a Medical Rep, the team's rows for DSM/RM/NSM.
        ...(showCrmMasterTab ? [{ href: "/employee-portals/crm", label: "CRM", icon: Database }] : []),
        ...(showRepsListTab ? [{ href: "/employee-portals/reps-list", label: "Reps List", icon: BookUser }] : []),
        ...(showDoubleVisitReportTab ? [{ href: "/employee-portals/dv-planner", label: "DV Planner", icon: CalendarCheck2 }] : []),
        ...(showDoubleVisitReportTab ? [{ href: "/employee-portals/double-visit-report", label: "Double Visit Report", icon: FileSpreadsheet }] : []),
        // Field Activity sits under the DV rows because it answers the next question about the same
        // day: those boards are how many and with whom, this one is one person's day end to end —
        // his stops, their GPS, the outstation claim against them. THE HREF IS THE PORTAL ONE. Its
        // first shipped catalog row pointed at /admin/field-activity, which the (admin) layout
        // bounces every portal-mode viewer away from, so this row is what actually makes the module
        // reachable for the five field seats that hold it.
        //
        // It arrived on main (#4700) AFTER the owner filled in his sidebar-placement sheet, so the
        // sheet has no answer for it — it keeps the place main gave it, here under iReports 360.
        ...(showFieldActivityTab ? [{ href: "/employee-portals/field-activity", label: "Field Activity", icon: MapPinned }] : []),
        // Coaching Analytics is NOT restored here: this branch took it off the sidebar on the
        // owner's own sheet, and main's ruling the same day set its flag to false anyway.
        ...(showTeamCalendarTab ? [{ href: "/employee-portals/team-calendar", label: "Team Calendar", icon: CalendarRange }] : []),
        // Field Absence Calendar (owner, 2026-10-18) — beside the Team Calendar it complements: that
        // one counts the visits each day holds, this one names who left no record at all.
        ...(showFieldAbsenceTab ? [{ href: "/employee-portals/field-absence", label: "Field Absence Calendar", icon: CalendarX2 }] : []),
      ],
    },
    {
      // KPIs is a heading of its own since 2026-10-14 (owner: "KPIs to be a title in the sidebar and
      // under it a report called frequency, another called coverage, and another called call rate").
      // The row that used to sit in iReports 360 is the Summary here — the consolidated page — and the
      // three measures each have a page of their own beneath it. One flag gates all four, the same
      // `showKpisTab` the single row carried, so no seat gains or loses a door.
      title: "KPIs",
      items: [
        ...(showKpisTab ? [{ href: "/employee-portals/kpis", label: "Summary", icon: TrendingUp }] : []),
        ...(showKpisTab ? [{ href: "/employee-portals/kpis/frequency", label: "Frequency", icon: Repeat2 }] : []),
        ...(showKpisTab ? [{ href: "/employee-portals/kpis/coverage", label: "Coverage", icon: Radar }] : []),
        ...(showKpisTab ? [{ href: "/employee-portals/kpis/call-rate", label: "Call Rate", icon: PhoneCall }] : []),
      ],
    },
    {
      title: "Marketing & ROI",
      items: [
        // Customer Validation rides its OWN flag: the Medical Rep keeps the field-capture screen
        // after the drafts workspace went dark for them (owner, 2026-09-18).
        ...(showMarketingValidationTab ? [{ href: "/employee-portals/marketing-requests/validation", label: "Customer Validation", icon: ShieldCheck }] : []),
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests", label: "Marketing Requests", icon: Send }] : []),
        // ROI Tracker — the marketing-ROI source of truth, and since 2026-09-22 the merged module (the
        // ROI pipeline and the former Coverage Report as two tabs), so it is offered on EITHER flag.
        ...(showMarketingRoiTrackingTab || showMarketingCoverageReportTab
          ? [{ href: "/employee-portals/roi-tracker", label: "ROI Tracker", icon: Target }]
          : []),
        ...(showMarketAwarenessTab ? [{ href: "/employee-portals/market-awareness", label: "Market Awareness", icon: Sparkles }] : []),
        // The Sales-Marketing-Intelligence module — distinct from ROI Tracker above.
        ...(showRoiIntelligenceTab ? [{ href: "/employee-portals/roi", label: "ROI Dashboard", icon: Target }] : []),
        ...(showMarketingControlTab ? [{ href: "/employee-portals/marketing-requests/control", label: "Marketing Control", icon: Settings2 }] : []),
        // Company-wide register — every request and where it is stopped.
        ...(showMarketingAllRequestsTab ? [{ href: "/employee-portals/marketing-requests/all", label: "All Marketing Requests", icon: ClipboardList }] : []),
        ...(showMarketingCustomerDatabaseTab ? [{ href: "/employee-portals/marketing-requests/customer-database", label: "Customer Database", icon: Database }] : []),
      ],
    },
    {
      title: "Payroll",
      items: [
        { href: "/employee-portals/payslips", label: "Payslips", icon: FileText },
        ...(showDeductionsTab ? [{ href: "/employee-portals/deductions", label: "Deductions", icon: ReceiptText }] : []),
        // My Disputes — the employee's own side of every dispute he raised, whichever module it came
        // from, with its conversation and its decision. Open to every portal role and self-scoped:
        // resolveCaseParticipant hands a non-reviewer only the cases he is the employee on.
        { href: "/employee-portals/disputes", label: "My Disputes", icon: Scale },
      ],
    },
    {
      title: "Outstation Expenses",
      items: [
        ...(showMedicalRepExpensesTab ? [{ href: "/employee-portals/expenses", label: "My Outstation Expenses", icon: ReceiptText }] : []),
        ...(showExpenseDashboardTab ? [{ href: "/employee-portals/expense-dashboard", label: "Expense Dashboard", icon: CircleDollarSign }] : []),
        // Shares showExpenseDashboardTab deliberately: anyone allowed to see expense figures is by
        // definition allowed to see his OWN submissions.
        ...(showExpenseDashboardTab ? [{ href: "/employee-portals/expense-submissions", label: "Expense Submissions", icon: ReceiptText }] : []),
        ...(showExpenseActionTab ? [{ href: "/employee-portals/submit-expense", label: "Submit Expense", icon: Send }] : []),
        ...(showTeamExpensesTab ? [{ href: "/employee-portals/team-expenses", label: "Team Expenses", icon: WalletCards }] : []),
      ],
    },
    {
      title: "Leaves Management",
      items: [
        { href: "/employee-portals/vacation-request", label: "Vacation Request", icon: CalendarDays },
        { href: "/employee-portals/vacation-report", label: "Vacation Report", icon: FileText },
        ...(showExcusesTab ? [{ href: "/employee-portals/excuses", label: "Excuses", icon: CalendarClock }] : []),
        ...(showFingerprintReportTab ? [{ href: "/employee-portals/fingerprint-analytics", label: "Attendance Analytics", icon: Fingerprint }] : []),
      ],
    },
    {
      title: "Other",
      items: [
        // ONE Report It row for everyone: the pharmacovigilance roles get the dashboard view of the
        // same page (showReportItDashboardTab), everyone else the report form (showReportItTab). The
        // two flags are exclusive, so nobody sees it twice.
        ...(showReportItDashboardTab || showReportItTab ? [{ href: "/employee-portals/report-it", label: "Report It", icon: FileText }] : []),
        ...(showSupportTab ? [{ href: "/employee-portals/contact-hr-support", label: "Request Support", icon: Headphones }] : []),
      ],
    },
  ].filter((section) => section.items.length > 0);
}

/**
 * The header's "today" chip is genuinely hydration-unsafe if computed inline: React
 * server-renders this component once (capturing "now" at the server's render instant) and
 * hydrates it client-side once more (capturing "now" again, independently, moments later).
 * `timeZone: "Africa/Cairo"` is already correct, so this is NOT the UTC-vs-Cairo bug class —
 * almost every render lands within the same Cairo calendar day and produces identical text, but a
 * page load straddling the Cairo midnight boundary lands the two computations on different days,
 * throwing React hydration error #418 (63% of production errors over the trailing 7 days,
 * confirmed live against public.app_error_events, spread across nearly every /employee-portals/*
 * route this header renders on).
 *
 * Same "server default, then correct after mount" shape as ThemeProvider
 * (src/components/layout/theme-provider.tsx): render nothing until mounted, so the server's HTML
 * and the client's first hydration pass are byte-identical regardless of which instant either side
 * lands on, then fill in the real date a moment later.
 */
function EmployeePortalHeaderDate() {
  const [label, setLabel] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    // Deferred through rAF rather than called synchronously in the effect body — same shape as
    // ThemeProvider — because this repo's react-hooks/set-state-in-effect lint rule is an ERROR,
    // not a warning, on a bare setState() inside useEffect.
    //
    // A LIVE clock since 2026-09-29 (owner, "godmode" item 13): the date, and the Cairo time on wide
    // screens, refreshed every 30 seconds. Still mount-only and still null before mount, so the
    // hydration guarantee above is unchanged.
    const tick = () => {
      const now = new Date();
      setLabel(
        now.toLocaleDateString("en-US", {
          day: "numeric",
          month: "short",
          timeZone: "Africa/Cairo",
          weekday: "short",
        }),
      );
      setTime(
        now.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "Africa/Cairo",
        }),
      );
    };
    const frame = window.requestAnimationFrame(tick);
    const interval = window.setInterval(tick, 30_000);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, []);

  if (!label) return null;

  return (
    <span className="whitespace-nowrap tabular-nums">
      {label}
      {time ? <span className="hidden xl:inline"> · {time}</span> : null}
    </span>
  );
}

/**
 * "Good morning, Ahmed" by Cairo's clock — and, when the connection drops, the warning instead,
 * because a rep in the field needs to know BEFORE he taps Save. Before mount it reads "Employee
 * Portal" exactly as the server rendered it, so the first client pass matches the HTML.
 *
 * On a phone the greeting stays "Employee Portal": the header's identity column has ~126px at 320px
 * wide, and a name that long would push the role label to three lines inside a 56px bar.
 */
function EmployeePortalGreeting({ firstName }: { firstName: string }) {
  const online = useIsOnline();
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setGreeting(greetingForHour(cairoHour(new Date())));
    const frame = window.requestAnimationFrame(tick);
    const interval = window.setInterval(tick, 300_000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, []);

  if (!online) {
    return (
      <p className="flex items-center gap-1 text-phx-4xs font-black uppercase tracking-[0.14em] text-red-600 sm:text-phx-3xs" role="status">
        <WifiOff className="h-3 w-3 shrink-0" />
        Offline — nothing will save
      </p>
    );
  }

  return (
    <p className="text-phx-4xs font-black uppercase tracking-[0.22em] text-orange-600 sm:text-phx-3xs sm:tracking-[0.26em]">
      <span className={greeting ? "sm:hidden" : undefined}>Employee Portal</span>
      {greeting ? (
        <span className="hidden normal-case tracking-[0.02em] sm:inline">
          {greeting}, {firstName}
        </span>
      ) : null}
    </p>
  );
}

function dispatchEmployeePortalRoutePending(href: string) {
  window.dispatchEvent(new CustomEvent(EMPLOYEE_ROUTE_PENDING_EVENT, { detail: { href } }));
}

function shouldUseClientNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.currentTarget.target &&
    isEmployeePortalOwnedRoute(href)
  );
}

function EmployeePortalRouteProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let fallbackTimeout: number | null = null;
    const handlePending = () => {
      setVisible(true);
      if (fallbackTimeout) {
        window.clearTimeout(fallbackTimeout);
      }
      fallbackTimeout = window.setTimeout(() => setVisible(false), 6000);
    };

    window.addEventListener(EMPLOYEE_ROUTE_PENDING_EVENT, handlePending);

    return () => {
      window.removeEventListener(EMPLOYEE_ROUTE_PENDING_EVENT, handlePending);
      if (fallbackTimeout) {
        window.clearTimeout(fallbackTimeout);
      }
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 180);
    return () => window.clearTimeout(timeout);
  }, [pathname]);

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-x-0 top-0 z-[70] h-[3px] origin-left bg-gradient-to-r from-orange-500 via-amber-400 to-sky-500 shadow-[0_0_18px_rgba(249,115,22,0.45)] transition duration-300 ${
        visible ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0"
      }`}
    />
  );
}

/**
 * A row's live pending count. ONE place for the portal's badge chain, so the sidebar rows, the
 * collapsed rail's flyout and anything else that draws a row cannot drift apart.
 */
function RowNavBadge({ navBadge }: { navBadge?: EmployeePortalNavItem["navBadge"] }) {
  if (navBadge === "approvals-hub-pending") return <NavBadge src="/api/approvals-hub/pending-count" />;
  if (navBadge === "vacation-approvals-pending") return <NavBadge src="/api/approvals/vacation/pending-count" />;
  if (navBadge === "excuse-approvals-pending") return <NavBadge src="/api/approvals/excuse/pending-count" />;
  if (navBadge === "plan-approvals-pending") return <NavBadge src="/api/approvals/plan/pending-count" />;
  if (navBadge === "direct-orders-needs-action") return <NavBadge src="/api/direct-orders/needs-action-count" />;
  if (navBadge === "marketing-approvals-pending") return <NavBadge src="/api/marketing-requests/pending-count" />;
  if (navBadge === "market-awareness-approvals-pending") return <NavBadge src="/api/market-awareness/pending-count" />;
  return null;
}

/**
 * The unified inbox (owner, 2026-09-29 — his "2-3-5", item 2): notifications and messages behind ONE
 * bell with two tabs and one combined unread badge, in place of two adjacent icons. Both feeds are the
 * EXISTING shared components rendered in their new `embedded` mode — no logic is duplicated, and the
 * admin top bar's own bell/messages are untouched (they pass no `embedded`). Both stay mounted while
 * the dropdown is closed (hidden), so each keeps polling and the badge stays live without opening it.
 */
function EmployeePortalInbox() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"notifications" | "messages">("notifications");
  const [notifUnread, setNotifUnread] = useState(0);
  const [messageUnread, setMessageUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction(ref, open, setOpen);
  const close = useCallback(() => setOpen(false), []);
  const total = notifUnread + messageUnread;

  const tabs: Array<{ id: "notifications" | "messages"; label: string; count: number }> = [
    { id: "notifications", label: "Notifications", count: notifUnread },
    { id: "messages", label: "Messages", count: messageUnread },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        aria-expanded={open}
        aria-label={total > 0 ? `Inbox, ${total} unread` : "Inbox"}
        className="relative inline-flex h-9 w-9 items-center justify-center text-phx-ink-soft transition hover:bg-phx-paper hover:text-phx-ink"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Inbox className="h-[18px] w-[18px]" />
        {total > 0 ? (
          <span
            aria-hidden="true"
            className="nav-badge-alarm absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center bg-phx-accent px-1 text-phx-3xs font-black text-white"
            ref={alarmGlowRef}
          >
            {total > 99 ? "99+" : total}
          </span>
        ) : null}
      </button>

      {/* Kept in the tree while closed (display:none), so both feeds keep polling and the badge is
          live before it is ever opened. */}
      <div
        className={
          open
            ? "absolute right-0 top-full z-40 mt-1.5 w-[min(92vw,400px)] overflow-hidden border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]"
            : "hidden"
        }
        aria-label="Inbox"
        role="dialog"
      >
        <div className="flex border-b border-slate-200" role="tablist">
          {tabs.map((entry) => (
            <button
              aria-selected={tab === entry.id}
              className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] transition ${
                tab === entry.id ? "border-b-2 border-[#F05A1A] text-[#F05A1A]" : "text-slate-500 hover:text-slate-800"
              }`}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
              {entry.count > 0 ? (
                <span className="flex h-4 min-w-4 items-center justify-center bg-[#F05A1A] px-1 text-phx-3xs font-black leading-none text-white">
                  {entry.count > 99 ? "99+" : entry.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-y-auto" style={{ maxHeight: HEADER_PANEL_MAX_HEIGHT }}>
          <div className={tab === "notifications" ? "" : "hidden"}>
            <InAppNotificationsBell embedded isAdminMode={false} onClose={close} onUnreadChange={setNotifUnread} />
          </div>
          <div className={tab === "messages" ? "" : "hidden"}>
            <InternalMessagesMenu embedded isAdminMode={false} onUnreadChange={setMessageUnread} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The top bar's "+ New" menu (owner, 2026-09-29 — his "2-3-5" pick). The actions the command bar
 * already offers, surfaced as one tap so a field user never needs the keyboard to start them. Each
 * action is gated by the same visibility flag its sidebar row is, so this can never offer something
 * the person cannot do. Renders nothing when the viewer has no action at all.
 */
function PortalQuickActions({
  onNavigate,
  visibility,
}: {
  onNavigate: (href: string) => void;
  visibility: EmployeePortalNavVisibility;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction(ref, open, setOpen);

  // The list itself lives in src/lib/employee-portal/portal-quick-actions.ts — one source for this
  // menu, the command bar and the phone bar's own action button. Its hrefs deliberately do NOT
  // appear in this file: tests/employee-portal-bottom-nav.test.ts reads every `href:` literal here
  // and demands each be a phone-bar registry entry, which a quick-action target never is.
  const actions = portalQuickActions(visibility);
  if (actions.length === 0) return null;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="New — start something"
        className="flex h-9 items-center gap-1.5 border border-[#F05A1A] bg-[#F05A1A] px-2.5 text-phx-xs font-black text-white shadow-[0_8px_20px_rgba(240,90,26,0.22)] transition hover:bg-[#d94e14] focus:outline-none focus:ring-2 focus:ring-orange-400/40 sm:px-3"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">New</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]" role="menu">
          <p className="border-b border-slate-100 px-3.5 py-2 text-phx-3xs font-black uppercase tracking-[0.18em] text-slate-400">Start something</p>
          {actions.map((action) => {
            const ActionIcon = PORTAL_QUICK_ACTION_ICONS[action.id];
            return (
              <button
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
                key={action.id}
                onClick={() => {
                  setOpen(false);
                  onNavigate(action.href);
                }}
                role="menuitem"
                type="button"
              >
                <ActionIcon className="h-4 w-4 shrink-0 text-orange-500" />
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** A stable id fragment for a section title — "Marketing & ROI" → "marketing-roi". */
function sectionSlug(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The viewer's own sections with "Pinned" in front. It is drawn FROM the sections — a pinned href no
 * longer on this person's sidebar simply drops out, so it can never offer a page the sidebar would
 * not. The "Recent" section was removed from the sidebar at the owner's word (2026-09-29); recent
 * pages still lead the command bar (⌘K), which is where they belong.
 */
function withPinned(
  sections: EmployeePortalNavSection[],
  pinnedHrefs: readonly string[],
): EmployeePortalNavSection[] {
  const byHref = new Map<string, EmployeePortalNavItem>();
  for (const section of sections) {
    for (const item of section.items) {
      if (!byHref.has(item.href)) byHref.set(item.href, item);
    }
  }
  const pinned = pinnedHrefs.map((href) => byHref.get(href)).filter((item): item is EmployeePortalNavItem => Boolean(item));
  return [
    ...(pinned.length > 0 ? [{ items: pinned, title: "Pinned", virtual: "pinned" as const }] : []),
    ...sections,
  ];
}

function EmployeePortalMenu({
  filterQuery = "",
  mode,
  onNavigate,
  onTogglePin,
  pathname,
  pinMode = false,
  pinnedHrefs,
  sections,
}: {
  /** The sidebar filter. While it holds text every section is open and Pinned / Recent step aside. */
  filterQuery?: string;
  mode: "desktop" | "mobile";
  onNavigate?: () => void;
  /**
   * Pins a row. On the desktop it is the star that appears on hover. A phone has no hover, so there it
   * is used only in pin mode, where a tap pins instead of opening.
   */
  onTogglePin?: (href: string) => void;
  pathname: string;
  /** Phone menu only: every row becomes a pin switch until the person taps Done. */
  pinMode?: boolean;
  pinnedHrefs?: readonly string[];
  sections: EmployeePortalNavSection[];
}) {
  const isMobile = mode === "mobile";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Resolved once for the whole menu, not per row: only the deepest matching href is active. Read
  // from the viewer's REAL sections only — a pinned or recent copy of a row never lights up, so the
  // marker always sits on the one row that lives where the page does.
  const baseSections = sections.filter((section) => !section.virtual);
  const activeHref = resolveActivePortalHref(pathname, baseSections);
  const activeSectionTitle = baseSections.find((section) =>
    section.items.some((item) => item.href.split("#")[0] === activeHref),
  )?.title;
  // Which of this viewer's modules a system administrator has temporarily locked. Portal rows carry
  // no permission metadata of their own — they are built from visibility flags — so the module
  // behind a row is resolved from its ADDRESS, through the very same map the page-level check uses.
  // One map, one answer: a padlocked row and the page it opens can never disagree.
  const lockedModuleKeys = useLockedModuleKeys();
  const storedCollapsedSections = useCollapsedSections();
  const collapsePreferenceSet = useCollapsePreferenceSet();
  // 🔴 THE DEFAULT FOLD STATE IS NOW *NOTHING FOLDED* (owner, 2026-10-03: "make the sidebar titles in
  // emp portal expanded not collapsed by default"). This REVERSES his 2026-09-29 default, which folded
  // every real section except My Workspace and left a rep reading a column of section names with a
  // count beside each one — he had to open a fold before he could see where anything was. Edit THIS
  // line if it changes again; never add a second rule beside it.
  //
  // Unchanged either side of it: the RAIL still opens collapsed to icons (his 2026-09-29 rule, a
  // separate preference — see getEmployeeSidebarCollapsedServerSnapshot); once this device folds or
  // opens anything by hand its explicit choice (storedCollapsedSections) takes over from this
  // default; and the active section is force-opened below regardless, so you always see where you are.
  const defaultCollapsedSections = NO_SECTIONS_FOLDED;
  const collapsedSections = collapsePreferenceSet ? storedCollapsedSections : defaultCollapsedSections;
  const filtering = filterQuery.trim().length > 0;
  const shownSections = filtering ? filterSections(baseSections, filterQuery) : sections;
  const rootRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setPendingHref(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [pathname]);

  // The sliding marker: ONE orange bar that glides to the lit row as you move, rather than a bar
  // drawn on each row. Placed by writing its style directly — a DOM measurement, not React state, so
  // no render loop and no setState inside an effect. It lands without animating the first time, so a
  // page load does not show it flying in from the top. Reduced motion turns the glide off in CSS.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const marker = markerRef.current;
    if (!root || !marker) return;
    const row = root.querySelector<HTMLElement>('[data-active-row="true"]');
    if (!row) {
      marker.style.opacity = "0";
      return;
    }
    const firstPlacement = marker.dataset.placed !== "true";
    if (firstPlacement) marker.style.transition = "none";
    marker.style.height = `${row.offsetHeight}px`;
    marker.style.transform = `translateY(${row.offsetTop}px)`;
    marker.style.opacity = "1";
    if (firstPlacement) {
      void marker.offsetHeight;
      marker.style.transition = "";
      marker.dataset.placed = "true";
    }
  });

  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!shouldUseClientNavigation(event, href)) {
      onNavigate?.();
      return;
    }

    const hrefPath = href.split("#")[0];
    if (hrefPath === pathname) {
      onNavigate?.();
      return;
    }

    event.preventDefault();
    setPendingHref(href);
    dispatchEmployeePortalRoutePending(href);
    onNavigate?.();
    startTransition(() => router.push(href));
  };

  return (
    <div className="relative" ref={rootRef}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-10 w-[3px] bg-[#F05A1A] opacity-0 shadow-[0_0_14px_rgba(240,90,26,0.85)] transition-[transform,height,opacity] duration-300 ease-out motion-reduce:transition-none"
        ref={markerRef}
      />
      {shownSections.length === 0 ? (
        <p className="px-3 py-4 text-sm font-semibold text-slate-500">No page on your sidebar matches that.</p>
      ) : null}
      <div className={isMobile ? "space-y-4" : "space-y-3"}>
        {shownSections.map((section, sectionIndex) => {
          const isActiveSection = !section.virtual && section.title === activeSectionTitle;
          // The section you are in never folds away — folding it would hide the very row that says
          // where you are. A filter opens everything, so a match is never hidden in a folded section.
          const canFold = !isActiveSection && !filtering;
          const folded = canFold && collapsedSections.includes(section.title);
          const sectionId = `employee-portal-${mode}-section-${sectionSlug(section.title)}`;
          const badged = section.items.flatMap((item) => (item.navBadge ? [item.navBadge] : []));
          const SectionIcon =
            section.virtual === "pinned" ? Star : sectionRailIcon(section.title);
          return (
            <div
              key={section.title}
              className={
                sectionIndex < shownSections.length - 1
                  ? isMobile
                    ? "border-b border-orange-100/70 pb-4"
                    : "border-b border-[#E9EDF5] pb-3"
                  : undefined
              }
            >
              {section.hideTitle ? null : (
                <button
                  aria-controls={sectionId}
                  aria-expanded={!folded}
                  className={`${isMobile ? "mb-2" : "mb-1.5"} flex w-full items-center justify-between gap-2 px-3 pt-1 text-left disabled:cursor-default`}
                  disabled={!canFold}
                  onClick={() => writeStoredList(PORTAL_COLLAPSED_SECTIONS_KEY, toggleInList(collapsedSections, section.title))}
                  title={isActiveSection ? "You are in this section" : folded ? `Open ${section.title}` : `Fold ${section.title}`}
                  type="button"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <SectionIcon className="h-3 w-3 shrink-0 text-[#F05A1A]" />
                    <span
                      className={
                        isMobile
                          ? "text-phx-2xs font-black uppercase tracking-[0.16em] text-[#1D2B42]"
                          : "text-phx-3xs font-black uppercase tracking-[0.18em] text-[#344073]"
                      }
                    >
                      {section.title}
                    </span>
                    {folded && badged.length > 0 ? <PortalPendingCount navBadges={badged} tone="inline" /> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-phx-3xs font-black tabular-nums text-slate-400">{section.items.length}</span>
                    {isActiveSection ? (
                      <span aria-hidden="true" className="h-1.5 w-1.5 bg-[#F05A1A] shadow-[0_0_8px_rgba(240,90,26,0.9)]" />
                    ) : (
                      <ChevronDown
                        className={`${isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} text-[#F05A1A] transition-transform duration-200 motion-reduce:transition-none ${
                          folded ? "-rotate-90" : ""
                        }`}
                      />
                    )}
                  </span>
                </button>
              )}
              <div className={`${folded ? "hidden" : ""} ${isMobile ? "space-y-1" : "space-y-0.5"}`} id={sectionId}>
                {section.items.map((item) => {
                  const active = !section.virtual && item.href.split("#")[0] === activeHref;
                  const pending = isPending && pendingHref === item.href;
                  const locked = isNavItemLockedFor({ href: item.href }, lockedModuleKeys);
                  const pinned = pinnedHrefs?.includes(item.href) ?? false;
                  // The hover star is a desktop control: on a phone an invisible button over the icon
                  // would turn a tap meant to OPEN the page into a pin. The phone pins in pin mode.
                  const canPin = Boolean(onTogglePin) && !locked && !isMobile;
                  // The padlock REPLACES the row's icon rather than joining it. The label keeps its
                  // full width that way, which matters here: the portal's label span has no `truncate`,
                  // so anything added beside a long label wraps to a second line — and wrapping is
                  // exactly what the owner's standing rule forbids. The pin star follows the same rule:
                  // it appears IN PLACE of the icon on hover, so no row gets a pixel wider.
                  const RowIcon = locked ? Lock : item.icon;
                  // The sidebar's one standout row (owner, 2026-09-30) — Phoenix CRM. A locked row keeps
                  // its padlock treatment: "you cannot open this" must beat "this is the flagship". In pin
                  // mode the row falls through to the pin switch below, like every other row.
                  const highlighted = item.highlight === true && !locked;
                  if (pinMode) {
                    // Pin mode: a tap pins or unpins, and opens nothing. The star takes the icon's
                    // place, as the desktop hover star does, so no label loses a pixel of width.
                    return (
                      <button
                        aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                        aria-pressed={pinned}
                        className={`flex w-full items-center gap-3 rounded px-4 py-2.5 text-left ${
                          isMobile ? "text-phx-md font-semibold duration-200" : "text-phx-sm font-bold duration-150"
                        } transition disabled:opacity-50 ${pinned ? "bg-[#FFF0E7] text-[#F05A1A]" : "text-[#26334F] hover:bg-[#FFF6F0]"}`}
                        disabled={locked}
                        key={item.href}
                        onClick={() => onTogglePin?.(item.href)}
                        type="button"
                      >
                        <Star className={`h-4 w-4 shrink-0 ${pinned ? "fill-current text-[#F05A1A]" : "text-slate-400"}`} />
                        <span>{item.label}</span>
                      </button>
                    );
                  }
                  return (
                    <div className="group/row relative" data-active-row={active ? "true" : undefined} key={item.href}>
                      {/* THE PREMIUM PLATE (owner, 2026-09-30: "it needs a more premium polish").
                          Premium here is DEPTH, never colour and never corners: a crisp white face, a
                          warm hairline and one soft shadow in the brand's own orange, lifting the row a
                          millimetre off the sidebar's faint gradient. It is drawn as its own layer
                          BEHIND the link — `inset-0`, `pointer-events-none`, painted before the rail —
                          so the row's box is untouched: no border adds a pixel, nothing shifts the
                          label off the siblings' left edge, and the click still belongs to the link.
                          🔴 Square, and it stays square: the standing rule is no round or semi-round
                          corners anywhere, and the note on restoring premium polish from history is
                          explicit — take the DEPTH only, never the radius. It also carries no fill,
                          so it cannot drift back into impersonating the active row. */}
                      {highlighted ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 border border-[#F3D8C4] bg-white shadow-[0_10px_24px_rgba(240,90,26,0.10)] transition group-hover/row:border-[#F0C3A3] group-hover/row:shadow-[0_12px_28px_rgba(240,90,26,0.16)]"
                        />
                      ) : null}
                      <Link
                        aria-busy={pending || undefined}
                        aria-current={active ? "page" : undefined}
                        aria-label={locked ? `${item.label} — locked` : undefined}
                        title={locked ? `${item.label} — temporarily locked by the system administrator` : undefined}
                        className={`group relative flex items-center ${highlighted ? "gap-3.5" : "gap-3"} ${highlighted ? "" : "rounded"} px-4 ${highlighted ? "py-3" : "py-2.5"} ${
                          isMobile ? "text-phx-md font-semibold duration-200" : "text-phx-sm font-bold duration-150"
                        } transition ${
                          pending
                            ? "bg-phx-accent-soft text-phx-accent-hover ring-1 ring-orange-200/80"
                            : highlighted && !active
                              ? NAV_HIGHLIGHT_CLASS
                              : navItemClass(active)
                        }`}
                        href={item.href}
                        onClick={(event) => handleNavigate(event, item.href)}
                        // 🔴 NOT `prefetch` (a FULL prefetch): that rendered every visible row's whole
                        // page on the server the moment the sidebar drew — ~15 pages per portal load,
                        // measured 4.5–7.5 s each in production — and a tap queued behind them. The
                        // default prefetches down to the page's loading.tsx, so the skeleton is still
                        // instant; this upgrades to the full page on touchstart / mouseenter only.
                        // Needs `experimental.dynamicOnHover` in next.config.ts.
                        unstable_dynamicOnHover
                      >
                        {/* The standout row wears the Phoenix LOGO before its name (owner, 2026-09-30:
                            "before the Phoenix CRM, put the logo") — the same asset and the same
                            light-orange plate the sidebar's own header lockup uses a few hundred lines
                            below, so the rail reads as one identity rather than two. It takes the
                            icon's PLACE rather than joining it, and the row carries no trailing glyph,
                            so the row is NARROWER than a sibling and no label can be pushed to a
                            second line. It hides on hover exactly as an icon does, or the pin star
                            would land on top of it. */}
                        {highlighted ? (
                          // The logo is set in a stamped emblem tile rather than dropped in loose: a
                          // square warm plate with its own hairline, the mark inset so it is not
                          // touching an edge. That inset is what makes it read as an emblem — the
                          // premium detail is the tile, not a bigger picture of the bird.
                          <span
                            aria-hidden="true"
                            className={`${
                              isMobile ? "h-[26px] w-[26px]" : "h-[24px] w-[24px]"
                            } flex shrink-0 items-center justify-center border border-[#F6D4B8] bg-[#FFF7ED] transition ${adminChipDepthClassName} ${
                              canPin ? "group-hover/row:opacity-0" : ""
                            }`}
                          >
                            <Image
                              alt=""
                              className={`${isMobile ? "h-[17px] w-[17px]" : "h-[15px] w-[15px]"} object-contain`}
                              height={40}
                              src={systemAssets.iconLogo}
                              width={40}
                            />
                          </span>
                        ) : (
                          <RowIcon
                            className={`${
                              isMobile ? "h-4 w-4" : "h-[15px] w-[15px] stroke-[2.1]"
                            } shrink-0 transition ${canPin ? "group-hover/row:opacity-0" : ""} ${
                              pending
                                ? "text-phx-accent-hover"
                                : locked
                                  ? "text-amber-600"
                                  : navIconClass(active)
                            }`}
                          />
                        )}
                        {/* A whisper of letter-spacing on the standout row's name, and nothing else:
                            the siblings' size and weight are kept deliberately. A face or a size of
                            its own was already tried on this row and thrown out — the polish is in the
                            plate, the emblem and the spacing, never in a different typeface. */}
                        <span className={`${highlighted ? "tracking-[0.015em]" : ""} ${locked ? "opacity-70" : ""}`.trim() || undefined}>{item.label}</span>
                        <RowNavBadge navBadge={item.navBadge} />
                        {pending ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-orange-500 employee-portal-nav-pending-dot" ref={alarmGlowRef} /> : null}
                      </Link>
                      {/* The heavy orange block down the left edge — the loudest part of the highlight
                          now that the row carries no fill. Absolutely positioned, so the row is not one
                          pixel wider and no label can be pushed into a second line; pointer-events-none,
                          so it never eats a click meant for the link or the pin star at left-2.5. It
                          stays on when the row is ACTIVE, so the active fill appears BEHIND it rather
                          than replacing it. */}
                      {highlighted ? (
                        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-[4px] bg-[#F05A1A]" />
                      ) : null}
                      {canPin && onTogglePin ? (
                        <button
                          aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label} to the top`}
                          aria-pressed={pinned}
                          className={`absolute left-2.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center opacity-0 transition group-hover/row:opacity-100 ${
                            pinned ? "text-[#F05A1A]" : "text-slate-400 hover:text-[#F05A1A]"
                          }`}
                          onClick={() => onTogglePin(item.href)}
                          tabIndex={-1}
                          title={pinned ? "Unpin — it also leaves your phone bar" : "Pin to the top — it also goes on your phone bar"}
                          type="button"
                        >
                          <Star className={`h-[15px] w-[15px] ${pinned ? "fill-current" : ""}`} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EmployeePortalTopNav({
  activePathOverride,
  data,
  disableSessionGuard = false,
  focusMode = false,
  onOpenCommandBar,
  onShowShortcuts,
  visibility,
}: EmployeePortalNavProps & {
  /** Focus mode hides the bar — it stays MOUNTED, so the session guard and push binding keep running. */
  focusMode?: boolean;
  onOpenCommandBar?: () => void;
  onShowShortcuts?: () => void;
}) {
  const currentPathname = usePathname();
  const router = useRouter();
  const pathname = activePathOverride ?? currentPathname;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState("");
  // Pin mode in the phone menu: every row becomes a pin switch. Always off when the menu opens.
  const [pinMode, setPinMode] = useState(false);
  // Outside click and Escape close the user menu — the admin Topbar has done this since 2026-07-24
  // (8e7d3ca8d) and the portal header never got the same fix, so an opened menu stayed on screen
  // over the page until its own button was pressed again, swallowing the clicks meant for what sat
  // underneath it.
  const userMenuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction(userMenuRef, userMenuOpen, setUserMenuOpen);
  const lockedModuleKeys = useLockedModuleKeys();
  const [pinnedHrefs, setPinnedHrefs] = useBottomNavPreference();
  const togglePin = (href: string) => setPinnedHrefs(togglePinnedHref(pinnedHrefs, href, shownDefaultBottomNavHrefs(visibility)));
  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
    setPinMode(false);
  };
  const employeeName = data.employee.fullName.trim();
  const firstName = employeeName.split(/\s+/)[0] || "Employee";
  // The person's own face: the photo they uploaded, else the bundled one, else their initials.
  const photoSrc = data.employee.photoUrl ?? employeeProfileImageForHrId(data.employee.hrId);

  const menuSections = buildEmployeePortalSections(visibility);
  const crumb = breadcrumbFor(pathname, menuSections);
  const drawerSections = withPinned(menuSections, pinnedHrefs);
  // The Menu button carries the "waiting on you" number below the laptop width, where the chip is not.
  // It is the number only: a "Waiting on you" card at the top of the phone menu was built the same day
  // and the owner had it removed on sight (2026-09-29) — each queue's row already carries its count.
  const queueBadges = waitingQueues(menuSections).flatMap((queue) => (queue.navBadge ? [queue.navBadge] : []));
  const searchTerm = searchQuery.trim().toLowerCase();
  const searchMatches = searchTerm
    ? menuSections
      .flatMap((section) =>
        section.items.map((item) => ({
          ...item,
          section: section.title,
        })),
      )
      .filter((item) =>
        `${item.label} ${item.section}`.toLowerCase().includes(searchTerm),
      )
      .slice(0, 6)
    : [];
  const activeSearchIndex = Math.min(searchActiveIndex, Math.max(searchMatches.length - 1, 0));
  const searchListOpen = searchOpen && searchTerm.length > 0;

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Escape closes the drawer, as it does every other overlay in the app.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileMenuOpen]);

  const handleLogout = async () => {
    // Unbind this browser from the signed-out user's OneSignal identity first — best
    // effort, never blocks sign-out — so a shared device doesn't keep receiving their
    // pushes after someone else signs in.
    logoutOneSignal();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      hardNavigate("/login");
    }
  };

  const navigateTo = (href: string) => {
    dispatchEmployeePortalRoutePending(href);
    router.push(href);
  };

  const navigateToSearchResult = (href: string) => {
    setSearchQuery("");
    setSearchOpen(false);
    navigateTo(href);
  };

  const userMenuLinkClass =
    "flex w-full items-center gap-2 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700";

  return (
    <>
      {disableSessionGuard ? null : <SessionSecurityGuard />}
      <OneSignalProvider />
      <header
        className={`fixed inset-x-0 top-0 z-30 w-full border-b border-slate-200/80 bg-white/96 shadow-[0_12px_34px_rgba(15,23,42,0.10)] backdrop-blur-2xl ${
          focusMode ? "hidden" : ""
        }`}
      >
        {/* The brand's three-colour hairline along the bar's top edge. */}
        <div aria-hidden="true" className="h-[2px] w-full bg-gradient-to-r from-sky-500 via-[#F05A1A] to-emerald-500" />
        <div className="mx-auto flex h-[54px] w-full max-w-[1560px] items-center gap-1.5 px-2 sm:gap-2.5 sm:px-4 lg:h-[62px] lg:px-8">
          <button
            aria-label="Menu"
            aria-controls="employee-portal-mobile-sidebar"
            aria-expanded={mobileMenuOpen}
            className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded border border-orange-200 bg-orange-50 text-orange-700 shadow-[0_6px_16px_rgba(249,115,22,0.10)] transition hover:border-orange-300 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-500/20 lg:hidden"
            onClick={() => {
              setPinMode(false);
              setMobileMenuOpen((open) => !open);
            }}
            type="button"
          >
            <Menu className="h-4 w-4" />
            {queueBadges.length > 0 ? <PortalPendingCount navBadges={queueBadges} tone="menu" /> : null}
          </button>
          {/* `md:flex-none`, not `flex-1`, from the width where the search box appears. Measured
              2026-09-05 at 768x900: `flex-1` is `flex: 1 1 0%`, so this block's basis is ZERO and it
              was squeezed to 80px while the search input held its full 384px. The role label then
              overflowed its own box — "Medical Representative" lost 41px, and every one of the seven
              roles lost between 8 and 41px, cut mid-word under the search box with no ellipsis to
              show anything was missing. `main` measured a clean 736/736 throughout, because clipped
              content contributes nothing to scrollWidth. Content width here costs the input 41px,
              which an input can spare. The label also dropped `whitespace-nowrap`: if a longer job
              title ever arrives it must WRAP (hence `leading-tight`, which keeps two lines inside the
              56px bar), never clip. */}
          <div className="flex min-w-0 flex-1 items-center md:flex-none">
            <div className="min-w-0">
              <EmployeePortalGreeting firstName={firstName} />
              <p className="text-phx-2xs font-bold leading-tight text-slate-500 sm:text-phx-xs">{data.employee.roleLabel}</p>
            </div>
          </div>

          {/* "You are here" — the section and the page, from wide screens up. It wraps inside its
              260px rather than clipping; the bar's height holds two lines. */}
          {crumb ? (
            <p
              aria-label={`You are here: ${crumb.section}, ${crumb.label}`}
              className="hidden max-w-[260px] shrink-0 border-l border-slate-200 pl-3 text-phx-xs font-bold leading-tight text-slate-400 xl:block"
            >
              {crumb.section}
              <ChevronRight className="mx-1 inline h-3 w-3 align-[-2px] text-orange-500" />
              <span className="text-slate-800">{crumb.label}</span>
            </p>
          ) : null}

          <div className="relative ml-auto hidden w-full max-w-sm items-center md:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
            <input
              aria-activedescendant={searchListOpen && searchMatches.length > 0 ? `employee-portal-search-option-${activeSearchIndex}` : undefined}
              aria-autocomplete="list"
              aria-controls="employee-portal-search-results"
              aria-expanded={searchListOpen}
              aria-label="Search"
              className={cn(phxFieldClassName, "pl-9 md:pr-[76px]")}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchActiveIndex(0);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  return;
                }
                // The list announced itself as a listbox but only Enter worked, and only on the
                // first row: the other five results could be reached by mouse alone.
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (searchMatches.length === 0) return;
                  event.preventDefault();
                  setSearchOpen(true);
                  setSearchActiveIndex((index) =>
                    event.key === "ArrowDown"
                      ? Math.min(index + 1, searchMatches.length - 1)
                      : Math.max(index - 1, 0),
                  );
                  return;
                }
                const chosen = searchMatches[activeSearchIndex];
                if (event.key === "Enter" && chosen) {
                  event.preventDefault();
                  navigateToSearchResult(chosen.href);
                }
              }}
              placeholder="Search portal pages..."
              role="combobox"
              value={searchQuery}
              type="text"
            />
            {onOpenCommandBar ? (
              <button
                aria-label="Open the command bar (Ctrl K)"
                className={`absolute right-1.5 hidden h-7 items-center gap-1 border border-slate-200 bg-white px-1.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-slate-500 transition hover:border-orange-300 hover:text-orange-700 md:flex ${adminControlDepthClassName}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onOpenCommandBar();
                }}
                title="Command bar — go anywhere, do anything (Ctrl K or /)"
                type="button"
              >
                <Command className="h-3 w-3" />K
              </button>
            ) : null}
            {searchListOpen ? (
              <div
                className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]"
                id="employee-portal-search-results"
                role="listbox"
              >
                {searchMatches.length > 0 ? (
                  searchMatches.map((item, index) => {
                    // The padlock the sidebar row wears, here too — a locked module offered with its
                    // normal icon reads as open until the notice page says otherwise.
                    const locked = isNavItemLockedFor({ href: item.href }, lockedModuleKeys);
                    const ResultIcon = locked ? Lock : item.icon;
                    return (
                    <button
                      aria-label={locked ? `${item.label} — locked` : undefined}
                      aria-selected={index === activeSearchIndex}
                      className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-orange-50 ${
                        index === activeSearchIndex ? "bg-orange-50" : ""
                      }`}
                      id={`employee-portal-search-option-${index}`}
                      key={`${item.section}-${item.href}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        navigateToSearchResult(item.href);
                      }}
                      role="option"
                      tabIndex={-1}
                      type="button"
                    >
                      <ResultIcon className={`h-4 w-4 shrink-0 ${locked ? "text-amber-600" : "text-orange-500"}`} />
                      {/* WRAPS, never `whitespace-nowrap`: this panel is exactly as wide as the search
                          box, which gives up width to everything else in the header — roughly 180-230px
                          at a 1024px window once the date, waiting-on-you and zoom controls appear,
                          where "Weekly / Monthly Plan" or "Territory Management" plus the icon no
                          longer fit, and the panel's `overflow-hidden` cut the label mid-word with no
                          ellipsis to show it. */}
                      <span className={`min-w-0 ${locked ? "opacity-70" : ""}`}>
                        <span className="block text-sm font-bold text-slate-800">{item.label}</span>
                        <span className="block text-phx-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{item.section}</span>
                      </span>
                    </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-3 text-sm font-semibold text-slate-500">
                    No matching portal pages.
                  </div>
                )}
              </div>
            ) : null}
          </div>
          {/* Below the width where the search box appears there is no box and no keyboard for Ctrl K,
              so this opens the same command bar: every page, recent and pinned first, and the
              actions. Measured 2026-09-29 at 320px: it leaves the role label 84px, and every portal
              role label fits that in two lines. */}
          {onOpenCommandBar ? (
            <button
              aria-label="Search pages and actions"
              className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink md:hidden"
              onClick={onOpenCommandBar}
              type="button"
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
          ) : null}
          {/* The date reads first (lg+), then the "waiting on you" chip, then a hairline that
              separates the ambient readouts from the action controls to their right — the polish pass
              of 2026-09-29 grouped what used to be a loose row of mismatched chips. */}
          <div className={`hidden items-center gap-1.5 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-semibold text-slate-500 lg:flex ${adminSoftDepthClassName}`}>
            <CalendarClock className="h-3 w-3 text-slate-400" />
            <EmployeePortalHeaderDate />
          </div>
          <WaitingOnYouChip onNavigate={navigateTo} sections={menuSections} />
          <PortalQuickActions onNavigate={navigateTo} visibility={visibility} />
          {/* One bordered cluster for the ambient icon controls — zoom · notifications · messages —
              with hairline dividers, so they read as one control group at even 36px targets rather
              than three floating buttons. */}
          <div className={`flex shrink-0 items-center border border-slate-200 bg-white [&>*:not(:first-child)]:border-l [&>*]:border-slate-200 ${adminSoftDepthClassName}`}>
            <DisplayScaleControl isAdminMode={false} />
            <EmployeePortalInbox />
          </div>
          <div className="relative flex shrink-0" ref={userMenuRef}>
            <button
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              aria-label={`Account menu for ${employeeName}`}
              className="flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-1.5 py-1 shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition hover:border-orange-200 hover:bg-orange-50/70 sm:px-2"
              onClick={() => setUserMenuOpen((open) => !open)}
              type="button"
            >
              <PortalAvatar fullName={employeeName} photoSrc={photoSrc} size="h-7 w-7" />
              <div className="hidden pr-0.5 text-left sm:block">
                <p className="text-xs font-semibold text-slate-800 whitespace-nowrap">{firstName}</p>
              </div>
              <ChevronDown className="hidden h-3 w-3 text-slate-400 sm:block" />
            </button>

            {userMenuOpen ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded border border-slate-200 bg-white shadow-lg"
                role="menu"
              >
                <div className="flex items-center gap-3 border-b border-slate-100 px-3.5 py-3">
                  <PortalAvatar fullName={employeeName} photoSrc={photoSrc} size="h-10 w-10" />
                  <div className="min-w-0">
                    <p className="text-sm font-black text-slate-900">{data.employee.fullName}</p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">{data.employee.roleLabel}</p>
                    <p className="mt-0.5 font-mono text-phx-2xs font-bold uppercase tracking-[0.10em] text-orange-600">
                      {data.employee.hrId}
                    </p>
                  </div>
                </div>
                <Link className={userMenuLinkClass} href="/employee-portals/profile" onClick={() => setUserMenuOpen(false)} role="menuitem">
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                <Link className={userMenuLinkClass} href="/employee-portals/payslips" onClick={() => setUserMenuOpen(false)} role="menuitem">
                  <FileText className="h-4 w-4" />
                  Payslips
                </Link>
                <Link className={userMenuLinkClass} href="/employee-portals/vacation-request" onClick={() => setUserMenuOpen(false)} role="menuitem">
                  <CalendarDays className="h-4 w-4" />
                  Vacation Request
                </Link>
                {onShowShortcuts ? (
                  <button
                    className={`${userMenuLinkClass} hidden lg:flex`}
                    onClick={() => {
                      setUserMenuOpen(false);
                      onShowShortcuts();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Keyboard className="h-4 w-4" />
                    Keyboard shortcuts
                  </button>
                ) : null}
                <div className="mx-3 h-px bg-slate-100" />
                <button
                  className={userMenuLinkClass}
                  onClick={() => {
                    setUserMenuOpen(false);
                    void handleLogout();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <LogOut className="h-4 w-4" />
                  Log Out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* Mobile Sidebar Overlay — inert while closed like the drawer below, or its invisible
          full-screen "Close menu" button stays the first stop in the Tab order. */}
      <button
        aria-label="Close menu"
        className={`fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        inert={!mobileMenuOpen}
        onClick={closeMobileMenu}
        type="button"
      />

      {/* Mobile Sidebar Content */}
      {/* `inert` while closed, as the admin drawer (MobileSidebar) is. A closed drawer is only slid
          off-screen, so without it every link inside stayed in the Tab order: a keyboard user tabbed
          through every one of its invisible rows before reaching the page, and `aria-hidden` over
          focusable links is itself an accessibility fault. */}
      <div
        aria-hidden={!mobileMenuOpen}
        className="fixed inset-y-0 left-0 z-50 flex h-dvh max-h-dvh w-[min(88vw,320px)] flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out will-change-transform lg:hidden"
        id="employee-portal-mobile-sidebar"
        inert={!mobileMenuOpen}
        style={{ transform: mobileMenuOpen ? "translate3d(0, 0, 0)" : "translate3d(-100%, 0, 0)" }}
      >
        {/* Who is signed in, at the top where the eye lands — it used to be an empty strip holding
            only the X, with the person tucked away at the very bottom. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 pb-3.5 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <PortalAvatar fullName={employeeName} photoSrc={photoSrc} size="h-11 w-11" />
            <div className="min-w-0">
              <p className="text-sm font-black text-slate-900">{data.employee.fullName}</p>
              <p className="mt-0.5 text-phx-2xs font-bold uppercase tracking-[0.12em] text-orange-600">{data.employee.roleLabel}</p>
            </div>
          </div>
          <button
            aria-label="Close menu"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-100 text-slate-400 hover:text-slate-600"
            onClick={closeMobileMenu}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter the drawer as you type — on a phone, the fastest way to one of forty rows. The star
            beside it turns pin mode on: type to find a page, tap it to pin it. */}
        <div className="shrink-0 px-4 pb-1 pt-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                aria-label="Filter the menu"
                className={cn(phxFieldClassName, "pl-9 pr-9")}
                onChange={(event) => setDrawerFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && drawerFilter) {
                    event.stopPropagation();
                    setDrawerFilter("");
                  }
                }}
                placeholder="Filter pages"
                type="text"
                value={drawerFilter}
              />
              {drawerFilter ? (
                <button
                  aria-label="Clear the filter"
                  className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700"
                  onClick={() => setDrawerFilter("")}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <button
              aria-label={pinMode ? "Done pinning" : "Pin pages"}
              aria-pressed={pinMode}
              className={`flex h-10 w-10 shrink-0 items-center justify-center border transition ${
                pinMode
                  ? "border-[#F05A1A] bg-[#F05A1A] text-white"
                  : "border-slate-200 bg-slate-50 text-slate-500 hover:border-orange-300 hover:text-orange-700"
              }`}
              onClick={() => setPinMode((on) => !on)}
              title={pinMode ? "Done pinning" : "Pin pages"}
              type="button"
            >
              {pinMode ? <Check className="h-4 w-4" /> : <Star className="h-4 w-4" />}
            </button>
          </div>
          {pinMode ? (
            <p className="mt-2 text-xs font-semibold leading-snug text-slate-500">
              Tap a page to pin it to the top of this menu. Your four newest pins are also your phone bar.
            </p>
          ) : null}
        </div>

        <nav className="phoenix-employee-sidebar-scroll flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-2">
          <EmployeePortalMenu
            filterQuery={drawerFilter}
            mode="mobile"
            onNavigate={() => {
              setDrawerFilter("");
              closeMobileMenu();
            }}
            onTogglePin={togglePin}
            pathname={pathname}
            pinMode={pinMode}
            pinnedHrefs={pinnedHrefs}
            sections={drawerSections}
          />

          <div className="mt-3 border-t border-slate-100 pt-3">
            <button
              className="flex w-full items-center gap-3 rounded px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
              onClick={() => {
                closeMobileMenu();
                void handleLogout();
              }}
              type="button"
            >
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </button>
          </div>
        </nav>
      </div>
    </>
  );
}

export function EmployeePortalSidebar({
  activePathOverride,
  visibility,
}: {
  activePathOverride?: string;
  visibility: EmployeePortalNavVisibility;
}) {
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const collapsed = useSyncExternalStore(
    subscribeToEmployeeSidebarCollapsed,
    getEmployeeSidebarCollapsedSnapshot,
    getEmployeeSidebarCollapsedServerSnapshot,
  );
  const [filter, setFilter] = useState("");
  const [pinnedHrefs, setPinnedHrefs] = useBottomNavPreference();
  const lockedModuleKeys = useLockedModuleKeys();

  const sections = buildEmployeePortalSections(visibility);
  const shellActiveHref = resolveActivePortalHref(pathname, sections);
  const activeSectionTitle = sections.find((section) =>
    section.items.some((item) => item.href.split("#")[0] === shellActiveHref),
  )?.title;
  const menuSections = withPinned(sections, pinnedHrefs);

  const toggleCollapsed = () => setEmployeeSidebarCollapsed(!collapsed);
  // ONE set of favourites: a star here writes the same list the phone bar and its customizer on
  // My Profile read, so a pin made at the desk is on the phone in the field.
  const togglePin = (href: string) => setPinnedHrefs(togglePinnedHref(pinnedHrefs, href, shownDefaultBottomNavHrefs(visibility)));

  // ── Pop-out sections on the collapsed rail ──────────────────────────────────────────────────
  // Folded, the sidebar used to be a strip of icons that could only jump to each section's FIRST
  // page. Hovering or focusing an icon now slides that section's pages out beside the rail, with
  // their live counts. Fixed to the viewport from the icon's own rect, and rendered OUTSIDE the
  // sticky card: the card is `overflow-hidden` and blurred, and a blurred ancestor would capture a
  // fixed child and clip it.
  const [flyout, setFlyout] = useState<{ left: number; title: string; top: number } | null>(null);
  const flyoutCloseTimer = useRef<number | null>(null);
  const cancelFlyoutClose = () => {
    if (flyoutCloseTimer.current !== null) {
      window.clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  };
  const scheduleFlyoutClose = () => {
    cancelFlyoutClose();
    flyoutCloseTimer.current = window.setTimeout(() => setFlyout(null), 180);
  };
  const openFlyout = (title: string, anchor: HTMLElement) => {
    if (!collapsed) return;
    cancelFlyoutClose();
    const rect = anchor.getBoundingClientRect();
    setFlyout({ left: Math.round(rect.right + 12), title, top: Math.max(8, Math.round(rect.top - 6)) });
  };
  const flyoutSection = collapsed && flyout ? sections.find((section) => section.title === flyout.title) : undefined;

  useEffect(() => {
    if (!flyout) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFlyout(null);
    };
    // A tap anywhere else closes it — on a tablet there is no mouse leaving to do it.
    const onPointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-portal-flyout], [data-portal-rail-link]")) return;
      setFlyout(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [flyout]);

  useEffect(
    () => () => {
      if (flyoutCloseTimer.current !== null) window.clearTimeout(flyoutCloseTimer.current);
    },
    [],
  );

  const handleLogout = async () => {
    // Unbind this browser from the signed-out user's OneSignal identity first — best
    // effort, never blocks sign-out — so a shared device doesn't keep receiving their
    // pushes after someone else signs in.
    logoutOneSignal();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      hardNavigate("/login");
    }
  };

  const handleRailNavigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!shouldUseClientNavigation(event, href)) return;

    const hrefPath = href.split("#")[0];
    if (hrefPath === pathname) return;

    event.preventDefault();
    dispatchEmployeePortalRoutePending(href);
    startTransition(() => router.push(href));
  };

  return (
    <aside className={`hidden shrink-0 self-stretch transition-[width] duration-200 lg:block ${collapsed ? "w-[78px]" : "w-[324px]"}`}>
      <div className="sticky top-[78px] flex max-h-[calc(100vh-104px)] w-full overflow-hidden rounded-sm border border-slate-200/90 bg-white/96 shadow-[0_24px_70px_rgba(15,23,42,0.14)] ring-1 ring-white/80 backdrop-blur">
        <div className={`${collapsed ? "w-full" : "w-[58px]"} shrink-0 bg-[#101a31]`}>
          <div className="flex h-full min-h-0 flex-col items-center py-4">
            {/* The brand at the top of the collapsed rail (owner, 2026-09-29). The rail opens folded
                by default, so without this the narrow strip had no Phoenix mark at all — only the
                icons. The full logo + wordmark still shows in the expanded panel's header; here, at
                78px, the bird alone reads cleanly. */}
            {collapsed ? (
              // phoenix-notification-icon.png, not phoenix-bird-icon.png: the bird icon carries a white
              // rounded tile baked into the artwork, which showed as a white box on the navy rail. This
              // one is a genuinely transparent phoenix emblem (transparent background), so it reads
              // straight on the navy (owner, 2026-09-29 — "logo transparent background").
              <Image
                alt="Phoenix Workforce"
                className="mb-3 h-9 w-9 object-contain"
                height={36}
                priority
                src="/brand/phoenix-notification-icon.png"
                width={36}
              />
            ) : null}
            <button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex h-9 w-9 items-center justify-center rounded text-white/82 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/35"
              onClick={toggleCollapsed}
              title={collapsed ? "Expand sidebar  [" : "Collapse sidebar  ["}
              type="button"
            >
              {/* A panel icon, not the bar chart this button wore until 2026-09-29 — the chart read as
                  "open the charts", not "fold the sidebar". */}
              {collapsed ? <PanelLeftOpen className="h-[17px] w-[17px]" /> : <PanelLeftClose className="h-[17px] w-[17px]" />}
            </button>
            {/* A 52px link leaves this nav no room for side padding or a scrollbar track in the 58px
                rail: `px-2` plus the sidebar scroller's reserved gutter made it wider than the rail,
                so it hung past the card's clip and hid the active marker. The nav is the marker's
                positioning context, which keeps it on the rail's edge at 58px and collapsed alike.
                Budget: src/config/sidebar-metrics.ts; pinned by tests/shell-chrome-overflows.test.ts.

                Each link is `shrink-0`. The nav is a column flexbox, and a flex item shrinks before its
                container overflows, so on a short window the links squashed toward their 16px icons,
                shorter than the 28px marker, before the nav scrolled at all. It scrolls with its bar
                hidden, by the owner's decision (2026-09-16); pinned by
                tests/portal-rail-scrolls-never-squashes.test.ts. */}
            <nav className="relative mt-5 flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {sections.map((section) => {
                const Icon = sectionRailIcon(section.title);
                const active = section.title === activeSectionTitle;
                const firstItem = section.items[0];
                const badged = section.items.flatMap((item) => (item.navBadge ? [item.navBadge] : []));
                return (
                  <Link
                    aria-label={section.title}
                    className={`flex h-10 w-[52px] shrink-0 items-center justify-center rounded transition ${
                      active ? "bg-white/10 text-white" : "text-white/58 hover:bg-white/8 hover:text-white"
                    }`}
                    data-portal-rail-link=""
                    href={firstItem.href}
                    key={section.title}
                    onBlur={scheduleFlyoutClose}
                    onClick={(event) => {
                      // Folded, a plain click OPENS the section's pop-out rather than jumping to its
                      // first page — the promise was "hover or click", and a tablet has no hover at
                      // all. Ctrl/⌘/Shift/middle-click still open the first page in a new tab, and Enter
                      // (a click with detail 0) still goes to it — focus has already opened the pop-out.
                      if (collapsed && event.detail > 0 && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                        event.preventDefault();
                        openFlyout(section.title, event.currentTarget);
                        return;
                      }
                      setFlyout(null);
                      handleRailNavigate(event, firstItem.href);
                    }}
                    onFocus={(event) => openFlyout(section.title, event.currentTarget)}
                    onMouseEnter={(event) => openFlyout(section.title, event.currentTarget)}
                    onMouseLeave={scheduleFlyoutClose}
                    // The default prefetch — down to the page's loading.tsx — and deliberately NOT a
                    // full one, nor `unstable_dynamicOnHover`: hovering a rail icon opens its pop-out,
                    // so a hover here is browsing the sections, not a visit to the first page. The
                    // pop-out's own rows upgrade on intent below. See `dynamicOnHover` in next.config.ts
                    // for what the old full `prefetch` cost on every portal load.
                    title={collapsed ? undefined : section.title}
                  >
                    {active ? <span className="absolute left-0 h-7 w-[3px] rounded-r-sm bg-[#F05A1A] shadow-[0_0_10px_rgba(240,90,26,0.9)]" /> : null}
                    {/* The live pending number rides on the icon's corner — absolutely placed, so it
                        adds nothing to the 52px link the rail's width budget is built on. */}
                    <span className="relative flex h-[16px] w-[16px] items-center justify-center">
                      <Icon className="h-[16px] w-[16px]" />
                      {badged.length > 0 ? <PortalPendingCount navBadges={badged} tone="rail" /> : null}
                    </span>
                  </Link>
                );
              })}
            </nav>
            {collapsed ? (
              <button
                aria-label="Log out"
                className="mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded text-white/64 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/35"
                onClick={handleLogout}
                title="Log out"
                type="button"
              >
                <LogOut className="h-[16px] w-[16px]" />
              </button>
            ) : null}
          </div>
        </div>

        <div className={`${collapsed ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-[linear-gradient(180deg,#ffffff_0%,#fbfcff_100%)] px-4 py-5`}>
          <div className="mb-4 flex items-start justify-between pl-1 pr-0">
            <div className="flex items-center gap-2.5">
              <Image
                alt="Phoenix Workforce logo"
                className="h-8 w-8 rounded-sm border border-orange-100 bg-orange-50 object-contain p-1 shadow-[0_8px_18px_rgba(249,115,22,0.12)]"
                height={32}
                priority
                src="/brand/phoenix-bird-icon.png"
                width={32}
              />
              <div>
                <div className="text-phx-xs font-black leading-none tracking-[0.30em] text-[#25314A]">
                  PHOENIX
                </div>
                <div className="mt-1 text-phx-4xs font-black leading-none tracking-[0.34em] text-[#F05A1A]">
                  WORKFORCE
                </div>
              </div>
            </div>
            <button
              aria-label="Collapse sidebar"
              className="flex h-7 w-7 items-center justify-center rounded-sm bg-slate-100 text-[#293268] transition hover:bg-orange-50 hover:text-orange-700"
              onClick={toggleCollapsed}
              title="Collapse sidebar  ["
              type="button"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Type to narrow forty rows to the one you want. While it holds text every section opens and
              Pinned / Recent step aside; Esc clears it. */}
          <div className="relative mb-3 shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="Filter the sidebar"
              className={cn(phxFieldClassName, "pl-8 pr-8")}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && filter) {
                  event.stopPropagation();
                  setFilter("");
                }
              }}
              placeholder="Filter pages"
              type="text"
              value={filter}
            />
            {filter ? (
              <button
                aria-label="Clear the filter"
                className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700"
                onClick={() => setFilter("")}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <nav className="phoenix-employee-sidebar-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <EmployeePortalMenu
              filterQuery={filter}
              mode="desktop"
              onTogglePin={togglePin}
              pathname={pathname}
              pinnedHrefs={pinnedHrefs}
              sections={menuSections}
            />
          </nav>

          <div className="mt-4 shrink-0 border-t border-[#E9EDF5] pt-3">
            <button
              className="flex w-full items-center gap-3 rounded bg-[#FFF2EE] px-4 py-2.5 text-phx-sm font-black text-[#F05A1A] transition hover:bg-[#FFE8DD]"
              onClick={handleLogout}
              type="button"
            >
              <LogOut className="h-[15px] w-[15px] shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        </div>
      </div>

      {flyoutSection && flyout ? (
        <div
          aria-label={flyoutSection.title}
          data-portal-flyout=""
          className="fixed z-40 flex w-[268px] flex-col overflow-y-auto border border-slate-200 bg-white py-2 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
          onMouseEnter={cancelFlyoutClose}
          onMouseLeave={scheduleFlyoutClose}
          role="menu"
          style={{ left: flyout.left, maxHeight: `calc(100vh - ${flyout.top}px - 16px)`, top: flyout.top }}
        >
          <p className="flex items-center justify-between gap-2 px-4 pb-1.5 pt-1 text-phx-3xs font-black uppercase tracking-[0.18em] text-[#344073]">
            {flyoutSection.title}
            <span className="tabular-nums text-slate-400">{flyoutSection.items.length}</span>
          </p>
          {flyoutSection.items.map((item) => {
            const active = item.href.split("#")[0] === shellActiveHref;
            const locked = isNavItemLockedFor({ href: item.href }, lockedModuleKeys);
            const ItemIcon = locked ? Lock : item.icon;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={locked ? `${item.label} — locked` : undefined}
                className={`flex items-center gap-3 px-4 py-2 text-sm font-bold transition ${
                  active ? "bg-[#FFF0E7] text-[#F05A1A] shadow-[inset_3px_0_0_#F05A1A]" : "text-[#26334F] hover:bg-[#FFF6F0] hover:text-[#F05A1A]"
                }`}
                href={item.href}
                key={item.href}
                onClick={(event) => {
                  setFlyout(null);
                  handleRailNavigate(event, item.href);
                }}
                role="menuitem"
                // A row in the pop-out IS a choice of page, so it fetches that page on touch/hover.
                unstable_dynamicOnHover
              >
                <ItemIcon className={`h-4 w-4 shrink-0 ${locked ? "text-amber-600" : active ? "text-[#F05A1A]" : "text-[#25314A]/76"}`} />
                <span className={locked ? "opacity-70" : undefined}>{item.label}</span>
                <RowNavBadge navBadge={item.navBadge} />
              </Link>
            );
          })}
        </div>
      ) : null}
    </aside>
  );
}

/** Keystrokes typed into a field belong to the field — no shortcut ever steals them. */
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export function EmployeePortalChrome({
  activePathOverride,
  appShell = false,
  children,
  data,
  disableSessionGuard = false,
  lockedModuleKeys,
  visibility,
}: {
  activePathOverride?: string;
  /**
   * The portal is being rendered inside the native app's WebView. Its own fixed header and bottom
   * nav are then suppressed — and their spacers with them — because the native shell supplies that
   * navigation; showing both stacks two nav bars. Set only from a cookie the native hand-off writes
   * (NATIVE_WEB_APP_SHELL_COOKIE); false for every ordinary browser, so the web portal is unchanged.
   */
  appShell?: boolean;
  children: ReactNode;
  data: EmployeePortalShellData;
  disableSessionGuard?: boolean;
  /**
   * Modules a system administrator has temporarily locked for THIS viewer, resolved server-side by
   * EmployeePortalServerShell. Shared through context rather than threaded as a prop because four
   * navigation surfaces need it — the sidebar, the mobile drawer and the bottom nav — and none of
   * them share a parent below this one. A surface that missed the prop
   * would not look broken; it would look UNLOCKED, which is the one thing this must never show.
   */
  lockedModuleKeys?: readonly string[];
  visibility: EmployeePortalNavVisibility;
}) {
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const router = useRouter();
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Focus mode: the sidebar, the top bar and the phone bar step away so a wide table gets the whole
  // screen. Not remembered — every page load starts with the chrome in place, and the floating
  // button and Esc are always there to bring it back.
  const [focusMode, setFocusMode] = useState(false);
  const recentHrefs = useRecentPages();
  const [pinnedHrefs, setPinnedHrefs] = useBottomNavPreference();
  // Below the sidebar's width the command bar drops the actions that need a keyboard or the sidebar.
  const wideScreen = useIsWideScreen();
  const sections = useMemo(() => buildEmployeePortalSections(visibility), [visibility]);
  const goShortcuts = useMemo(() => availableGoShortcuts(sections), [sections]);
  // The `G` of a `G` + letter shortcut, and when it was pressed. A ref, not state: it changes
  // nothing on screen.
  const goPressedAt = useRef<number | null>(null);

  const navigate = useCallback(
    (href: string) => {
      dispatchEmployeePortalRoutePending(href);
      router.push(href);
    },
    [router],
  );
  const closeCommandBar = useCallback(() => setCommandOpen(false), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  // Recent pages: every page you open is noted against the sidebar row it belongs to, newest first.
  // Written straight to this device's storage — nothing is sent anywhere.
  useEffect(() => {
    const href = rowForPath(pathname, sections)?.href
      ?? (pathname === "/employee-portals/profile" || pathname === "/employee-portals/attendance" ? pathname : null);
    if (!href) return;
    const current = readStoredListNow(PORTAL_RECENT_PAGES_KEY);
    if (current[0] === href) return;
    writeStoredList(PORTAL_RECENT_PAGES_KEY, nextRecentHrefs(current, href));
  }, [pathname, sections]);

  // The keyboard. Ctrl/⌘ K works everywhere, even mid-typing, because that is the convention every
  // app has taught people. Everything else stays out of a field being typed in, and out of the way
  // while the command bar or the shortcuts card holds the keyboard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShortcutsOpen(false);
        setCommandOpen((open) => !open);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (commandOpen || shortcutsOpen) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === "Escape") {
        if (focusMode) setFocusMode(false);
        return;
      }

      const goAt = goPressedAt.current;
      goPressedAt.current = null;
      if (goAt !== null && Date.now() - goAt < 1500) {
        const shortcut = goShortcuts.find((candidate) => candidate.key === event.key.toLowerCase());
        if (shortcut) {
          event.preventDefault();
          navigate(shortcut.href);
        }
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key === "[") {
        event.preventDefault();
        setEmployeeSidebarCollapsed(!getEmployeeSidebarCollapsedSnapshot());
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        setFocusMode((on) => !on);
      } else if (event.key === "g" || event.key === "G") {
        goPressedAt.current = Date.now();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, focusMode, goShortcuts, navigate, shortcutsOpen]);

  const currentRow = rowForPath(pathname, sections);
  const actions = useMemo<ChromeAction[]>(() => {
    // The five "start something" actions come from the one shared list, so this bar, the top bar's
    // "+ New" menu and the phone bar's action button can never drift apart again (they had already
    // drifted on the Report It gate). Their hrefs stay out of this file on purpose — see the header
    // of portal-quick-actions.ts.
    const list: ChromeAction[] = portalQuickActions(visibility).map((action) => ({
      hint: action.hint,
      icon: PORTAL_QUICK_ACTION_ICONS[action.id],
      id: action.id,
      keywords: action.keywords,
      label: action.label,
      run: () => navigate(action.href),
    }));
    if (currentRow) {
      const pinned = pinnedHrefs.includes(currentRow.href);
      list.push({
        hint: "Sidebar and phone bar",
        icon: Star,
        id: "pin",
        keywords: "favourite favorite star",
        label: pinned ? `Unpin ${currentRow.label}` : `Pin ${currentRow.label}`,
        run: () => setPinnedHrefs(togglePinnedHref(pinnedHrefs, currentRow.href, shownDefaultBottomNavHrefs(visibility))),
      });
    }
    list.push({
      hint: wideScreen ? "F" : "Full screen",
      icon: focusMode ? Minimize2 : Maximize2,
      id: "focus",
      keywords: "full screen wide table",
      label: focusMode ? "Leave focus mode" : "Focus mode",
      run: () => setFocusMode((on) => !on),
    });
    // The sidebar and a keyboard exist only from the laptop width up; on a phone these two would
    // be buttons that do nothing.
    if (wideScreen) {
      list.push(
        {
          hint: "[",
          icon: PanelLeftClose,
          id: "fold",
          keywords: "collapse expand sidebar",
          label: "Fold or unfold the sidebar",
          run: () => setEmployeeSidebarCollapsed(!getEmployeeSidebarCollapsedSnapshot()),
        },
        { hint: "?", icon: Keyboard, id: "shortcuts", keywords: "keys", label: "Keyboard shortcuts", run: () => setShortcutsOpen(true) },
      );
    }
    list.push(
      {
        hint: "Account",
        icon: LogOut,
        id: "logout",
        keywords: "sign out exit",
        label: "Log out",
        run: () => {
          logoutOneSignal();
          void fetch("/api/auth/logout", { method: "POST" }).finally(() => hardNavigate("/login"));
        },
      },
    );
    return list;
  }, [currentRow, focusMode, navigate, pinnedHrefs, setPinnedHrefs, visibility, wideScreen]);

  return (
    <RouteTransitionProvider>
      <ModuleLockProvider lockedModuleKeys={lockedModuleKeys}>
      {/* The root's className stays a LITERAL: every portal rule in globals.css selects on
          `employee-portal-shell`, two tests read the literal to prove it is still here, and the
          square-edge rule travels with the class.

          TWO reasons to zero the header spacer, and both must hold. In app mode the fixed header is
          gone, so `pt-[56px]` would leave an empty band (web is always appShell=false, so that half
          never touches the browser); in focus mode the header is hidden for the same reason. Either
          one on its own is enough — dropping one silently leaves a 56px gap in that mode. */}
      <div
        className="employee-portal-shell relative min-h-screen overflow-x-clip bg-[linear-gradient(160deg,#f4f8fc_0%,#f8fafc_28%,#fdf8f5_58%,#f6faf8_82%,#f8fafc_100%)] pt-[56px] lg:pt-[64px]"
        style={appShell || focusMode ? { paddingTop: 0 } : undefined}
      >
        <EmployeePortalRouteProgress />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.52),transparent_58%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0)_72%)]" />
        {/* NO ARRANGEABLE NAV ROWS ON THE PORTAL — owner rule, 2026-09-03, stated twice in one
            sitting: "never put anything above the identity banner", then "the upper nav bar that
            has the plus sign and the weekly or monthly plan — remove it totally."

            The portal's landing page opens with a person's own signature identity card, and the two
            rows sat directly above it: on a phone they pushed it most of a screen down, and the
            upper one was usually an empty white strip carrying nothing but a "+". There is no other
            place to put them here — anything between the header and `main` is above the identity
            card by construction — so they are gone from the portal entirely, along with the
            header's compact "+" that was their entry point. The sidebar, the mobile drawer and the
            bottom nav (which IS customizable — see BottomNavCustomizer) are how the portal
            navigates now.

            The admin shell KEEPS its rows: AppShell has no identity banner, and the instruction
            named the portal. Do not "restore parity" by adding them back here. HorizontalNavProvider
            went with them, and with it the cross-Atlantic loadEffectiveLayout read that ran on every
            portal page render.

            The 2026-09-29 command bar, shortcuts card and focus-mode button all respect this: each
            is an overlay or floats over the page — none of them is a row between the header and
            `main`. */}
        {/* The fixed top bar. Gone in app mode — the native screen supplies the header. */}
        {appShell ? null : (
          <EmployeePortalTopNav
            activePathOverride={activePathOverride}
            data={data}
            disableSessionGuard={disableSessionGuard}
            focusMode={focusMode}
            onOpenCommandBar={() => setCommandOpen(true)}
            onShowShortcuts={() => setShortcutsOpen(true)}
            visibility={visibility}
          />
        )}
        <div className="relative mx-auto flex w-full max-w-[1580px] items-start gap-4 px-3 py-4 sm:px-4 sm:py-5 lg:gap-4 lg:py-7 lg:pl-8 lg:pr-4">
          {focusMode ? null : <EmployeePortalSidebar activePathOverride={activePathOverride} visibility={visibility} />}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* pb-[8.5rem] clears the phone bar AND the action button floating above it. It must
                match the .employee-portal-mobile-safe rule in enterprise-shell.tsx, which only
                covers up to 767px — this class is what serves the 768–1023px band where the bar is
                still on screen. Pinned by tests/portal-bottom-nav-godmode.test.ts.

                In app mode there is no web bottom bar and no floating button, so none of that space
                is kept — the native tab bar sits below the WebView, outside the scrolling content. */}
            <main
              className={`phx-zoom-surface employee-portal-mobile-safe min-w-0 flex-1 space-y-5 lg:space-y-7 lg:pb-0 ${
                appShell ? "pb-0" : "pb-[8.5rem]"
              }`}
            >
              <PageTransition>{children}</PageTransition>
            </main>
          </div>
        </div>
        {/* The fixed bottom nav. Gone in app mode — the native tab bar navigates instead — and gone
            in focus mode, which clears every piece of chrome off the page. */}
        {appShell || focusMode ? null : (
          <EmployeePortalBottomNav
            activePathOverride={activePathOverride}
            fullName={data.employee.fullName}
            photoSrc={data.employee.photoUrl ?? employeeProfileImageForHrId(data.employee.hrId)}
            visibility={visibility}
          />
        )}
        {focusMode ? (
          <button
            className="fixed bottom-4 right-4 z-50 flex items-center gap-2 border border-white/10 bg-[#0F1930] px-3 py-2 text-xs font-black text-white shadow-[0_18px_46px_rgba(2,6,23,0.45)] transition hover:bg-[#16244A]"
            onClick={() => setFocusMode(false)}
            type="button"
          >
            <Minimize2 className="h-3.5 w-3.5 text-[#FF8A4C]" />
            Exit focus mode
            <kbd className="border border-white/20 px-1 text-phx-3xs font-black text-white/60">Esc</kbd>
          </button>
        ) : null}
        {commandOpen ? (
          <PortalCommandBar
            actions={actions}
            lockedModuleKeys={lockedModuleKeys ?? []}
            onClose={closeCommandBar}
            onNavigate={navigate}
            pinnedHrefs={pinnedHrefs}
            recentHrefs={recentHrefs}
            sections={sections}
          />
        ) : null}
        {shortcutsOpen ? <PortalShortcutsCard onClose={closeShortcuts} sections={sections} /> : null}
      </div>
      </ModuleLockProvider>
    </RouteTransitionProvider>
  );
}
