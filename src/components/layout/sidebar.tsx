"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix Workforce — Admin & Portal navigation sidebar
//
// One component drives two surfaces (decided by `navigationMode`):
//   • "admin"           → deep-navy "command" chrome that matches the CEO hero
//                         identity card gradient (#0B1120 → #111C32 → #0A1A3A),
//                         with a streamlined smart toolkit: module search, grouped
//                         collapsible sections, and a collapse-to-icon-rail.
//   • "employee-portal" → a calm, light grouped-navigation list.
//
// Everything visual lives here; the *data* (links, icons, permissions, roles) is the
// single source of truth in `@/config/system-navigation`. Visibility is filtered by
// the same permission/role gating the API enforces — the sidebar is UX, never the
// security boundary. The active-path matcher below intentionally special-cases a few
// query-param routes (tab=/action=) so highlighting stays correct.
// ─────────────────────────────────────────────────────────────────────────────

import {
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  getNavigationSections,
  navigationHomePathByMode,
  type NavigationPermission,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { systemAssets, systemIdentity, systemUiText } from "@/config/system-settings";
import { type NavigationMode, type PermissionAction, type PermissionResource, type PhoenixRole } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

// ── Shared admin palette — matches the top navigation bar exactly ────────────
// The Topbar admin header (topbar.tsx) is a flat pure-black surface
// (`bg-[#000000]`) with a `#1a1a1a` hairline border. The sidebar reuses the SAME
// flat black and hairline — no gradient, no decorative glow — so the navbar and
// sidebar read as one continuous, identically-coloured chrome around the app.
const ADMIN_SIDEBAR_BG = "bg-[#000000]";
const ADMIN_SIDEBAR_BORDER = "border-[#1a1a1a]";

// ── Public types ─────────────────────────────────────────────────────────────
type SidebarPermission = NavigationPermission;
export type PermissionLookup = Partial<Record<`${PermissionResource}:${PermissionAction}`, boolean>>;
type PermissionLookupKey = keyof PermissionLookup;

const EMPTY_PERMISSION_LOOKUP: PermissionLookup = {};

// localStorage keys (kept stable so a user's saved layout survives this rebuild).
const COLLAPSED_KEY_PREFIX = "phoenix-sidebar-collapsed";
const COLLAPSED_EVENT = "phoenix-sidebar-collapsed-change";
const PREFS_EVENT = "phoenix-sidebar-prefs-change";

const SIDEBAR_WIDTH_EXPANDED = "w-[280px]";
const SIDEBAR_WIDTH_RAIL = "w-[76px]";

// ── Visibility gating (mirrors the server permission matrix) ─────────────────
function permissionAllowed(lookup: PermissionLookup | undefined, permission?: SidebarPermission | readonly SidebarPermission[]) {
  if (!permission) return true;
  const list: readonly SidebarPermission[] = Array.isArray(permission) ? permission : [permission];
  return list.some((entry) => {
    const action: PermissionAction = entry.action ?? "read";
    const key: PermissionLookupKey = `${entry.resource}:${action}`;
    if (!lookup || typeof lookup[key] === "undefined") return true;
    return Boolean(lookup[key]);
  });
}

function roleAllowed(role: PhoenixRole | undefined, roles?: readonly PhoenixRole[]) {
  if (!roles) return true;
  return Boolean(role && roles.includes(role));
}

function roleNotExcluded(role: PhoenixRole | undefined, excludedRoles?: readonly PhoenixRole[]) {
  if (!excludedRoles) return true;
  return !role || !excludedRoles.includes(role);
}

function getSections(mode: NavigationMode, lookup: PermissionLookup, role?: PhoenixRole): NavigationSection[] {
  return getNavigationSections(mode)
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          permissionAllowed(lookup, item.permissions) &&
          roleAllowed(role, item.roles) &&
          (mode !== "employee-portal" || roleNotExcluded(role, item.excludedRoles)),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

// ── Active-route detection (special-cases query-param destinations) ──────────
function isActivePath(pathname: string, href: string, activeTab: string | null) {
  const baseHref = href.split("?")[0];
  if (href.includes("tab=governance")) return pathname === baseHref && activeTab === "governance";
  if (href.includes("tab=generate")) return pathname === baseHref && activeTab === "generate";
  if (baseHref === "/employee-portals") return pathname === "/employee-portals";
  if (baseHref === "/employee-portals/marketing-requests") return pathname === "/employee-portals/marketing-requests";
  if (baseHref === "/admin/marketing-requests") return pathname === "/admin/marketing-requests";
  if (href.includes("action=create-manager-expense")) return pathname === "/admin/outstation/requests" && activeTab === "create-manager-expense";
  if (baseHref === "/sales") return pathname === "/sales";
  if (baseHref === "/employee-portals/sales") return pathname === "/employee-portals/sales";
  if (baseHref === "/payroll") return pathname === "/payroll";
  if (baseHref === "/payslips") return pathname === "/payslips";
  if (baseHref === "/payroll/expenses") return pathname === "/payroll/expenses";
  return pathname === baseHref || pathname.startsWith(`${baseHref}/`);
}

function getActiveHref(pathname: string, sections: NavigationSection[], activeTab: string | null) {
  const matches = sections
    .flatMap((section) => section.items)
    .filter((item) => isActivePath(pathname, item.href, activeTab))
    .sort((left, right) => right.href.split("?")[0].length - left.href.split("?")[0].length);
  return matches[0]?.href ?? null;
}

// ── Persistence: collapsed-section set (cross-tab synced) ─────────────────────
function collapsedStorageKey(mode: NavigationMode) {
  return `${COLLAPSED_KEY_PREFIX}:${mode}`;
}

function parseCollapsedIds(raw: string, valid: Set<string>) {
  const out = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const value of parsed) {
      if (typeof value === "string" && valid.has(value)) out.add(value);
    }
  } catch {
    return new Set<string>();
  }
  return out;
}

