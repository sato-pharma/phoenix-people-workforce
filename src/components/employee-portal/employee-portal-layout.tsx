"use client";

import { useEffect, useState, useTransition, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  Search,
  CalendarClock,
  Zap,
  LogOut,
  LineChart as LineChartIcon,
  Activity,
  CircleDollarSign,
  ReceiptText,
  Trophy,
  X,
  Users,
  BriefcaseBusiness,
  ClipboardCheck,
  Building2,
  ChartColumnBig,
  FilePlus2,
  ShieldCheck,
  Database,
  Settings2,
  Home,
  Send,
  FileText,
  Fingerprint,
  Gift,
  CalendarDays,
  Headphones,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  WalletCards,
  UserCog,
  Inbox,
  ScanLine,
  Target,
  CalendarRange,
  ChartNoAxesColumnIncreasing,
} from "lucide-react";
import { EmployeePortalBottomNav } from "@/components/employee-portal/employee-portal-bottom-nav";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { PageTransition } from "@/components/ui/page-transition";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { isEmployeePortalOwnedRoute } from "@/lib/employee-portal/routes";
import { systemAssets } from "@/config/system-settings";

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

function getEmployeeSidebarCollapsedSnapshot() {
  try {
    return window.localStorage.getItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function getEmployeeSidebarCollapsedServerSnapshot() {
  return false;
}

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

function isEmployeePortalNavItemActive(pathname: string, href: string) {
  const hrefPath = href.split("#")[0];
  if (hrefPath === "/employee-portals") return pathname === hrefPath;
  if (hrefPath === "/employee-portals/plans") return pathname === hrefPath;
  if (hrefPath === "/employee-portals/training-manager") return pathname === hrefPath;
  if (hrefPath === "/employee-portals/marketing-requests") return pathname === hrefPath;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
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
};

type EmployeePortalNavSection = {
  hideTitle?: boolean;
  items: EmployeePortalNavItem[];
  title: string;
};

function sectionRailIcon(title: string): typeof Activity {
  if (title === "My Workspace") return Home;
  if (title === "Marketing Requests") return BriefcaseBusiness;
  if (title === "Leave Management") return CalendarDays;
  if (title === "Team Performance") return Users;
  if (title === "Team Operations") return BriefcaseBusiness;
  if (title === "Expenses") return FileText;
  if (title === "Support") return Headphones;
  if (title === "Pharmacovigilance") return FileText;
  if (title === "Sales Intelligence") return Target;
  return Activity;
}

function buildEmployeePortalSections({
  showDashboardTab = true,
  showExcusesTab = false,
  showExpenseActionTab = false,
  showExpenseDashboardTab = false,
  showFingerprintReportTab = false,
  showIncentiveTab = true,
  showMarketingRequestsTab = false,
  showMarketingInboxTab = false,
  showMarketingCustomerDatabaseTab = false,
  showMarketingControlTab = false,
  showMarketingRoiTrackingTab = false,
  showMyPerformanceTab = true,
  showTeamPerformanceTab = false,
  showMedRepsPerformanceTab = false,
  showMedicalRepExpensesTab = false,
  showDsmsPerformanceTab = false,
  showTeamExpensesTab = false,
  showVacanciesTab = false,
  showProbationTab = false,
  showOrganogramTab = false,
  showPlansTab = false,
  showSupportTab = false,
  showMyCoachingTab = false,
  showTeamCoachingTab = false,
  showTrainingManagerCreateCoachingTab = false,
  showTrainingManagerDashboardTab = false,
  showTrainingManagerFieldCoachingTab = false,
  showReportItTab = false,
  showReportItDashboardTab = false,
  showRoiIntelligenceTab = false,
  showMiniWeeklySalesTab = false,
  showMiniMonthlySalesTab = false,
  showDoubleVisitAnalyticsTab = false,
  showCoachingAnalyticsTab = false,
}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {
  return [
    {
      title: "Training Manager",
      items: [
        ...(showTrainingManagerDashboardTab ? [{ href: "/employee-portals/training-manager", label: "Coaching Dashboard", icon: ChartColumnBig }] : []),
        ...(showTrainingManagerCreateCoachingTab ? [{ href: "/employee-portals/training-manager/create-coaching-report", label: "Create Coaching Report", icon: FilePlus2 }] : []),
        ...(showTrainingManagerFieldCoachingTab ? [{ href: "/employee-portals/training-manager/field-coaching", label: "Field Coaching", icon: ClipboardCheck }] : []),
      ],
    },
    {
      title: "My Workspace",
      items: [
        ...(showDashboardTab ? [{ href: "/employee-portals", label: "My Dashboard", icon: Home }] : []),
        ...(showMyPerformanceTab ? [{ href: "/employee-portals/sales", label: "My Performance", icon: LineChartIcon }] : []),
        ...(showIncentiveTab ? [{ href: "/employee-portals/incentive", label: "Incentive", icon: Gift }] : []),
        ...(showMyCoachingTab ? [{ href: "/employee-portals/coaching", label: "My Coaching Reports", icon: ClipboardCheck }] : []),
        ...(showPlansTab ? [{ href: "/employee-portals/plans", label: "Weekly / Monthly Plan", icon: CalendarDays }] : []),
        ...(showPlansTab ? [{ href: "/employee-portals/plans/calendar", label: "Planning Calendar", icon: CalendarClock }] : []),
        { href: "/employee-portals/private-calendar", label: "Private Calendar", icon: Fingerprint },
      ],
    },
    {
      title: "Payroll",
      items: [
        { href: "/payslips", label: "Payslips", icon: FileText },
        { href: "/employee-portals/deductions", label: "Deductions", icon: ReceiptText },
      ],
    },
    {
      title: "Sales Operations",
      items: [
        ...(showMiniWeeklySalesTab ? [{ href: "/employee-portals/weekly-sales", label: "Weekly Sales", icon: ChartNoAxesColumnIncreasing }] : []),
        ...(showMiniMonthlySalesTab ? [{ href: "/employee-portals/monthly-sales", label: "Monthly Sales Closing", icon: CalendarRange }] : []),
      ],
    },
    {
      title: "Coaching",
      items: [
        ...(showDoubleVisitAnalyticsTab ? [{ href: "/employee-portals/double-visit-analytics", label: "Double-Visit Analytics", icon: Activity }] : []),
        ...(showCoachingAnalyticsTab ? [{ href: "/employee-portals/coaching-analytics", label: "Coaching Analytics", icon: ChartColumnBig }] : []),
      ],
    },
    {
      title: "Pharmacovigilance",
      items: [
        ...(showReportItTab ? [{ href: "/employee-portals/report-it", label: "Report It", icon: FileText }] : []),
        ...(showReportItDashboardTab
          ? [{ href: "/employee-portals/report-it", label: "Reports Dashboard", icon: ChartColumnBig }]
          : []),
      ],
    },
    {
      title: "Marketing Requests",
      items: [
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests/validation", label: "Customer Validation", icon: ShieldCheck }] : []),
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests", label: "Marketing Requests", icon: Send }] : []),
        ...(showMarketingInboxTab ? [{ href: "/employee-portals/marketing-requests/inbox", label: "Approval Inbox", icon: Inbox }] : []),
        ...(showMarketingControlTab ? [{ href: "/employee-portals/marketing-requests/control", label: "Marketing Control", icon: Settings2 }] : []),
        ...(showMarketingCustomerDatabaseTab ? [{ href: "/employee-portals/marketing-requests/customer-database", label: "Customer Database", icon: Database }] : []),
        ...(showMarketingRoiTrackingTab ? [{ href: "/employee-portals/marketing-requests/roi-tracking", label: "ROI Tracking", icon: ChartColumnBig }] : []),
        ...(showRoiIntelligenceTab ? [{ href: "/employee-portals/roi", label: "ROI Dashboard", icon: Target }] : []),
      ],
    },
    {
      title: "Leave Management",
      items: [
        { href: "/leave-management/vacation-request", label: "Vacation Request", icon: CalendarDays },
        { href: "/leave-management/vacation-report", label: "Vacation Report", icon: FileText },
        ...(showExcusesTab ? [{ href: "/employee-portals/excuses", label: "Excuses", icon: CalendarClock }] : []),
        ...(showFingerprintReportTab ? [{ href: "/employee-portals/fingerprint-analytics", label: "Fingerprint Report", icon: ScanLine }] : []),
      ],
    },
    {
      title: "Team Performance",
      items: [
        ...(showTeamPerformanceTab ? [{ href: "/employee-portals/team-performance", label: "Team Performance", icon: Trophy }] : []),
        ...(showTeamCoachingTab ? [{ href: "/employee-portals/coaching", label: "Team Coaching Reports", icon: ClipboardCheck }] : []),
        ...(showMedRepsPerformanceTab ? [{ href: "/employee-portals/med-reps-performance", label: "MRs Performance", icon: ChartColumnBig }] : []),
        ...(showDsmsPerformanceTab ? [{ href: "/employee-portals/dsms-performance", label: "DSMs Performance", icon: Users }] : []),
        ...(showTeamExpensesTab ? [{ href: "/employee-portals/team-expenses", label: "Team Expenses", icon: WalletCards }] : []),
      ],
    },
    {
      title: "Team Operations",
      items: [
        ...(showVacanciesTab ? [{ href: "/employee-portals/vacancies", label: "Vacancies", icon: BriefcaseBusiness }] : []),
        ...(showProbationTab ? [{ href: "/employee-portals/probation", label: "Probation Tracker", icon: ClipboardCheck }] : []),
        ...(showOrganogramTab ? [{ href: "/employee-portals/organogram", label: "Organogram", icon: Building2 }] : []),
      ],
    },
    {
      title: "Expenses",
      items: [
        ...(showMedicalRepExpensesTab ? [{ href: "/employee-portals/expenses", label: "My Outstation Expenses", icon: ReceiptText }] : []),
        ...(showExpenseDashboardTab ? [{ href: "/employee-portals/expense-dashboard", label: "Expense Dashboard", icon: CircleDollarSign }] : []),
        ...(showExpenseActionTab ? [{ href: "/employee-portals/submit-expense", label: "Submit Expense", icon: Send }] : []),
      ],
    },
    {
      title: "Support",
      items: [
        ...(showSupportTab ? [{ href: "/employee-portals/contact-hr-support", label: "Request Support", icon: Headphones }] : []),
      ],
    },
  ].filter((section) => section.items.length > 0);
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

function EmployeePortalMenu({
  mode,
  onNavigate,
  pathname,
  sections,
}: {
  mode: "desktop" | "mobile";
  onNavigate?: () => void;
  pathname: string;
  sections: EmployeePortalNavSection[];
}) {
  const isMobile = mode === "mobile";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setPendingHref(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [pathname]);

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
    <>
      {sections.map((section, sectionIndex) => (
        <div
          key={section.title}
          className={
            sectionIndex < sections.length - 1
              ? isMobile
                ? "border-b border-orange-100/70 pb-4"
                : "border-b border-[#E9EDF5] pb-3"
              : undefined
          }
        >
          {section.hideTitle ? null : (
            <div className={`${isMobile ? "mb-2" : "mb-1.5"} flex items-center justify-between px-3 pt-1`}>
              <p
                className={
                  isMobile
                    ? "text-[10px] font-black uppercase tracking-[0.16em] text-[#1D2B42]"
                    : "text-[9px] font-black uppercase tracking-[0.18em] text-[#344073]"
                }
              >
                {section.title}
              </p>
              <ChevronDown className={`${isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} text-[#F05A1A]`} />
            </div>
          )}
          <div className={isMobile ? "space-y-1" : "space-y-0.5"}>
            {section.items.map((item) => {
              const active = isEmployeePortalNavItemActive(pathname, item.href);
              const pending = isPending && pendingHref === item.href;
              return (
                <Link
                  aria-busy={pending || undefined}
                  aria-current={active ? "page" : undefined}
                  key={item.label}
                  className={`group flex items-center gap-3 rounded px-4 py-2.5 ${
                    isMobile ? "text-[13px] font-semibold duration-200" : "text-[12px] font-bold duration-150"
                  } transition ${pending ? "bg-[#FFF7ED] text-[#EA580C] ring-1 ring-orange-200/80" : navItemClass(active)}`}
                  href={item.href}
                  onClick={(event) => handleNavigate(event, item.href)}
                  prefetch
                >
                  <item.icon
                    className={`${
                      isMobile ? "h-4 w-4" : "h-[15px] w-[15px] stroke-[2.1]"
                    } shrink-0 transition ${pending ? "text-[#EA580C]" : navIconClass(active)}`}
                  />
                  <span>{item.label}</span>
                  {pending ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-orange-500 employee-portal-nav-pending-dot" /> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

export function EmployeePortalTopNav({
  activePathOverride,
  data,
  disableSessionGuard = false,
  visibility,
}: EmployeePortalNavProps) {
  const currentPathname = usePathname();
  const router = useRouter();
  const pathname = activePathOverride ?? currentPathname;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const closeMobileMenu = () => setMobileMenuOpen(false);

  const employeeName = data.employee.fullName.trim();
  const firstName = employeeName.split(/\s+/)[0] || "Employee";

  const menuSections = buildEmployeePortalSections(visibility);
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

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  const navigateToSearchResult = (href: string) => {
    setSearchQuery("");
    setSearchOpen(false);
    dispatchEmployeePortalRoutePending(href);
    router.push(href);
  };

  return (
    <>
      {disableSessionGuard ? null : <SessionSecurityGuard />}
      <header className="fixed inset-x-0 top-0 z-30 w-full border-b border-slate-200/60 bg-white/97 shadow-[0_4px_12px_rgba(15,23,42,0.06)] backdrop-blur-2xl">
        <div className="mx-auto flex h-[56px] w-full max-w-[1560px] items-center gap-1.5 px-2 sm:gap-2.5 sm:px-4 lg:h-[64px] lg:px-8">
          <button
            aria-label="Menu"
            aria-controls="employee-portal-mobile-sidebar"
            aria-expanded={mobileMenuOpen}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-orange-200 bg-orange-50 text-orange-700 transition hover:border-orange-300 hover:bg-orange-100 focus:outline-none focus:ring-1 focus:ring-orange-500/20 lg:hidden"
            onClick={() => setMobileMenuOpen((open) => !open)}
            type="button"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center lg:flex-none">
            <div className="min-w-0">
              <p className="text-[8px] font-black uppercase tracking-[0.22em] text-orange-600 sm:text-[9px] sm:tracking-[0.26em]">Employee Portal</p>
              <p className="truncate text-[10px] font-medium text-slate-400 sm:text-[11px]">{data.employee.roleLabel}</p>
            </div>
          </div>

          <div className="relative ml-auto hidden w-full max-w-sm items-center md:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
            <input
              aria-label="Search"
              className="h-9 w-full rounded border border-slate-200 bg-slate-50/80 pl-9 pr-3 text-sm font-medium text-slate-700 placeholder:text-slate-400 outline-none transition focus:border-orange-300 focus:bg-white focus:ring-1 focus:ring-orange-400/15"
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  return;
                }
                if (event.key === "Enter" && searchMatches[0]) {
                  event.preventDefault();
                  navigateToSearchResult(searchMatches[0].href);
                }
              }}
              placeholder="Search portal pages..."
              value={searchQuery}
              type="text"
            />
            {searchOpen && searchQuery.trim().length > 0 ? (
              <div
                className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]"
                role="listbox"
              >
                {searchMatches.length > 0 ? (
                  searchMatches.map((item) => (
                    <button
                      aria-selected={false}
                      className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-orange-50"
                      key={`${item.section}-${item.href}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        navigateToSearchResult(item.href);
                      }}
                      role="option"
                      type="button"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-orange-500" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-slate-800">{item.label}</span>
                        <span className="block truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{item.section}</span>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-3 text-sm font-semibold text-slate-500">
                    No matching portal pages.
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <InAppNotificationsBell isAdminMode={false} />
          <InternalMessagesMenu isAdminMode={false} />
          <div className="hidden items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 lg:flex">
            <CalendarClock className="h-3 w-3 text-slate-400" />
            <span className="whitespace-nowrap">
              {new Date().toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "Africa/Cairo", year: "numeric" })}
            </span>
          </div>
          {visibility.showMyPerformanceTab === false ? null : (
            <div className="hidden items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-700 lg:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 ep-pulse-orange" />
              <Zap className="h-3 w-3" />
              <span className="whitespace-nowrap">Live Performance</span>
            </div>
          )}
          <div className="relative flex shrink-0">
            <button
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-1.5 rounded border border-slate-200 bg-white px-1.5 py-1 transition hover:border-orange-200 hover:bg-orange-50/70 sm:px-2"
              onClick={() => setUserMenuOpen((open) => !open)}
              type="button"
            >
              <Image alt="Phoenix" className="h-7 w-7 shrink-0 rounded object-contain" height={28} src={systemAssets.iconLogo} width={28} />
              <div className="hidden pr-0.5 text-left sm:block">
                <p className="text-xs font-semibold text-slate-800 whitespace-nowrap">{firstName}</p>
              </div>
              <ChevronDown className="hidden h-3 w-3 text-slate-400 sm:block" />
            </button>

            {userMenuOpen ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded border border-slate-200 bg-white shadow-lg"
                role="menu"
              >
                <div className="border-b border-slate-100 px-3.5 py-2.5">
                  <p className="text-sm font-black text-slate-900">{data.employee.fullName}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">{data.employee.roleLabel}</p>
                  <p className="mt-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-orange-600">
                    {data.employee.hrId}
                  </p>
                </div>
                <Link
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
                  href="/employee-portals/profile"
                  onClick={() => setUserMenuOpen(false)}
                  role="menuitem"
                >
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                <div className="mx-3 h-px bg-slate-100" />
                <button
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
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

      {/* Mobile Sidebar Overlay */}
      <button
        aria-label="Close menu"
        className={`fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closeMobileMenu}
        type="button"
      />

      {/* Mobile Sidebar Content */}
      <div
        aria-hidden={!mobileMenuOpen}
        className="fixed inset-y-0 left-0 z-50 flex h-dvh max-h-dvh w-[min(88vw,306px)] flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out will-change-transform lg:hidden"
        id="employee-portal-mobile-sidebar"
        style={{ transform: mobileMenuOpen ? "translate3d(0, 0, 0)" : "translate3d(-100%, 0, 0)" }}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4">
          <button
            aria-label="Close menu"
            className="flex h-8 w-8 items-center justify-center rounded border border-slate-100 text-slate-400 hover:text-slate-600"
            onClick={closeMobileMenu}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="phoenix-employee-sidebar-scroll flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-1">
          <EmployeePortalMenu mode="mobile" onNavigate={closeMobileMenu} pathname={pathname} sections={menuSections} />

          <div className="pt-3 mt-3 border-t border-slate-100">
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

        <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3">
          <div className="rounded border border-orange-100 bg-orange-50 p-3">
            <div className="flex items-center gap-3">
              <Image alt="Phoenix" className="h-8 w-8 shrink-0 rounded object-cover" height={32} src={systemAssets.adminRailMark} width={32} />
              <div>
                <p className="text-sm font-semibold text-slate-900">{data.employee.fullName}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">{data.employee.roleLabel}</p>
              </div>
            </div>
          </div>
        </div>
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
  const persistedCollapsed = useSyncExternalStore(
    subscribeToEmployeeSidebarCollapsed,
    getEmployeeSidebarCollapsedSnapshot,
    getEmployeeSidebarCollapsedServerSnapshot,
  );
  const [fallbackCollapsed, setFallbackCollapsed] = useState<boolean | null>(null);
  const collapsed = fallbackCollapsed ?? persistedCollapsed;

  const sections = buildEmployeePortalSections(visibility);
  const activeSectionTitle = sections.find((section) =>
    section.items.some((item) => isEmployeePortalNavItemActive(pathname, item.href)),
  )?.title;

  const toggleCollapsed = () => {
    const nextCollapsed = !collapsed;
    setFallbackCollapsed(nextCollapsed);

    try {
      window.localStorage.setItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY, String(nextCollapsed));
    } catch {
      return;
    }

    window.dispatchEvent(new Event(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT));
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
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
    <aside className={`hidden shrink-0 self-start transition-[width] duration-200 lg:block ${collapsed ? "w-[78px]" : "w-[302px]"}`}>
      <div className="sticky top-[78px] flex max-h-[calc(100vh-104px)] w-full overflow-hidden rounded border border-slate-100/90 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.08)]">
        <div className={`${collapsed ? "w-full" : "w-[54px]"} shrink-0 bg-[#17233E]`}>
          <div className="flex h-full min-h-0 flex-col items-center py-4">
            <button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex h-9 w-9 items-center justify-center rounded text-white/82 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/35"
              onClick={toggleCollapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              type="button"
            >
              {collapsed ? <ChevronsRight className="h-[17px] w-[17px]" /> : <ChartColumnBig className="h-[17px] w-[17px]" />}
            </button>
            <nav className="phoenix-employee-sidebar-scroll mt-5 flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pb-3">
              {sections.map((section) => {
                const Icon = sectionRailIcon(section.title);
                const active = section.title === activeSectionTitle;
                const firstItem = section.items[0];
                return (
                  <Link
                    aria-label={section.title}
                    className={`relative flex h-10 w-[52px] items-center justify-center rounded transition ${
                      active ? "bg-white/10 text-white" : "text-white/58 hover:bg-white/8 hover:text-white"
                    }`}
                    href={firstItem.href}
                    key={section.title}
                    onClick={(event) => handleRailNavigate(event, firstItem.href)}
                    prefetch
                    title={section.title}
                  >
                    {active ? <span className="absolute left-[-8px] h-7 w-[3px] rounded-r-sm bg-[#F05A1A]" /> : null}
                    <Icon className="h-[16px] w-[16px]" />
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

        <div className={`${collapsed ? "hidden" : "flex"} min-h-0 flex-1 flex-col px-4 py-5`}>
          <div className="mb-4 flex items-start justify-between pl-1 pr-0">
            <div className="flex items-center gap-2.5">
              <Image
                alt="Phoenix Workforce logo"
                className="h-8 w-8 object-contain"
                height={32}
                priority
                src="/brand/phoenix-bird-icon.png"
                width={32}
              />
              <div>
                <div className="text-[11px] font-black leading-none tracking-[0.30em] text-[#25314A]">
                  PHOENIX
                </div>
                <div className="mt-1 text-[8px] font-black leading-none tracking-[0.34em] text-[#F05A1A]">
                  WORKFORCE
                </div>
              </div>
            </div>
            <button
              aria-label="Collapse sidebar"
              className="flex h-7 w-7 items-center justify-center rounded bg-[#F2F0FF] text-[#293268] transition hover:bg-[#E7E5FF]"
              onClick={toggleCollapsed}
              type="button"
            >
              <ChevronsLeft className="h-3 w-3" />
            </button>
          </div>

          <nav className="phoenix-employee-sidebar-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <EmployeePortalMenu mode="desktop" pathname={pathname} sections={sections} />
          </nav>

          <div className="mt-4 shrink-0 border-t border-[#E9EDF5] pt-3">
            <button
              className="flex w-full items-center gap-3 rounded bg-[#FFF2EE] px-4 py-2.5 text-[12px] font-black text-[#F05A1A] transition hover:bg-[#FFE8DD]"
              onClick={handleLogout}
              type="button"
            >
              <LogOut className="h-[15px] w-[15px] shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function EmployeePortalChrome({
  activePathOverride,
  children,
  data,
  disableSessionGuard = false,
  visibility,
}: {
  activePathOverride?: string;
  children: ReactNode;
  data: EmployeePortalShellData;
  disableSessionGuard?: boolean;
  visibility: EmployeePortalNavVisibility;
}) {
  return (
    <RouteTransitionProvider>
      <div className="employee-portal-shell relative min-h-screen overflow-x-hidden bg-[linear-gradient(160deg,#f4f8fc_0%,#f8fafc_28%,#fdf8f5_58%,#f6faf8_82%,#f8fafc_100%)] pt-[56px] lg:pt-[64px]">
        <EmployeePortalRouteProgress />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.028)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.028)_1px,transparent_1px)] bg-[size:52px_52px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.65),transparent_56%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(255,255,255,0)_70%)]" />
        <EmployeePortalTopNav
          activePathOverride={activePathOverride}
          data={data}
          disableSessionGuard={disableSessionGuard}
          visibility={visibility}
        />
        <div className="relative mx-auto flex w-full max-w-[1560px] items-start gap-4 px-3 py-5 sm:px-4 lg:gap-8 lg:px-8 lg:py-8">
          <EmployeePortalSidebar activePathOverride={activePathOverride} visibility={visibility} />
          <main className="min-w-0 flex-1 space-y-6 pb-24 lg:space-y-8 lg:pb-0">
            <PageTransition>{children}</PageTransition>
          </main>
        </div>
        <EmployeePortalBottomNav activePathOverride={activePathOverride} visibility={visibility} />
      </div>
    </RouteTransitionProvider>
  );
}
