"use client";

import {
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  ChartColumnBig,
  Database,
  FileSpreadsheet,
  FileUp,
  Hourglass,
  IdCard,
  LayoutDashboard,
  Network,
  ScrollText,
  ShieldCheck,
  X,
  UsersRound,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { type NavigationMode, type PermissionAction, type PermissionResource } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type SidebarSection = {
  items: SidebarSectionItem[];
  label: string;
};

type SidebarPermission = {
  action?: PermissionAction;
  resource: PermissionResource;
};

export type PermissionLookup = Partial<Record<`${PermissionResource}:${PermissionAction}`, boolean>>;
type SidebarSectionItem = {
  href: string;
  icon: typeof ChartNoAxesColumnIncreasing;
  label: string;
  permissions?: SidebarPermission[];
};

function permissionAllowed(permissionLookup: PermissionLookup | undefined, permission?: SidebarPermission | SidebarPermission[]) {
  if (!permission) return true;

  const permissionList = Array.isArray(permission) ? permission : [permission];
  return permissionList.some((entry) => {
    const key = `${entry.resource}:${entry.action ?? "read"}` as const;
    if (!permissionLookup || typeof permissionLookup[key] === "undefined") return true;
    return Boolean(permissionLookup[key]);
  });
}

function getAdminSections(permissionLookup: PermissionLookup): SidebarSection[] {
  const sections: SidebarSection[] = [
    {
      items: [
        { href: "/admin", icon: LayoutDashboard, label: "Admin Command", permissions: [{ resource: "admin" }] },
        { href: "/admin/data-health", icon: Database, label: "Data Health", permissions: [{ resource: "admin" }] },
        { href: "/admin/monitoring", icon: ShieldCheck, label: "Monitoring", permissions: [{ resource: "admin" }] },
        { href: "/overview", icon: ChartColumnBig, label: "Overview Dashboard", permissions: [{ resource: "overview" }] },
        { href: "/admin/access", icon: ShieldCheck, label: "Users & Access", permissions: [{ resource: "admin_access" }] },
        { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }] },
        { href: "/imports/employees", icon: FileUp, label: "Bulk Import", permissions: [{ resource: "imports" }] },
      ],
      label: "Command Center",
    },
    {
      items: [
        { href: "/sales/queue", icon: FileUp, label: "Monthly Sales", permissions: [{ resource: "sales" }] },
        { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales Dashboard", permissions: [{ resource: "sales" }] },
      ],
      label: "Sales",
    },
    {
      items: [
        { href: "/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }] },
        { href: "/payroll/dashboard", icon: ChartColumnBig, label: "Payroll Dashboard", permissions: [{ resource: "payroll" }] },
        { href: "/payroll/expenses", icon: FileSpreadsheet, label: "Expenses", permissions: [{ resource: "expenses" }] },
        { href: "/payroll/expenses/dashboard", icon: ChartColumnBig, label: "Expenses Dashboard", permissions: [{ resource: "expenses" }] },
      ],
      label: "Control Tower",
    },
    {
      items: [{ href: "/payslips", icon: IdCard, label: "Payslips Center", permissions: [{ resource: "payslips" }] }],
      label: "Employee Portals",
    },
    {
      items: [
        { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
        { href: "/offers", icon: IdCard, label: "Offer Lifecycle", permissions: [{ resource: "offers" }] },
        { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }] },
        { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      ],
      label: "Employee Management",
    },
    {
      items: [
        { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }] },
        { href: "/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
        { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar", permissions: [{ resource: "hr_calendar" }] },
      ],
      label: "Tracking",
    },
  ];

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => permissionAllowed(permissionLookup, item.permissions)),
    }))
    .filter((section) => section.items.length > 0);
}

function getEmployeePortalSections(permissionLookup: PermissionLookup): SidebarSection[] {
  const sections: SidebarSection[] = [
    {
      items: [
        { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", permissions: [{ resource: "employee_profile" }] },
        { href: "/employee-portals/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales", permissions: [{ resource: "sales" }] },
        { href: "/employee-portals/payroll", icon: ChartColumnBig, label: "Payroll & Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }] },
      ],
      label: "Medical Rep Portal",
    },
  ];

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => permissionAllowed(permissionLookup, item.permissions)),
    }))
    .filter((section) => section.items.length > 0);
}

function getSections(mode: NavigationMode, permissionLookup: PermissionLookup): SidebarSection[] {
  return mode === "employee-portal"
    ? getEmployeePortalSections(permissionLookup)
    : getAdminSections(permissionLookup);
}

function getHomePath(mode: NavigationMode) {
  if (mode === "employee-portal") return "/employee-portals";
  return "/admin";
}

function isActivePath(pathname: string, href: string, activeTab: string | null) {
  const baseHref = href.split("?")[0];
  if (href.includes("tab=governance")) return pathname === baseHref && activeTab === "governance";
  if (href.includes("tab=generate")) return pathname === baseHref && activeTab === "generate";
  if (baseHref === "/overview") return pathname === "/overview";
  if (baseHref === "/employee-portals") return pathname === "/employee-portals";
  if (baseHref === "/sales") return pathname === "/sales";
  if (baseHref === "/employee-portals/sales") return pathname === "/employee-portals/sales";
  if (baseHref === "/payroll") return pathname === "/payroll";
  if (baseHref === "/employee-portals/payroll") return pathname === "/employee-portals/payroll";
  if (baseHref === "/payroll/dashboard") return pathname === "/payroll/dashboard";
  if (baseHref === "/payroll/expenses") return pathname === "/payroll/expenses";
  return pathname.startsWith(baseHref);
}

