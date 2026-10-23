import { getNavigationSections, type NavigationSection, type NavigationSectionItem } from "@/config/system-navigation";
import { hrNamespaceRoles, phoenixRoles, type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";
import { EMPLOYEE_PORTAL_EXACT_ONLY_HREFS, EMPLOYEE_PORTAL_SIDEBAR_ROWS } from "@/lib/employee-portal/sidebar-rows";
import { getActiveHref, getSections, normalizePathnameForMode, resolveDeepestActiveHref } from "@/lib/navigation/active-path";
import { humanizeSegment, sidebarRowLabel } from "@/lib/navigation/module-title";
import { hrNamespaceRemainder, isHrRewritablePath } from "@/lib/navigation/shell-headers";
import { resolveApiPage, type ApiPageTargets } from "@/lib/system-audit/api-page-map";
import { isAddress, pathOnly, routeFamily } from "@/lib/system-audit/signature";
import { NOT_IN_SIDEBAR_PREFIX, type ModuleLabelSource, type ShellKind } from "@/lib/system-audit/types";

/**
 * Column 3 — the sidebar module a person was in when an error reached them, in the words THEIR
 * sidebar used.
 *
 * The stored `module_label` is never trusted: it came from `resolveActivityModule`, which knows a
 * coarse module list and wrote "Other", "Api" or "AI" on 38% of production rows. The label is
 * re-derived from the address instead, through the same rules the rail lights its rows with:
 *
 *   nav_exact   the address IS a row's address.
 *   nav_parent  the deepest row above it — a detail page under its list, the way the rail lights it.
 *   page_trail  an API request, named by the page the person last opened (the caller passes it).
 *   api_map     an API request with no trail, named by the page that calls that API (api-page-map.ts).
 *   none        nothing names it: `Not in sidebar — <the address in words>`. Never a guessed module.
 *
 * WHICH SIDEBAR. `/employee-portals…` is the portal rail; `/hr…` the HR seats' rail; an HR seat on a
 * bare address is the HR rail too, because the server may log the address AFTER proxy.ts rewrote
 * `/hr/probation` onto `/probation`; everything else is the admin rail. A row shared by two roles
 * under different wording (My vs Team Coaching Reports) resolves to the role's own wording.
 */

export type SidebarLabelInput = {
  /** `app_error_events.route` — a pathname, or a job name on a structured-log row. */
  route: string | null | undefined;
  role?: string | null;
  /** The person's last page view before an API error, when the caller found one. */
  recentPageRoute?: string | null;
  /** `app_error_events.route_type`; `structured-log` marks a background job. */
  routeType?: string | null;
};

export type SidebarLabel = {
  label: string;
  source: ModuleLabelSource;
  shell: ShellKind | null;
  /** The sidebar row's own href when one matched — the evidence behind the label. */
  href: string | null;
};

const PORTAL_PREFIX = "/employee-portals";
const SHELL_ROOTS = new Set(["/", "/hr", "/admin", PORTAL_PREFIX]);
const ROLE_SET = new Set<string>(phoenixRoles);

function asRole(role: string | null | undefined): PhoenixRole | undefined {
  const trimmed = String(role ?? "").trim();
  return ROLE_SET.has(trimmed) ? (trimmed as PhoenixRole) : undefined;
}

/** Which rail a role lives in, when the address alone does not say. */
export function shellForRole(role: string | null | undefined): ShellKind | null {
  const known = asRole(role);
  if (!known) return null;
  if (hrNamespaceRoles.has(known)) return "hr";
  if (isPortalShellRole(known)) return "portal";
  return "admin";
}

function isPortalPath(path: string): boolean {
  return path === PORTAL_PREFIX || path.startsWith(`${PORTAL_PREFIX}/`);
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** In the `/hr` namespace — tested through the remainder helper, never the broad namespace check. */
function inHrNamespace(path: string): boolean {
  return hrNamespaceRemainder(path) !== path || path === "/hr";
}

function basePath(href: string): string {
  return href.split("#")[0].split("?")[0];
}

/** `/employee-portals/employee-360/[id]` → `Employee 360`; `/api/cron/notify-daily` → `Cron › Notify Daily`. */
export function humaniseAddress(path: string): string {
  const family = routeFamily(path) ?? path;
  const words = family
    .split("/")
    .filter((segment) => segment && segment !== "[id]" && segment !== "[token]")
    .filter((segment, index) => !(index === 0 && (segment === "employee-portals" || segment === "admin" || segment === "api")))
    .map((segment) => humanizeSegment(segment))
    .filter(Boolean);
  return words.length > 0 ? words.join(" › ") : "Home";
}

function notInSidebar(text: string, shell: ShellKind | null): SidebarLabel {
  return { label: `${NOT_IN_SIDEBAR_PREFIX}${text}`, source: "none", shell, href: null };
}

/**
 * The deepest row of an admin-chrome rail (admin or /hr) that owns `path`, then the role's label
 * for it. When no row matches by the rail's own rule — an `exact` row does not light its children —
 * the nearest ancestor address that IS a row's address names it, so a page under a list with no row
 * of its own still reads as that list.
 */
function matchRows(path: string, mode: NavigationMode, role: PhoenixRole | undefined, sections: readonly NavigationSection[]): SidebarLabel | null {
  const shell: ShellKind = mode === "hr" ? "hr" : "admin";
  const active = getActiveHref(path, sections, null);
  if (active) {
    const label = sidebarRowLabel(active, mode, role);
    if (label) return { label, source: basePath(active) === path ? "nav_exact" : "nav_parent", shell, href: active };
  }

  const items: NavigationSectionItem[] = sections.flatMap((section) => [...section.items]);
  for (let ancestor = path.slice(0, path.lastIndexOf("/")); ancestor && !SHELL_ROOTS.has(ancestor); ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"))) {
    const owners = items.filter((item) => basePath(item.href) === ancestor && !item.activeTab);
    const row = owners.find((item) => item.href === ancestor) ?? owners[0];
    if (!row) continue;
    const label = sidebarRowLabel(row.href, mode, role);
    if (label) return { label, source: "nav_parent", shell, href: row.href };
  }
  return null;
}

/**
 * The person's OWN rail first — the rows `getSections` offers their role, which is what lit up
 * beside them — so a deeper row their seat never shows cannot name the page. Only when nothing
 * there owns the address does the whole rail answer (a row they held by a permission that day).
 */
function matchAdminRail(path: string, mode: NavigationMode, role: PhoenixRole | undefined): SidebarLabel | null {
  const all = getNavigationSections(mode);
  if (role) {
    const own = matchRows(path, mode, role, getSections(all, mode, {}, role));
    if (own) return own;
  }
  return matchRows(path, mode, role, all);
}

function matchPortalRail(path: string): SidebarLabel | null {
  const active = resolveDeepestActiveHref(
    path,
    EMPLOYEE_PORTAL_SIDEBAR_ROWS.map((row) => row.href),
    EMPLOYEE_PORTAL_EXACT_ONLY_HREFS,
  );
  if (!active) return null;
  const row = EMPLOYEE_PORTAL_SIDEBAR_ROWS.find((candidate) => candidate.href === active);
  if (!row) return null;
  return { label: row.label, source: active === path ? "nav_exact" : "nav_parent", shell: "portal", href: row.href };
}

/** A page address (never an API one) → its row, or null with no label invented. */
function resolvePagePath(path: string, role: PhoenixRole | undefined): SidebarLabel | null {
  if (isPortalPath(path)) return matchPortalRail(path);
  if (inHrNamespace(path)) {
    // `/hr/api/**` is not rewritten by the proxy, so nothing serves it and no row can own it.
    return isHrRewritablePath(path) ? matchAdminRail(path, "hr", role) : null;
  }
  if (role && hrNamespaceRoles.has(role)) {
    // The server may have logged the rewritten address; the person was on the /hr spelling.
    return matchAdminRail(normalizePathnameForMode(path, "hr"), "hr", role);
  }
  return matchAdminRail(path, "admin", role);
}

/** The shell a page address belongs to, for a label nothing matched. */
function shellOfPage(path: string, role: PhoenixRole | undefined): ShellKind | null {
  if (isPortalPath(path)) return "portal";
  if (inHrNamespace(path)) return "hr";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  return shellForRole(role);
}

/**
 * The page an API's map entry names for this person's rail. A portal seat is never offered an
 * admin page (their sidebar has none); an HR seat falls back to the admin page's `/hr` spelling;
 * an admin seat to whatever page exists.
 */
function targetFor(targets: ApiPageTargets, shell: ShellKind | null): string | null {
  if (shell === "portal") return targets.portal ?? null;
  if (shell === "hr") return targets.hr ?? targets.admin ?? null;
  return targets.admin ?? targets.hr ?? targets.portal ?? null;
}

function resolveApiPath(path: string, role: PhoenixRole | undefined, recentPageRoute: string | null | undefined): SidebarLabel {
  const trail = isAddress(recentPageRoute) ? pathOnly(recentPageRoute) : null;
  if (trail && !isApiPath(trail)) {
    const page = resolvePagePath(trail, role);
    if (page) return { ...page, source: "page_trail" };
  }

  const resolution = resolveApiPage(path);
  if (resolution?.kind === "no_ui") {
    const rest = path.slice(resolution.prefix.length);
    const detail = rest && rest !== "/" ? humaniseAddress(rest) : "";
    return notInSidebar(detail && detail !== "Home" ? `${resolution.reason} (${detail})` : resolution.reason, null);
  }
  if (resolution?.kind === "page") {
    const target = targetFor(resolution.targets, shellForRole(role));
    if (target) {
      const page = resolvePagePath(target, role);
      if (page) return { ...page, source: "api_map" };
    }
  }
  return notInSidebar(`API ${humaniseAddress(path)}`, shellForRole(role));
}

export function resolveSidebarLabel(input: SidebarLabelInput): SidebarLabel {
  const role = asRole(input.role);
  const raw = String(input.route ?? "").trim();

  if (!raw) {
    return input.routeType === "structured-log"
      ? { label: "Background job — no name recorded", source: "none", shell: null, href: null }
      : notInSidebar("no address recorded", shellForRole(role));
  }
  // A structured-log row's route is the job or event name the call site gave, not an address.
  if (!isAddress(raw)) return { label: `Background job — ${raw}`, source: "none", shell: null, href: null };

  const path = pathOnly(raw) ?? "/";
  if (isApiPath(path)) return resolveApiPath(path, role, input.recentPageRoute);
  return resolvePagePath(path, role) ?? notInSidebar(humaniseAddress(path), shellOfPage(path, role));
}
