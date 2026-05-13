"use client";

import { startTransition, useEffect, useEffectEvent, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Bell, Search, CalendarClock, Zap, LogOut, LineChart as LineChartIcon, Activity, CircleDollarSign, HelpCircle, ReceiptText, Calculator, Trophy, X, Users, BriefcaseBusiness, ClipboardCheck, Building2, MapPinned } from "lucide-react";
import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

function navItemClass(active: boolean) {
  return active
    ? "border border-orange-200 bg-gradient-to-r from-orange-50 via-white to-white text-orange-700 shadow-[0_8px_22px_rgba(249,115,22,0.10)]"
    : "border border-transparent text-slate-500 hover:border-slate-200 hover:bg-white/90 hover:text-slate-950 hover:shadow-[0_8px_18px_rgba(15,23,42,0.05)]";
}

function isEmployeePortalNavItemActive(pathname: string, href: string) {
  const hrefPath = href.split("#")[0];
  if (hrefPath === "/employee-portals") return pathname === hrefPath;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}

type EmployeePortalNavProps = {
  activePathOverride?: string;
  data: MedicalRepPortalData;
  disableSessionGuard?: boolean;
  visibility: EmployeePortalNavVisibility;
};

type EmployeePortalNavItem = {
  href: string;
  label: string;
  icon: typeof Activity;
};

type EmployeePortalNavSection = {
  items: EmployeePortalNavItem[];
  title: string;
};