function readCollapsedSnapshot(key: string) {
  if (typeof window === "undefined") return "[]";
  try {
    return window.localStorage.getItem(key) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeCollapsed(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSED_EVENT, onChange);
  };
}

function writeCollapsedIds(key: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
    window.dispatchEvent(new Event(COLLAPSED_EVENT));
  } catch {
    // Preferences are optional; storage failures must never block navigation.
  }
}

// ── Persistence: boolean pref (rail collapse) ────────────────────────────────
function prefKey(base: string, mode: NavigationMode) {
  return `phoenix-sidebar-${base}:${mode}`;
}

function readPref(key: string) {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function subscribePrefs(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(PREFS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PREFS_EVENT, onChange);
  };
}

function writePref(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(PREFS_EVENT));
  } catch {
    // Preferences are optional; storage failures must never block navigation.
  }
}

function useBooleanPref(key: string): boolean {
  const snapshot = useSyncExternalStore(subscribePrefs, () => readPref(key), () => "");
  return snapshot === "true";
}

// ── A single navigation entry ────────────────────────────────────────────────
function NavRow({
  active,
  dark,
  item,
  onActivate,
  onHover,
  onHoverEnd,
  rail,
}: {
  active: boolean;
  dark: boolean;
  item: NavigationSectionItem;
  onActivate: () => void;
  onHover?: (rect: DOMRect) => void;
  onHoverEnd?: () => void;
  rail: boolean;
}) {
  const Icon = item.icon;

  return (
    <div
      className="group relative"
      onMouseEnter={rail && onHover ? (event) => onHover(event.currentTarget.getBoundingClientRect()) : undefined}
      onMouseLeave={rail ? onHoverEnd : undefined}
    >
      <Link
        aria-current={active ? "page" : undefined}
        aria-label={rail ? item.label : undefined}
        className={cn(
          "relative flex w-full items-center text-[13px] font-semibold transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60 focus-visible:ring-offset-2",
          dark ? "focus-visible:ring-offset-slate-900" : "focus-visible:ring-offset-white",
          rail ? "justify-center px-0 py-2.5" : "gap-3 px-2.5 py-2.5",
          dark
            ? active
              ? "bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ring-1 ring-[#F97316]/30"
              : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
            : active
              ? "bg-white text-[#0F172A] shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-[#F4D9BE]"
              : "text-[#5A6678] hover:bg-white hover:text-[#0F172A] hover:shadow-[0_1px_2px_rgba(15,23,42,0.05)]",
        )}
        href={item.href}
        onClick={onActivate}
      >
        {active && <span className={cn("absolute left-0 w-[3px] bg-[#F97316]", rail ? "top-1.5 bottom-1.5" : "top-1.5 bottom-1.5")} />}
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center transition-colors duration-150",
            dark
              ? active
                ? "bg-[linear-gradient(180deg,#FB923C_0%,#F97316_100%)] text-white shadow-[0_8px_16px_rgba(249,115,22,0.32)]"
                : "bg-white/5 text-slate-400 ring-1 ring-white/10 group-hover:text-[#F8B56B] group-hover:ring-white/20"
              : active
                ? "bg-[#F97316] text-white shadow-[0_8px_16px_rgba(249,115,22,0.28)]"
                : "bg-white text-[#64748B] ring-1 ring-[#EBE4DA] group-hover:text-[#F97316] group-hover:ring-[#FDBA74]",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        {!rail && <span className="min-w-0 flex-1 truncate tracking-[-0.01em]">{item.label}</span>}
      </Link>
    </div>
  );
}

