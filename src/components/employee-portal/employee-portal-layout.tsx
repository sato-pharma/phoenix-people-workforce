"use client";

import { useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Bell, Search, CalendarClock, Zap, LogOut, LineChart as LineChartIcon, Activity, CircleDollarSign, HelpCircle, ReceiptText, Calculator, Trophy, X, Users, BriefcaseBusiness, ClipboardCheck, Building2, ChartColumnBig, FilePlus2, Megaphone, ShieldCheck, Database, Settings2, Home, Send, FileText, Gift, CalendarDays, Headphones, ChevronsLeft, ChevronDown, WalletCards } from "lucide-react";
import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

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
  return Activity;
}

function buildEmployeePortalSections({
  showDashboardTab = true,
  showExcusesTab = false,
  showExpenseActionTab = false,
  showIncentiveTab = true,
  showManagementTab = false,
  showMarketingRequestsTab = false,
  showMarketingCustomerDatabaseTab = false,
  showMarketingControlTab = false,
  showMyPerformanceTab = true,
  showTeamPerformanceTab = false,
  showMedRepsPerformanceTab = false,
  showMedicalRepExpensesTab = false,
  showDsmsPerformanceTab = false,
  showTeamExpensesTab = false,
  showVacanciesTab = false,
  showProbationTab = false,
  showOrganogramTab = false,
  showMyCoachingTab = false,
  showTeamCoachingTab = false,
  showTrainingManagerCreateCoachingTab = false,
  showTrainingManagerDashboardTab = false,
  showTrainingManagerFieldCoachingTab = false,
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
        ...(showDashboardTab ? [{ href: "/employee-portals", label: "Dashboard", icon: Home }] : []),
        ...(showMyPerformanceTab ? [{ href: "/employee-portals/sales", label: "My Performance", icon: LineChartIcon }] : []),
        ...(showIncentiveTab ? [{ href: "/employee-portals/incentive", label: "Incentive", icon: Gift }] : []),
        ...(showMyCoachingTab ? [{ href: "/employee-portals/coaching", label: "My Coaching Reports", icon: ClipboardCheck }] : []),
        { href: "/payslips", label: "Payslips", icon: FileText },
      ],
    },
    {
      title: "Marketing Requests",
      items: [
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests/validation", label: "HCP / PH Validation", icon: ShieldCheck }] : []),
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests", label: "Marketing Requests", icon: Send }] : []),
        ...(showMarketingControlTab ? [{ href: "/employee-portals/marketing-requests/control", label: "Marketing Control", icon: Settings2 }] : []),
        ...(showMarketingCustomerDatabaseTab ? [{ href: "/employee-portals/marketing-requests/customer-database", label: "SCP / PH Database", icon: Database }] : []),
      ],
    },
    {
      title: "Leave Management",
      items: [
        { href: "/leave-management/vacation-request", label: "Vacation Request", icon: CalendarDays },
        { href: "/leave-management/vacation-report", label: "Vacation Report", icon: FileText },
        ...(showExcusesTab ? [{ href: "/employee-portals/excuses", label: "Excuses", icon: CalendarClock }] : []),
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
        ...(showMedicalRepExpensesTab ? [{ href: "/employee-portals/expenses", label: "My Expenses", icon: ReceiptText }] : []),
        ...(showManagementTab ? [{ href: "/employee-portals/expense-dashboard", label: "Workload & Expense", icon: CircleDollarSign }] : []),
        ...(showExpenseActionTab ? [{ href: "/employee-portals/submit-expense", label: "Submit Expense", icon: Send }] : []),
      ],
    },
    {
      title: "Support",
      items: [
        { href: "/employee-portals/contact-hr-support", label: "Request Support", icon: Headphones },
      ],
    },
  ].filter((section) => section.items.length > 0);
}