function buildEmployeePortalSections({
  showExpenseActionTab = false,
  showManagementTab = false,
  showTeamPerformanceTab = false,
  showMedRepsPerformanceTab = false,
  showDsmsPerformanceTab = false,
  showTeamExpensesTab = false,
  showLeaveApprovalsTab = false,
  showBrickCoverageTab = false,
  showVacanciesTab = false,
  showProbationTab = false,
  showOrganogramTab = false,
  showMyCoachingTab = false,
  showTeamCoachingTab = false,
}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {
  return [
    {
      title: "My Workspace",
      items: [
        { href: "/employee-portals", label: "Dashboard", icon: Activity },
        { href: "/employee-portals/sales", label: "My Performance", icon: LineChartIcon },
        { href: "/employee-portals/incentive", label: "Incentive", icon: Calculator },
        ...(showMyCoachingTab ? [{ href: "/employee-portals/coaching", label: "My Coaching Reports", icon: ClipboardCheck }] : []),
        { href: "/payslips", label: "Payslips", icon: CircleDollarSign },
        ...(showManagementTab ? [{ href: "/employee-portals/expense-dashboard", label: "Workload & Expense", icon: ReceiptText }] : []),
      ],
    },
    {
      title: "Line Performance",
      items: [
        ...(showTeamPerformanceTab ? [{ href: "/employee-portals/team-performance", label: "Team Performance", icon: Trophy }] : []),
        ...(showTeamCoachingTab ? [{ href: "/employee-portals/coaching", label: "Team Coaching Reports", icon: ClipboardCheck }] : []),
        ...(showMedRepsPerformanceTab ? [{ href: "/employee-portals/med-reps-performance", label: "MRs Performance", icon: Users }] : []),
        ...(showDsmsPerformanceTab ? [{ href: "/employee-portals/dsms-performance", label: "DSMs Performance", icon: BriefcaseBusiness }] : []),
        ...(showTeamExpensesTab ? [{ href: "/employee-portals/team-expenses", label: "Team Expenses", icon: ReceiptText }] : []),
        ...(showBrickCoverageTab ? [{ href: "/employee-portals/brick-coverage", label: "Brick Coverage", icon: MapPinned }] : []),
      ],
    },
    {
      title: "Line Operations",
      items: [
        ...(showVacanciesTab ? [{ href: "/employee-portals/vacancies", label: "Vacancies", icon: BriefcaseBusiness }] : []),
        ...(showProbationTab ? [{ href: "/employee-portals/probation", label: "Probation Tracker", icon: ClipboardCheck }] : []),
        ...(showOrganogramTab ? [{ href: "/employee-portals/organogram", label: "Organogram", icon: Building2 }] : []),
      ],
    },
    {
      title: "Actions",
      items: [
        ...(showExpenseActionTab ? [{ href: "/employee/outstation/new", label: "Expense", icon: ReceiptText }] : []),
        { href: "/employee-portals/leave", label: "Vacation / Leave", icon: CalendarClock },
        ...(showLeaveApprovalsTab ? [{ href: "/employee-portals/leave-approvals", label: "Leave Approvals", icon: CalendarClock }] : []),
      ],
    },
    {
      title: "Support",
      items: [
        { href: "/employee-portals/contact-hr-support", label: "Request Support", icon: HelpCircle },
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const handlePathnameChange = useEffectEvent(() => {
    startTransition(() => {
      setIsMobileMenuOpen(false);
    });
  });

  // Close mobile menu when pathname changes
  useEffect(() => {
    handlePathnameChange();
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
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 shadow-[0_12px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1560px] items-center gap-3 px-4 py-3 lg:px-8">
          <button
            aria-label="Menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700 lg:hidden"
            onClick={() => setIsMobileMenuOpen(true)}
            type="button"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 items-center gap-3">
            <PhoenixLogo />
            <div className="hidden min-w-0 border-l border-slate-200 pl-3 xl:block">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-orange-600">Employee Portal</p>
              <p className="truncate text-xs font-semibold text-slate-500">{data.employee.roleLabel}</p>
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
          <div className="hidden items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-bold text-orange-700 shadow-sm lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-500 ep-pulse-orange" />
            <Zap className="h-3.5 w-3.5" />
            <span>Live Performance</span>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1 shadow-sm lg:ml-0">
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
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Sidebar Content */}
      <div className={`fixed inset-y-0 left-0 z-50 w-[286px] transform border-r border-slate-200 bg-white p-6 shadow-2xl transition-transform duration-300 ease-in-out lg:hidden ${isMobileMenuOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between mb-8">
          <PhoenixLogo />
          <button
            aria-label="Close menu"
            className="h-10 w-10 flex items-center justify-center rounded-xl border border-slate-100 text-slate-400 hover:text-slate-600"
            onClick={() => setIsMobileMenuOpen(false)}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="space-y-5">
          {menuSections.map((section) => (
            <div key={section.title}>
              <p className="mb-2 px-2 text-[11px] font-bold uppercase tracking-[0.18em] text-orange-600">
                {section.title}
              </p>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const active = isEmployeePortalNavItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.label}
                      className={`flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-semibold transition duration-200 ${navItemClass(active)}`}
                      href={item.href}
                    >
                      <item.icon className="h-4 w-4" />
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
              onClick={handleLogout}
              type="button"
            >
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </button>
          </div>
        </nav>

        <div className="absolute bottom-8 left-6 right-6">
          <div className="rounded-2xl bg-orange-50 border border-orange-100 p-4">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center text-white text-xs font-bold shadow-[0_2px_6px_rgba(249,115,22,0.35)]">
                {initials}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{data.employee.fullName}</p>
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

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  return (
    <aside className="hidden w-[244px] shrink-0 lg:block">
      <div className="sticky top-[84px] space-y-2 rounded-[22px] border border-white/80 bg-white/[0.88] p-3 shadow-[0_18px_45px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        {sections.map((section) => (
          <div key={section.title} className="space-y-0.5">
            <p className="px-3 pb-1 pt-2.5 text-[10px] font-black uppercase tracking-[0.20em] text-orange-500">
              {section.title}
            </p>
            {section.items.map((item) => {
              const active = isEmployeePortalNavItemActive(pathname, item.href);
              return (
                <Link
                  key={item.label}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 ${navItemClass(active)}`}
                  href={item.href}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <div className="mt-2 border-t border-slate-100 pt-2">
          <button
            className="mt-1 flex w-full items-center gap-2.5 rounded-xl border border-transparent px-3 py-2.5 text-sm font-semibold text-slate-500 transition hover:border-slate-200 hover:bg-white hover:text-slate-800"
            onClick={handleLogout}
            type="button"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