// ── The navigation brain (search / collapse / rail) ──────────────────────────
function SidebarNav({
  mode = "admin",
  onNavigate,
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
  rail = false,
  scrollable = true,
}: {
  currentRole?: PhoenixRole;
  mode?: NavigationMode;
  onNavigate?: () => void;
  permissionLookup?: PermissionLookup;
  rail?: boolean;
  // Desktop sidebar flows with the page (shows every item, no inner scroll); the
  // mobile drawer is a fixed-height overlay and keeps its own scroll.
  scrollable?: boolean;
}) {
  const isAdmin = mode === "admin";
  const sections = useMemo(() => getSections(mode, permissionLookup, currentRole), [currentRole, mode, permissionLookup]);
  const pathname = usePathname();
  const navInstanceId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<string | null>(pathname === "/payroll" ? "governance" : null);
  const [searchQuery, setSearchQuery] = useState("");
  const [railTip, setRailTip] = useState<{ label: string; top: number; left: number } | null>(null);

  const query = isAdmin && !rail ? searchQuery.trim().toLowerCase() : "";

  const activeHref = getActiveHref(pathname, sections, activeTab);

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);
  const activeSectionId = sections.find((section) => section.items.some((item) => item.href === activeHref))?.id ?? null;

  const collapsedKey = collapsedStorageKey(mode);
  const collapsedSnapshot = useSyncExternalStore(subscribeCollapsed, () => readCollapsedSnapshot(collapsedKey), () => "[]");
  const collapsedSectionIds = useMemo(() => {
    const next = parseCollapsedIds(collapsedSnapshot, new Set(sectionIds));
    if (activeSectionId) next.delete(activeSectionId);
    return next;
  }, [activeSectionId, collapsedSnapshot, sectionIds]);

  function toggleSection(sectionId: string) {
    const next = new Set(collapsedSectionIds);
    if (next.has(sectionId)) next.delete(sectionId);
    else next.add(sectionId);
    if (activeSectionId) next.delete(activeSectionId);
    writeCollapsedIds(collapsedKey, next);
  }

  function handleActivate(item: NavigationSectionItem) {
    if (item.href.includes("tab=generate")) setActiveTab("generate");
    else if (item.href.includes("tab=governance")) setActiveTab("governance");
    else if (item.href.includes("action=create-manager-expense")) setActiveTab("create-manager-expense");
    else setActiveTab(null);
    onNavigate?.();
  }

  const visibleSections = query
    ? sections
        .map((section) => ({ ...section, items: section.items.filter((item) => item.label.toLowerCase().includes(query)) }))
        .filter((section) => section.items.length > 0)
    : sections;

  // ── Collapsed icon-rail (admin only) ──────────────────────────────────────
  if (rail) {
    const railItems = sections.flatMap((section) => section.items);
    const showTip = (label: string) => (rect: DOMRect) =>
      setRailTip({ label, top: rect.top + rect.height / 2, left: rect.right + 12 });
    const hideTip = () => setRailTip(null);

    return (
      <>
        <nav className={cn("flex-1 px-2 py-4", scrollable && "overflow-auto")}>
          <div className="flex flex-col items-center gap-1.5">
            {railItems.map((item) => (
              <NavRow
                active={item.href === activeHref}
                dark
                item={item}
                key={`rail-${item.href}`}
                onActivate={() => handleActivate(item)}
                onHover={showTip(item.label)}
                onHoverEnd={hideTip}
                rail
              />
            ))}
          </div>
        </nav>
        {railTip && (
          <div
            className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap border border-white/10 bg-slate-900 px-2.5 py-1.5 text-[12px] font-semibold text-white shadow-[0_10px_28px_rgba(2,6,23,0.6)]"
            style={{ left: railTip.left, top: railTip.top }}
          >
            {railTip.label}
          </div>
        )}
      </>
    );
  }

  // ── Expanded sidebar ──────────────────────────────────────────────────────
  return (
    <>
      {isAdmin && (
        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              ref={searchInputRef}
              aria-label="Search modules"
              className="h-9 w-full border border-white/10 bg-white/5 pl-9 pr-8 text-[13px] font-semibold text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-[#FDBA74] focus:bg-white/[0.08] focus:ring-2 focus:ring-[#F97316]/25"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchQuery("");
                  event.currentTarget.blur();
                }
              }}
              placeholder={systemUiText.sidebarSearchPlaceholder}
              type="search"
              value={searchQuery}
            />
            {searchQuery && (
              <button
                aria-label="Clear search"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-slate-500 transition hover:text-[#F8B56B]"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <nav className={cn("flex-1 px-3 py-4", scrollable && "overflow-auto")}>
        {visibleSections.map((section, sectionIndex) => {
          const hasActive = section.items.some((item) => item.href === activeHref);
          const collapsed = !query && collapsedSectionIds.has(section.id) && !hasActive;
          const sectionContentId = `${navInstanceId}-${section.id}-items`;

          return (
            <Fragment key={section.id}>
              <div className={cn("px-1", sectionIndex > 0 && "mt-5")}>
                <button
                  aria-controls={sectionContentId}
                  aria-expanded={!collapsed}
                  className={cn(
                    "flex w-full items-center gap-2 border-t px-1.5 pt-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60 focus-visible:ring-offset-2",
                    isAdmin ? "border-white/10 focus-visible:ring-offset-slate-900" : "border-[#EAE1D4] focus-visible:ring-offset-white",
                  )}
                  onClick={() => toggleSection(section.id)}
                  type="button"
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-transform duration-300 ease-out",
                      isAdmin
                        ? hasActive
                          ? "text-[#F8B56B]"
                          : "text-slate-500"
                        : hasActive
                          ? "text-[#F97316]"
                          : "text-[#94A3B8]",
                      !collapsed && "rotate-90",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-[0.16em]",
                      isAdmin
                        ? hasActive
                          ? "text-[#F8B56B]"
                          : "text-slate-400"
                        : hasActive
                          ? "text-[#F97316]"
                          : "text-[#64748B]",
                    )}
                  >
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
                  <div className="mt-1.5 space-y-1 px-1">
                    {section.items.map((item) => (
                      <NavRow
                        active={item.href === activeHref}
                        dark={isAdmin}
                        item={item}
                        key={`${item.href}-${item.label}`}
                        onActivate={() => handleActivate(item)}
                        rail={false}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}

        {isAdmin && query && visibleSections.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center bg-[#F97316]/10 text-[#F97316] ring-1 ring-[#F97316]/25">
              <Search className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-slate-100">No modules match</p>
              <p className="mt-1 text-[11px] text-slate-500">Try a different search term.</p>
            </div>
          </div>
        )}
      </nav>
    </>
  );
}

// ── Brand / logo header ──────────────────────────────────────────────────────
function SidebarBrand({ mode = "admin", onNavigate, rail = false }: { mode?: NavigationMode; onNavigate?: () => void; rail?: boolean }) {
  const homePath = navigationHomePathByMode[mode];
  const isAdmin = mode === "admin";
  const subtitle = isAdmin ? `${systemIdentity.productName} · Admin` : systemUiText.sidebar.employeeLogoSubtitle;

  if (rail) {
    // Admin rail: the phoenix mark on the black chrome — no white background box.
    if (isAdmin) {
      return (
        <Link
          aria-label={`${systemIdentity.brandName} Admin`}
          className="mx-auto mt-3 flex h-12 w-12 items-center justify-center"
          href={homePath}
          onClick={onNavigate}
        >
          <Image alt={`${systemIdentity.brandName} Admin`} className="h-11 w-11 object-contain" height={44} src={systemAssets.adminRailMark} width={44} />
        </Link>
      );
    }
    return (
      <Link
        aria-label={`${systemIdentity.brandName} Portal`}
        className="mx-auto mt-3 flex h-12 w-12 items-center justify-center overflow-hidden border border-[#E7DECF] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:border-[#FDBA74]"
        href={homePath}
        onClick={onNavigate}
      >
        <Image alt={systemIdentity.brandName} className="h-7 w-7 object-contain" height={28} src={systemAssets.iconLogo} width={28} />
      </Link>
    );
  }

  // Admin: a single full lockup image (phoenix emblem + wordmark) on the black
  // chrome — replaces the icon + "PHOENIX / Workforce · Admin" text block.
  if (isAdmin) {
    return (
      <Link
        aria-label={`${systemIdentity.brandName} Admin`}
        className="mx-3 mt-3 block px-1 py-1.5"
        href={homePath}
        onClick={onNavigate}
      >
        <Image
          alt={`${systemIdentity.brandName} Admin`}
          className="h-auto w-full object-contain"
          height={841}
          priority
          src={systemAssets.adminSidebarLockup}
          width={1870}
        />
      </Link>
    );
  }

  return (
    <Link className="mx-3 mt-3 flex items-center gap-3 px-2 py-3" href={homePath} onClick={onNavigate}>
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center bg-white",
          isAdmin ? "ring-1 ring-white/15" : "shadow-[0_1px_3px_rgba(15,23,42,0.06)] ring-1 ring-[#EBE4DA]",
        )}
      >
        <Image
          alt={systemIdentity.brandName}
          className="h-8 w-8 object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.35)]"
          height={32}
          src={systemAssets.iconLogo}
          width={32}
        />
      </span>
      <div className="min-w-0">
        <p className={cn("whitespace-nowrap text-[15px] font-black tracking-[0.22em]", isAdmin ? "text-white" : "text-[#0F172A]")}>
          {systemIdentity.brandName.slice(0, -1).toUpperCase()}
          <span className="text-[#F97316]">{systemIdentity.brandName.slice(-1).toUpperCase()}</span>
        </p>
        <p className={cn("mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.22em]", isAdmin ? "text-slate-400" : "text-[#64748B]")}>
          {subtitle}
        </p>
      </div>
    </Link>
  );
}

// ── Employee-portal-only intro + footer ──────────────────────────────────────
function SidebarIntro({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") return null;
  return (
    <div className="mx-3 mt-3 border border-[#E2E8F0] bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#F97316]">{systemUiText.sidebar.employeePortalKicker}</p>
      <p className="mt-2 text-lg font-black tracking-[-0.03em] text-[#0F172A]">{systemUiText.sidebar.employeePortalTitle}</p>
      <p className="mt-2 text-sm leading-6 text-[#64748B]">{systemUiText.sidebar.employeePortalDescription}</p>
    </div>
  );
}

function SidebarFooter({ mode = "admin" }: { mode?: NavigationMode }) {
  if (mode === "admin") return null;
  return (
    <div className="p-3">
      <div className="overflow-hidden border border-[#E2E8F0] bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)] p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-[#F97316]/10 text-[#F97316]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F172A]">{systemUiText.sidebar.employeePortalFooterTitle}</p>
            <p className="mt-1 text-xs leading-5 text-[#64748B]">{systemUiText.sidebar.employeePortalFooterDescription}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function useSidebarRail(mode: NavigationMode) {
  const key = prefKey("rail", mode);
  const collapsed = useBooleanPref(key);
  const toggle = () => writePref(key, !collapsed);
  return [collapsed, toggle] as const;
}

// ── Desktop sidebar ──────────────────────────────────────────────────────────
export function Sidebar({
  navigationMode = "admin",
  permissionLookup = EMPTY_PERMISSION_LOOKUP,
  currentRole,
}: {
  currentRole?: PhoenixRole;
  navigationMode?: NavigationMode;
  permissionLookup?: PermissionLookup;
}) {
  const isAdmin = navigationMode === "admin";
  const [rail, toggleRail] = useSidebarRail(navigationMode);
  const railActive = isAdmin && rail;

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col transition-[width] duration-200 lg:flex",
        isAdmin
          ? cn("relative border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG)
          : "border-r border-[#E2E8F0] bg-white",
        railActive ? SIDEBAR_WIDTH_RAIL : SIDEBAR_WIDTH_EXPANDED,
      )}
    >
      {isAdmin && (
        <button
          aria-label={railActive ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={railActive}
          className="absolute -right-3 top-[86px] z-40 flex h-7 w-7 items-center justify-center rounded-full border border-[#333333] bg-[#111111] text-slate-300 shadow-[0_6px_16px_rgba(0,0,0,0.6)] transition hover:border-[#FDBA74] hover:text-[#F8B56B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/60"
          onClick={toggleRail}
          type="button"
        >
          {railActive ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      )}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <SidebarBrand mode={navigationMode} rail={railActive} />
        <SidebarIntro mode={navigationMode} />
        <SidebarNav currentRole={currentRole} mode={navigationMode} permissionLookup={permissionLookup} rail={railActive} scrollable={false} />
        <SidebarFooter mode={navigationMode} />
      </div>
    </aside>
  );
}

// ── Mobile drawer ────────────────────────────────────────────────────────────
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
  const isAdmin = navigationMode === "admin";

  return (
    <div
      aria-hidden={!open}
      className={cn("fixed inset-0 z-50 lg:hidden", open ? "pointer-events-auto" : "pointer-events-none")}
      inert={!open}
    >
      <button
        aria-label="Close menu"
        className={cn("absolute inset-0 bg-slate-950/55 backdrop-blur-sm transition-opacity", open ? "opacity-100" : "opacity-0")}
        onClick={onClose}
        type="button"
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex w-[min(90vw,320px)] flex-col shadow-2xl transition-transform duration-200",
          isAdmin ? cn("relative border-r text-slate-100", ADMIN_SIDEBAR_BORDER, ADMIN_SIDEBAR_BG) : "border-r border-[#E2E8F0] bg-white",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3">
            <SidebarBrand mode={navigationMode} onNavigate={onClose} />
            <button
              aria-label="Close menu"
              className={cn(
                "mr-3 mt-4 flex h-9 w-9 shrink-0 items-center justify-center transition",
                isAdmin
                  ? "bg-white/[0.06] text-slate-300 ring-1 ring-white/10 hover:text-[#F8B56B]"
                  : "bg-white text-[#64748B] ring-1 ring-[#EBE4DA] hover:bg-[#F1EBE1] hover:text-[#0F172A]",
              )}
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <SidebarIntro mode={navigationMode} />
          <SidebarNav currentRole={currentRole} mode={navigationMode} onNavigate={onClose} permissionLookup={permissionLookup} rail={false} />
          <SidebarFooter mode={navigationMode} />
        </div>
      </aside>
    </div>
  );
}