export function EmployeePortalTopNav({
  activePathOverride,
  data,
  disableSessionGuard = false,
  visibility,
}: EmployeePortalNavProps) {
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const closeMobileMenu = () => {
    const menuToggle = document.getElementById("employee-portal-mobile-menu");
    if (menuToggle instanceof HTMLInputElement) {
      menuToggle.checked = false;
    }
  };

  useEffect(() => {
    closeMobileMenu();
  }, [pathname]);

  const firstName = data.employee.fullName.split(/\s+/)[0] ?? "Employee";
  const initials = data.employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  const menuSections = buildEmployeePortalSections(visibility);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <>
      {disableSessionGuard ? null : <SessionSecurityGuard />}
      <input
        aria-hidden="true"
        className="peer/mobile-menu sr-only"
        id="employee-portal-mobile-menu"
        type="checkbox"
      />
      <header className="fixed inset-x-0 top-0 z-30 w-full border-b border-slate-200/60 bg-white/97 shadow-[0_8px_24px_rgba(15,23,42,0.07),0_1px_4px_rgba(15,23,42,0.04)] backdrop-blur-2xl">
        <div className="mx-auto flex h-[64px] w-full max-w-[1560px] items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:h-[72px] lg:px-8">
          <label
            aria-label="Menu"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-500/25 lg:hidden"
            htmlFor="employee-portal-mobile-menu"
            role="button"
            tabIndex={0}
          >
            <Menu className="h-5 w-5" />
          </label>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3 lg:flex-none">
            <PhoenixLogo />
            <div className="min-w-0 border-l border-slate-200 pl-2 sm:pl-3">
              <p className="text-[9.5px] font-black uppercase tracking-[0.26em] text-orange-600">Employee Portal</p>
              <p className="max-w-[132px] truncate text-[11px] font-medium text-slate-400 sm:max-w-[220px]">{data.employee.roleLabel}</p>
            </div>
          </div>

          <div className="relative ml-auto hidden w-full max-w-sm items-center md:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
            <input
              aria-label="Search"
              className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/80 pl-9 pr-3 text-sm font-medium text-slate-700 shadow-inner placeholder:text-slate-400 outline-none transition focus:border-orange-300 focus:bg-white focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
              placeholder="Search anything..."
              type="text"
            />
          </div>
          <button
            aria-label="Alerts"
            className="hidden h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 sm:inline-flex"
            type="button"
          >
            <Bell className="h-4 w-4" />
          </button>
          <div className="hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 shadow-sm lg:flex">
            <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
            <span>
              {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
            </span>
          </div>
          {visibility.showMyPerformanceTab === false ? null : (
            <div className="hidden items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700 shadow-sm lg:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 ep-pulse-orange" />
              <Zap className="h-3.5 w-3.5" />
              <span>Live Performance</span>
            </div>
          )}
          <div className="flex min-w-0 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-1.5 py-1 shadow-sm sm:px-2 lg:ml-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-orange-600 text-xs font-bold text-white shadow-[0_2px_6px_rgba(249,115,22,0.35)]">
              {initials || "EM"}
            </div>
            <div className="hidden min-w-0 pr-1 sm:block">
              <p className="truncate text-xs font-semibold text-slate-800">{firstName}</p>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Sidebar Overlay */}
      <label
        aria-label="Close menu"
        className="pointer-events-none fixed inset-0 z-40 bg-slate-900/40 opacity-0 backdrop-blur-sm transition-opacity duration-200 peer-checked/mobile-menu:pointer-events-auto peer-checked/mobile-menu:opacity-100 lg:hidden"
        htmlFor="employee-portal-mobile-menu"
      />

      {/* Mobile Sidebar Content */}
      <div className="fixed inset-y-0 left-0 z-50 flex h-dvh max-h-dvh w-[min(88vw,306px)] -translate-x-full transform flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out peer-checked/mobile-menu:translate-x-0 lg:hidden">
        <div className="flex shrink-0 items-center justify-between px-5 pb-4 pt-5">
          <PhoenixLogo />
          <label
            aria-label="Close menu"
            className="h-10 w-10 flex items-center justify-center rounded-xl border border-slate-100 text-slate-400 hover:text-slate-600"
            htmlFor="employee-portal-mobile-menu"
            role="button"
            tabIndex={0}
          >
            <X className="h-5 w-5" />
          </label>
        </div>

        <nav className="phoenix-employee-sidebar-scroll flex-1 space-y-4 overflow-y-auto px-5 pb-5 pt-1">
          {menuSections.map((section, sectionIndex) => (
            <div
              key={section.title}
              className={sectionIndex < menuSections.length - 1 ? "border-b border-orange-100/70 pb-4" : undefined}
            >
              {section.hideTitle ? null : (
                <div className="mb-2 flex items-center justify-between px-3 pt-1">
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#1D2B42]">
                    {section.title}
                  </p>
                  <ChevronDown className="h-3.5 w-3.5 text-[#F05A1A]" />
                </div>
              )}
              <div className="space-y-1">
                {section.items.map((item) => {
                  const active = isEmployeePortalNavItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.label}
                      className={`group flex items-center gap-3 rounded-[16px] px-4 py-2.5 text-[13px] font-semibold transition duration-200 ${navItemClass(active)}`}
                      href={item.href}
                      onClick={closeMobileMenu}
                    >
                      <item.icon className={`h-4 w-4 shrink-0 transition ${navIconClass(active)}`} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="pt-4 mt-4 border-t border-slate-100">
            <button
              className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
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

        <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-4">
          <div className="rounded-2xl bg-orange-50 border border-orange-100 p-3">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center text-white text-xs font-bold shadow-[0_2px_6px_rgba(249,115,22,0.35)]">
                {initials}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{data.employee.fullName}</p>
                <p className="text-[10px] text-orange-600 font-semibold uppercase tracking-wider">{data.employee.roleLabel}</p>
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

  const sections = buildEmployeePortalSections(visibility);
  const activeSectionTitle = sections.find((section) =>
    section.items.some((item) => isEmployeePortalNavItemActive(pathname, item.href)),
  )?.title;

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <aside className="hidden w-[302px] shrink-0 lg:block">
      <div className="sticky top-[86px] min-h-[calc(100vh-112px)] overflow-hidden rounded-[20px] border border-slate-100/90 bg-[linear-gradient(90deg,#17233E_0_54px,#FFFFFF_54px,#FFFFFF_100%)] shadow-[0_26px_70px_rgba(15,23,42,0.13)]">
        <div className="absolute bottom-0 left-0 top-0 w-[54px]">
          <div className="flex h-full flex-col items-center py-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl text-white/82">
              <ChartColumnBig className="h-[17px] w-[17px]" />
            </div>
            <div className="mt-7 flex flex-1 flex-col items-center justify-between pb-16">
              {sections.map((section) => {
                const Icon = sectionRailIcon(section.title);
                const active = section.title === activeSectionTitle;
                return (
                  <div className="relative flex h-10 w-[52px] items-center justify-center" key={section.title}>
                    {active ? <span className="absolute left-0 h-7 w-[3px] rounded-r-full bg-[#F05A1A]" /> : null}
                    <Icon className={`h-[16px] w-[16px] ${active ? "text-white" : "text-white/58"}`} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="relative ml-[54px] min-h-[calc(100vh-112px)] px-4 py-5">
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
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F2F0FF] text-[#293268] transition hover:bg-[#E7E5FF]"
            type="button"
          >
            <ChevronsLeft className="h-3 w-3" />
          </button>
        </div>

        <nav className="space-y-3">
          {sections.map((section, sectionIndex) => (
            <div
              key={section.title}
              className={sectionIndex < sections.length - 1 ? "border-b border-[#E9EDF5] pb-3" : undefined}
            >
              {section.hideTitle ? null : (
                <div className="mb-1.5 flex items-center justify-between px-3 pt-1">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#344073]">
                    {section.title}
                  </p>
                  <ChevronDown className="h-3 w-3 text-[#F05A1A]" />
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = isEmployeePortalNavItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.label}
                      className={`group flex items-center gap-3 rounded-[16px] px-4 py-2.5 text-[12px] font-bold transition duration-150 ${navItemClass(active)}`}
                      href={item.href}
                    >
                      <item.icon className={`h-[15px] w-[15px] shrink-0 stroke-[2.1] transition ${navIconClass(active)}`} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-4 border-t border-[#E9EDF5] pt-3">
          <button
            className="flex w-full items-center gap-3 rounded-[14px] bg-[#FFF2EE] px-4 py-2.5 text-[12px] font-black text-[#F05A1A] transition hover:bg-[#FFE8DD]"
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
