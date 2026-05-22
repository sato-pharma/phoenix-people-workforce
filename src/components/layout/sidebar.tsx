"use client";

import {
  BriefcaseBusiness,
  BellRing,
  CalendarClock,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  ChartColumnBig,
  ClipboardCheck,
  FileSpreadsheet,
  FileCheck2,
  FilePlus2,
  FileUp,
  Fingerprint,
  Hourglass,
  IdCard,
  LayoutDashboard,
  Mail,
  MapPinned,
  Megaphone,
  Network,
  Database,
  Radar,
  ReceiptText,
  ScrollText,
  ShieldCheck,
  Settings2,
  X,
  UsersRound,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { type NavigationMode, type PermissionAction, type PermissionResource, type PhoenixRole } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

type SidebarSection = {
  id: string;
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
  excludedRoles?: PhoenixRole[];
  roles?: PhoenixRole[];
  permissions?: SidebarPermission[];
};

const SIDEBAR_COLLAPSED_STORAGE_PREFIX = "phoenix-sidebar-collapsed";
const SIDEBAR_COLLAPSED_STORAGE_EVENT = "phoenix-sidebar-collapsed-change";
const EMPTY_PERMISSION_LOOKUP: PermissionLookup = {};

function permissionAllowed(permissionLookup: PermissionLookup | undefined, permission?: SidebarPermission | SidebarPermission[]) {
  if (!permission) return true;

  const permissionList = Array.isArray(permission) ? permission : [permission];
  return permissionList.some((entry) => {
    const key = `${entry.resource}:${entry.action ?? "read"}` as const;
    if (!permissionLookup || typeof permissionLookup[key] === "undefined") return true;
    return Boolean(permissionLookup[key]);
  });
}

function roleAllowed(currentRole: PhoenixRole | undefined, roles?: PhoenixRole[]) {
  if (!roles) return true;
  return Boolean(currentRole && roles.includes(currentRole));
}

function roleNotExcluded(currentRole: PhoenixRole | undefined, excludedRoles?: PhoenixRole[]) {
  if (!excludedRoles) return true;
  return !currentRole || !excludedRoles.includes(currentRole);
}

function getAdminSections(permissionLookup: PermissionLookup, currentRole?: PhoenixRole): SidebarSection[] {
  const sections: SidebarSection[] = [
    {
      id: "command-center",
      items: [
        { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }] },
        { href: "/admin/data-health", icon: Database, label: "Data Health", permissions: [{ resource: "admin" }] },
        { href: "/admin/monitoring", icon: Radar, label: "Monitoring", permissions: [{ resource: "admin" }] },
        { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }] },
      ],
      label: "Command Center",
    },
    {
      id: "people-management",
      items: [
        { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }] },
        { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
        { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
        { href: "/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies" }] },
        { href: "/offers", icon: IdCard, label: "Offer Lifecycle", permissions: [{ resource: "offers" }] },
        { href: "/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }] },
        { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }] },
        { href: "/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
        { href: "/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
      ],
      label: "People Management",
    },
    {
      id: "attendance-management",
      items: [
        { href: "/attendance/fingerprint-report", icon: FileSpreadsheet, label: "Fingerprint Report", permissions: [{ resource: "employees" }] },
        { href: "/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", excludedRoles: ["HR Specialist"], permissions: [{ resource: "employees", action: "update" }] },
        { href: "/attendance/policies", icon: CalendarClock, label: "Attendance Policies", excludedRoles: ["HR Specialist"], permissions: [{ resource: "employees", action: "update" }] },
        { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar", permissions: [{ resource: "hr_calendar" }] },
      ],
      label: "Attendance Management",
    },
    {
      id: "sales-performance",
      items: [
        { href: "/sales/queue", icon: FileUp, label: "Monthly Sales", permissions: [{ resource: "sales" }] },
        { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales Dashboard", permissions: [{ resource: "sales" }] },
        { href: "/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
        { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
      ],
      label: "Sales & Performance",
    },
    {
      id: "marketing-requests",
      items: [
        { href: "/admin/marketing-requests/validation", icon: ShieldCheck, label: "HCP / PH Validation", roles: ["District Manager", "SFE Manager", "Super Admin"] },
        { href: "/admin/marketing-requests", icon: Megaphone, label: "Marketing Requests", roles: ["District Manager", "SFE Manager", "Super Admin"] },
        { href: "/admin/marketing-requests/control", icon: Settings2, label: "Marketing Control", roles: ["District Manager", "SFE Manager", "Super Admin"] },
        { href: "/admin/marketing-requests/customer-database", icon: Database, label: "SCP / PH Database", roles: ["Super Admin"] },
      ],
      label: "Marketing Requests",
    },
    {
      id: "payroll",
      items: [
        { href: "/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }] },
        { href: "/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips" }], roles: ["Super Admin"] },
        { href: "/payslips", icon: ScrollText, label: "My Payslips", permissions: [{ resource: "payslips" }], roles: ["HR Specialist"] },
      ],
      label: "Payroll Management",
    },
    {
      id: "expenses-outstation",
      items: [
        { href: "/payroll/expenses", icon: FileSpreadsheet, label: "Expenses", permissions: [{ resource: "expenses" }] },
        { href: "/payroll/expenses/dashboard", icon: ChartColumnBig, label: "Expenses Dashboard", permissions: [{ resource: "expenses" }] },
        { href: "/admin/outstation/requests", icon: MapPinned, label: "Outstation Requests", permissions: [{ resource: "outstation" }] },
        { href: "/admin/outstation/policy", icon: CalendarClock, label: "Outstation Policy", permissions: [{ resource: "outstation", action: "update" }] },
        { href: "/admin/outstation/heatmaps", icon: MapPinned, label: "Outstation Heatmaps", permissions: [{ resource: "outstation" }] },
      ],
      label: "Expenses & Outstation",
    },
    {
      id: "leave-management",
      items: [
        { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
        { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
        { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      ],
      label: "Leave Management",
    },
    {
      id: "access-communication",
      items: [
        { href: "/admin/access", icon: ShieldCheck, label: "Users & Access", permissions: [{ resource: "admin_access" }] },
        { href: "/admin/email-reply-composer", icon: Mail, label: "Email Composer", permissions: [{ resource: "communication" }] },
        { href: "/admin/email-templates", icon: BellRing, label: "Email Templates", permissions: [{ resource: "communication" }] },
      ],
      label: "Access & Communication",
    },
  ];

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => permissionAllowed(permissionLookup, item.permissions) && roleAllowed(currentRole, item.roles)),
    }))
    .filter((section) => section.items.length > 0);
}