function SidebarNav({
  mode = "admin",
  onNavigate,
  permissionLookup = {},
}: {
  mode?: NavigationMode;
  onNavigate?: () => void;
  permissionLookup?: PermissionLookup;
}) {
  const sections = getSections(mode, permissionLookup);
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<string | null>(pathname === "/payroll" ? "governance" : null);

  const initialCollapsed = Object.fromEntries(sections.map((s) => [s.label, false]));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(initialCollapsed);

  function toggleSection(label: string) {
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  return (
    <>
      <nav className="flex-1 overflow-auto px-3 py-4">
        {sections.map((section, sectionIndex) => {
          const isCollapsed = collapsed[section.label];
          const hasActive = section.items.some((item) => isActivePath(pathname, item.href, activeTab));

          return (
            <div className={cn(sectionIndex > 0 && "mt-5")} key={section.label}>
              <button
                className={cn(
                  "group mb-1.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-[#F8FAFC]",
                )}
                onClick={() => toggleSection(section.label)}
                type="button"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform duration-200",
                    isCollapsed ? "rotate-0 text-[#64748B]" : "rotate-90 text-[#64748B]",
                    hasActive && "text-[#F97316]",
                  )}
                />
                <span
                  className={cn(
                    "text-[9px] font-black uppercase tracking-[0.24em] transition-colors",
                    hasActive ? "text-[#F97316]" : "text-[#64748B] group-hover:text-[#0F172A]",
                  )}
                >
                  {section.label}
                </span>
              </button>

              {!isCollapsed && (
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const active = isActivePath(pathname, item.href, activeTab);
                    return (
                      <a
                        className={cn(
                          "group relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-xs font-semibold transition-all duration-150",
                          active
                            ? "bg-gradient-to-r from-[#F97316]/10 to-[#F97316]/5 text-[#0F172A] shadow-[0_4px_12px_rgba(249,115,22,0.1)] border border-[#F97316]/20"
                            : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]",
                        )}
                        href={item.href}
                        key={item.label}
                        onClick={() => {
                          if (item.href.includes("tab=generate")) setActiveTab("generate");
                          else if (item.href.includes("tab=governance")) setActiveTab("governance");
                          else setActiveTab(null);
                          onNavigate?.();
                        }}
                      >
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
                            active
                              ? "bg-[#F97316] text-white"
                              : "bg-[#F8FAFC] text-[#64748B] group-hover:bg-[#F97316]/10 group-hover:text-[#F97316]",
                          )}
                        >
                          <item.icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {active && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#F97316] shadow-[0_0_8px_rgba(249,115,22,0.5)]" />
                        )}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </>
  );
}

function SidebarLogo({
  mode = "admin",
  onNavigate,
}: {
  mode?: NavigationMode;
  onNavigate?: () => void;
}) {
  const homePath = getHomePath(mode);

  return (
    <Link
      className="mx-3 mt-3 flex items-center gap-3 rounded-2xl border border-[#E2E8F0] bg-white px-3 py-3 transition hover:bg-[#F8FAFC]"
      href={homePath}
      onClick={onNavigate}
    >
      <Image
        alt="Phoenix"
        className="h-10 w-10 object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.55)]"
        height={40}
        src="/brand/phoenix-bird-icon.png"
        width={40}
      />
      <div className="min-w-0">
        <p className="whitespace-nowrap text-sm font-black tracking-[0.2em] text-[#0F172A]">
          PHOENI<span className="text-[#F97316]">X</span>
        </p>
        <p className="mt-0.5 truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-[#64748B]">
          People Intelligence
        </p>
      </div>
    </Link>
  );
}

function SidebarFooter() {
  return (
    <div className="p-3">
      <div className="overflow-hidden rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-2">
        <Image
          alt="Phoenix People Performance Intelligence"
          className="h-full w-full object-contain opacity-90"
          height={172}
          src="/brand/phoenix-sidebar-square.png"
          width={172}
        />
      </div>
    </div>
  );
}

export function Sidebar({
  navigationMode = "admin",
  permissionLookup = {},
}: {
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-[#E2E8F0] bg-white text-[#0F172A] shadow-[0_8px_20px_rgba(15,23,42,0.04)] lg:flex">
      <SidebarLogo mode={navigationMode} />
      <div className="mx-5 mt-3 h-px bg-[#E2E8F0]" />
      <SidebarNav mode={navigationMode} onNavigate={undefined} permissionLookup={permissionLookup} />
      <SidebarFooter />
    </aside>
  );
}

export function MobileSidebar({
  onClose,
  open,
  navigationMode = "admin",
  permissionLookup = {},
}: {
  onClose: () => void;
  open: boolean;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "fixed inset-0 z-50 lg:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <button
        aria-label="Close menu"
        className={cn(
          "absolute inset-0 bg-slate-950/55 backdrop-blur-sm transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        type="button"
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex w-[min(86vw,310px)] flex-col border-r border-[#E2E8F0] bg-white text-[#0F172A] shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <SidebarLogo mode={navigationMode} onNavigate={onClose} />
          <button
            aria-label="Close menu"
            className="mr-3 mt-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F8FAFC] text-[#64748B] transition hover:bg-[#E2E8F0] hover:text-[#0F172A]"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mx-5 mt-3 h-px bg-[#E2E8F0]" />
        <SidebarNav
          mode={navigationMode}
          onNavigate={onClose}
          permissionLookup={permissionLookup}
        />
        <SidebarFooter />
      </aside>
    </div>
  );
}