function getEmployeePortalSections(permissionLookup: PermissionLookup, currentRole?: PhoenixRole): SidebarSection[] {
  const sections: SidebarSection[] = [
    {
      id: "employee-portal",
      items: [
        { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }] },
        { href: "/employee-portals/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales", excludedRoles: ["Training Manager"], permissions: [{ resource: "sales" }] },
        { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
        { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
        { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
        { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
        { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
        { href: "/payslips", icon: ChartColumnBig, label: "Payroll & Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }] },
        { href: "/employee/outstation/new", icon: MapPinned, label: "Outstation", permissions: [{ resource: "outstation" }] },
        { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
        { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Workload & Expense", permissions: [{ resource: "expenses" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Training Manager", "Manager"] },
        { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "National Sales Manager"] },
        { href: "/employee-portals/team-expenses", icon: ReceiptText, label: "Team Expenses", permissions: [{ resource: "expenses" }], roles: ["National Sales Manager"] },
      ],
      label: "Medical Rep Portal",
    },
    {
      id: "employee-marketing-requests",
      items: [
        {
          href: "/employee-portals/marketing-requests/validation",
          icon: ShieldCheck,
          label: "HCP / PH Validation",
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
          href: "/employee-portals/marketing-requests/control",
          icon: Settings2,
          label: "Marketing Control",
          roles: ["SFE Manager", "Super Admin"],
        },
        {
          href: "/employee-portals/marketing-requests/customer-database",
          icon: Database,
          label: "SCP / PH Database",
          roles: ["Super Admin"],
        },
      ],
      label: "Marketing Requests",
    },
    {
      id: "leave-management",
      items: [
        { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
        { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
        { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      ],
      label: "Leave Management",
    },
  ];

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => permissionAllowed(permissionLookup, item.permissions) && roleAllowed(currentRole, item.roles) && roleNotExcluded(currentRole, item.excludedRoles)),
    }))
    .filter((section) => section.items.length > 0);
}

function getSections(mode: NavigationMode, permissionLookup: PermissionLookup, currentRole?: PhoenixRole): SidebarSection[] {
  return mode === "employee-portal"
    ? getEmployeePortalSections(permissionLookup, currentRole)
    : getAdminSections(permissionLookup, currentRole);
}

function getHomePath(mode: NavigationMode) {
  if (mode === "employee-portal") return "/employee-portals";
  return "/admin/access";
}

function isActivePath(pathname: string, href: string, activeTab: string | null) {
  const baseHref = href.split("?")[0];
  if (href.includes("tab=governance")) return pathname === baseHref && activeTab === "governance";
  if (href.includes("tab=generate")) return pathname === baseHref && activeTab === "generate";
  if (baseHref === "/employee-portals") return pathname === "/employee-portals";
  if (baseHref === "/employee-portals/marketing-requests") return pathname === "/employee-portals/marketing-requests";
  if (baseHref === "/admin/marketing-requests") return pathname === "/admin/marketing-requests";
  if (baseHref === "/sales") return pathname === "/sales";
  if (baseHref === "/employee-portals/sales") return pathname === "/employee-portals/sales";
  if (baseHref === "/payroll") return pathname === "/payroll";
  if (baseHref === "/payslips") return pathname === "/payslips";
  if (baseHref === "/payroll/expenses") return pathname === "/payroll/expenses";
  return pathname === baseHref || pathname.startsWith(`${baseHref}/`);
}

function getActiveHref(pathname: string, sections: SidebarSection[], activeTab: string | null) {
  const matches = sections
    .flatMap((section) => section.items)
    .filter((item) => isActivePath(pathname, item.href, activeTab))
    .sort((left, right) => right.href.split("?")[0].length - left.href.split("?")[0].length);

  return matches[0]?.href ?? null;
}

function getCollapsedStorageKey(mode: NavigationMode) {
  return `${SIDEBAR_COLLAPSED_STORAGE_PREFIX}:${mode}`;
}

function parseCollapsedSectionIds(rawValue: string, validSectionIds: Set<string>) {
  const collapsed = new Set<string>();

  try {
    const parsedValue: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return collapsed;

    for (const value of parsedValue) {
      if (typeof value === "string" && validSectionIds.has(value)) {
        collapsed.add(value);
      }
    }
  } catch {
    return new Set<string>();
  }

  return collapsed;
}

function getCollapsedSectionSnapshot(storageKey: string) {
  if (typeof window === "undefined") return "[]";

  try {
    return window.localStorage.getItem(storageKey) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeToCollapsedSectionChanges(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  window.addEventListener("storage", onStoreChange);
  window.addEventListener(SIDEBAR_COLLAPSED_STORAGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(SIDEBAR_COLLAPSED_STORAGE_EVENT, onStoreChange);
  };
}

function writeCollapsedSectionIds(storageKey: string, collapsedSectionIds: Set<string>) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(Array.from(collapsedSectionIds)));
    window.dispatchEvent(new Event(SIDEBAR_COLLAPSED_STORAGE_EVENT));
  } catch {
    // Sidebar preferences are optional. Private browsing/storage failures should not block navigation.
  }
}

function SidebarNav({
  mode = "admin",
  onNavigate,
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  mode?: NavigationMode;
  onNavigate?: () => void;
  permissionLookup?: PermissionLookup;
}) {
  const sections = useMemo(
    () => getSections(mode, permissionLookup, currentRole),
    [currentRole, mode, permissionLookup],
  );
  const pathname = usePathname();
  const navInstanceId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<string | null>(pathname === "/payroll" ? "governance" : null);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedSearchQuery = mode === "admin" ? searchQuery.trim().toLowerCase() : "";
  const visibleSections = useMemo(() => {
    if (!normalizedSearchQuery) return sections;

    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => item.label.toLowerCase().includes(normalizedSearchQuery)),
      }))
      .filter((section) => section.items.length > 0);
  }, [normalizedSearchQuery, sections]);
  const activeHref = getActiveHref(pathname, sections, activeTab);
  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const activeSectionId = sections.find((section) => section.items.some((item) => item.href === activeHref))?.id ?? null;
  const collapsedStorageKey = getCollapsedStorageKey(mode);
  const collapsedSectionSnapshot = useSyncExternalStore(
    subscribeToCollapsedSectionChanges,
    () => getCollapsedSectionSnapshot(collapsedStorageKey),
    () => "[]",
  );
  const collapsedSectionIds = useMemo(() => {
    const validSectionIds = new Set(sectionIds);
    const nextCollapsedSectionIds = parseCollapsedSectionIds(collapsedSectionSnapshot, validSectionIds);

    if (activeSectionId) {
      nextCollapsedSectionIds.delete(activeSectionId);
    }

    return nextCollapsedSectionIds;
  }, [activeSectionId, collapsedSectionSnapshot, sectionIds]);

  useEffect(() => {
    if (mode !== "admin") return;

    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [mode]);

  function toggleSection(sectionId: string) {
    const nextCollapsedSectionIds = new Set(collapsedSectionIds);

    if (nextCollapsedSectionIds.has(sectionId)) {
      nextCollapsedSectionIds.delete(sectionId);
    } else {
      nextCollapsedSectionIds.add(sectionId);
    }

    if (activeSectionId) {
      nextCollapsedSectionIds.delete(activeSectionId);
    }

    writeCollapsedSectionIds(collapsedStorageKey, nextCollapsedSectionIds);
  }

  return (
    <>
      {mode === "admin" && (
        <div className="px-3 pt-3">
          <input
            ref={searchInputRef}
            aria-label="Search sidebar modules"
            className="h-9 w-full rounded-[14px] border border-[#333333] bg-[#050505] px-3 text-[13px] font-semibold text-[#D4DDE8] outline-none transition placeholder:text-[#64748B] focus:border-[#F97316]/60 focus:ring-2 focus:ring-[#F97316]/30"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder="Search modules..."
            type="search"
            value={searchQuery}
          />
        </div>
      )}
      <nav className="phoenix-admin-sidebar-scroll flex-1 overflow-auto px-3 py-5 text-[#000000]">
        {visibleSections.map((section, sectionIndex) => {
          const hasActive = section.items.some((item) => item.href === activeHref);
          const adminSection = mode === "admin";
          const collapsed = !normalizedSearchQuery && collapsedSectionIds.has(section.id) && !hasActive;
          const sectionContentId = `${navInstanceId}-${section.id}-items`;

          return (
            <Fragment key={section.label}>
              <div
                className={cn(
                  adminSection ? "px-1.5" : "px-2",
                  sectionIndex > 0 && "mt-6",
                )}
              >
                <button
                  aria-controls={sectionContentId}
                  aria-expanded={!collapsed}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000]",
                    adminSection && "border-t border-[#333333] px-2 pt-4",
                  )}
                  onClick={() => toggleSection(section.id)}
                  type="button"
                >
                  <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#FFF7ED]", adminSection && "bg-[#000000] ring-1 ring-[#333333]")}>
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 text-[#F97316] transition-transform duration-300 ease-out",
                        adminSection && "text-[#F59E0B]",
                        hasActive && "text-[#FB923C]",
                        !collapsed && "rotate-90",
                      )}
                    />
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate text-[11px] font-black uppercase tracking-[0.18em] text-[#F97316]", adminSection && "text-[#F8B56B]")}>
                    {section.label}
                  </span>
                </button>
              </div>

              <div
                aria-hidden={collapsed}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
                )}
                id={sectionContentId}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={cn(
                      "mt-2 space-y-1.5 px-1",
                      adminSection && "p-1",
                    )}
                  >
                    {section.items.map((item) => {
                      const active = item.href === activeHref;
                      return (
                        <Link
                          className={cn(
                            "group relative flex w-full items-center gap-3 rounded-[18px] px-3 py-3 text-[13px] font-semibold transition-all duration-150",
                            adminSection
                              ? active
                                ? "bg-[linear-gradient(180deg,#1a1a1a_0%,#000000_100%)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_24px_rgba(0,0,0,0.24)]"
                                : "text-[#D4DDE8] hover:bg-[#1a1a1a] hover:text-white"
                              : active
                                ? "bg-[#FFF7ED] text-[#0F172A]"
                                : "text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#0F172A]",
                          )}
                          href={item.href}
                          key={`${item.href}-${item.label}`}
                          prefetch={false}
                          tabIndex={collapsed ? -1 : undefined}
                          onClick={() => {
                            if (item.href.includes("tab=generate")) setActiveTab("generate");
                            else if (item.href.includes("tab=governance")) setActiveTab("governance");
                            else setActiveTab(null);
                            onNavigate?.();
                          }}
                        >
                          {adminSection && (
                            <span
                              className={cn(
                                "absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full bg-[#F97316] transition-opacity",
                                active ? "opacity-100" : "opacity-0",
                              )}
                            />
                          )}
                          <span
                            className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] transition-colors duration-150",
                              adminSection
                                ? active
                                  ? "bg-[linear-gradient(180deg,#FF8A1C_0%,#F97316_100%)] text-white shadow-[0_10px_18px_rgba(249,115,22,0.28)]"
                                  : "bg-[#000000] text-[#94A3B8] ring-1 ring-[#333333] group-hover:border-[#3A475C] group-hover:text-[#F8B56B]"
                                : active
                                  ? "bg-[#F97316] text-white"
                                  : "bg-[#F8FAFC] text-[#64748B] ring-1 ring-[#E2E8F0] group-hover:bg-white group-hover:text-[#F97316]",
                            )}
                          >
                            <item.icon className="h-4 w-4" />
                          </span>
                          <span className={cn("min-w-0 flex-1 truncate", adminSection && "tracking-[-0.01em]")}>{item.label}</span>
                          {active && (
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#F59E0B] shadow-[0_0_10px_rgba(245,158,11,0.7)]" />
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Fragment>
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

  if (mode === "admin") {
    return (
      <Link
        className="mx-2 mt-2 block overflow-hidden rounded-[22px] border border-[#333333] bg-[#050505] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_14px_30px_rgba(0,0,0,0.28)] transition hover:border-[#F97316]/60"
        href={homePath}
        onClick={onNavigate}
      >
        <span className="relative block h-[82px] w-full">
          <Image
            alt="Phoenix Admin Intelligence"
            className="object-cover"
            fill
            priority
            sizes="260px"
            src="/brand/phoenix-admin-intelligence-badge.png"
          />
        </span>
      </Link>
    );
  }

  return (
    <Link
      className={cn(
        "mx-3 mt-3 flex items-center gap-3 rounded-[22px] px-4 py-4 transition",
      )}
      href={homePath}
      onClick={onNavigate}
    >
      <Image
        alt="Phoenix"
        className="h-11 w-11 object-contain drop-shadow-[0_0_16px_rgba(249,115,22,0.5)]"
        height={44}
        src="/brand/phoenix-bird-icon.png"
        width={44}
      />
      <div className="min-w-0">
        <p className="whitespace-nowrap text-[15px] font-black tracking-[0.26em] text-[#0F172A]">
          PHOENI<span className="text-[#F97316]">X</span>
        </p>
        <p className="mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-[#64748B]">
          Workforce Portal
        </p>
      </div>
    </Link>
  );
}

function SidebarIntro({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") {
    return null;
  }

  return (
    <div className="mx-3 mt-3 rounded-[24px] border border-[#E2E8F0] bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#F97316]">
        Portal
      </p>
      <p className="mt-2 text-lg font-black tracking-[-0.03em] text-[#0F172A]">
        Employee workspace
      </p>
      <p className="mt-2 text-sm leading-6 text-[#64748B]">
        Personal access to performance, payroll, and support workflows.
      </p>
    </div>
  );
}

function SidebarFooter({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") {
    return null;
  }

  return (
    <div className="p-3">
      <div className="overflow-hidden rounded-[24px] border border-[#E2E8F0] bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)] p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#F97316]/10 text-[#F97316]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F172A]">Portal workspace</p>
            <p className="mt-1 text-xs leading-5 text-[#64748B]">
              Your links and views adapt to the access granted to this account.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({
  navigationMode = "admin",
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[276px] shrink-0 flex-col border-r border-[#1a1a1a] bg-[#000000] text-[#0F172A] lg:flex">
      <SidebarLogo mode={navigationMode} />
      <SidebarIntro mode={navigationMode} />
      <SidebarNav currentRole={currentRole} mode={navigationMode} onNavigate={undefined} permissionLookup={permissionLookup} />
      <SidebarFooter mode={navigationMode} />
    </aside>
  );
}

export function MobileSidebar({
  onClose,
  open,
  navigationMode = "admin",
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
}: {
  currentRole?: PhoenixRole;
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
      inert={!open}
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
          "absolute inset-y-0 left-0 flex w-[min(90vw,320px)] flex-col border-r border-[#1a1a1a] bg-[#000000] text-[#0F172A] shadow-2xl transition-transform duration-200",
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
        <SidebarIntro mode={navigationMode} />
        <SidebarNav
          currentRole={currentRole}
          mode={navigationMode}
          onNavigate={onClose}
          permissionLookup={permissionLookup}
        />
        <SidebarFooter mode={navigationMode} />
      </aside>
    </div>
  );
}
