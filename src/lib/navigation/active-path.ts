// ─────────────────────────────────────────────────────────────────────────────
// Sidebar navigation logic — pure, React-free helpers.
//
// Extracted from sidebar.tsx so this logic can be unit-tested under the Node test
// harness (the component imports next/navigation at module scope, which cannot run
// in Node). These functions own:
//   • visibility gating (mirrors the server permission matrix), and
//   • active-route detection (driven by per-item `exact` / `activeTab` hints from
//     system-navigation, NOT hardcoded route literals).
// They take navigation sections as input rather than importing the config at
// runtime, keeping this module free of any heavy/runtime dependency.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  NavigationPermission,
  NavigationSection,
  NavigationSectionItem,
} from "@/config/system-navigation";
import type {
  NavigationMode,
  PermissionAction,
  PermissionResource,
  PhoenixRole,
} from "@/lib/auth/permissions";

export type PermissionLookup = Partial<Record<`${PermissionResource}:${PermissionAction}`, boolean>>;
type PermissionLookupKey = keyof PermissionLookup;
export type ModuleIdLookup = readonly string[] | null | undefined;

/**
 * Roles that keep the FLAT sidebar look built for the SFE Manager on 2026-08-02 (PR #1625):
 * no section headings, and hub buttons styled exactly like ordinary links.
 *
 * That rebuild was an SFE-only brief, but `NavigationSection.label` and the row styling are
 * shared with every admin role, so it flattened all of them. In the SFE session each affected
 * section resolved to exactly one button, so dropping the heading only removed a repeat of the
 * button beneath it. On Super Admin and CEO those same sections hold several rows, so it left
 * them as loose unlabelled buttons — and because the label doubles as the collapse/pin key,
 * those sections could no longer be collapsed either.
 *
 * Owner instruction 2026-08-08: leave the SFE Manager's sidebar exactly as it is, and give
 * Super Admin, CEO and every other admin role their headings and hub styling back.
 *
 * Lives here rather than in system-navigation so `getSections` can apply it without pulling that
 * config (and its lucide icon graph) into this deliberately dependency-free module.
 */
export const flatSidebarRoles: readonly PhoenixRole[] = ["SFE Manager"];

export function usesFlatSidebar(role?: PhoenixRole) {
  return Boolean(role && flatSidebarRoles.includes(role));
}

// ── Visibility gating (mirrors the server permission matrix) ─────────────────
export function permissionAllowed(
  lookup: PermissionLookup | undefined,
  permission?: NavigationPermission | readonly NavigationPermission[],
) {
  if (!permission) return true;
  const list: readonly NavigationPermission[] = Array.isArray(permission) ? permission : [permission];
  return list.some((entry) => {
    const action: PermissionAction = entry.action ?? "read";
    const key: PermissionLookupKey = `${entry.resource}:${action}`;
    if (!lookup || typeof lookup[key] === "undefined") return true;
    return Boolean(lookup[key]);
  });
}

export function roleAllowed(role: PhoenixRole | undefined, roles?: readonly PhoenixRole[]) {
  if (!roles) return true;
  return Boolean(role && roles.includes(role));
}

export function roleNotExcluded(role: PhoenixRole | undefined, excludedRoles?: readonly PhoenixRole[]) {
  if (!excludedRoles) return true;
  return !role || !excludedRoles.includes(role);
}

export function moduleIdAllowed(moduleIds: ModuleIdLookup, item: NavigationSectionItem) {
  if (!moduleIds) return true;
  return moduleIds.includes(item.moduleId);
}

// Some hrefs are intentionally listed in more than one section with mutually-exclusive
// role/excludedRoles gates (e.g. Organogram: CEO-only in Command Center, everyone-else
// in People Management) so exactly one copy is visible to any given role. The system
// administrator workspace bypasses that gating entirely so Super Admin can reach every
// item — which would otherwise surface both copies at once. Dedupe by href, keeping
// each href's first (highest-tier) occurrence.
function dedupeSectionsByHref(sections: readonly NavigationSection[]): NavigationSection[] {
  const seen = new Set<string>();
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (seen.has(item.href)) return false;
        seen.add(item.href);
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

export function getSections(
  sections: readonly NavigationSection[],
  mode: NavigationMode,
  lookup: PermissionLookup,
  role?: PhoenixRole,
  moduleIds?: ModuleIdLookup,
  isSystemAdministratorWorkspace = false,
): NavigationSection[] {
  // The system-administrator workspace bypasses permission/role gating so Super Admin can reach
  // every module — but `excludedRoles` is still honoured. It expresses "this item is not FOR you",
  // not "you lack rights": another role's personal command center is noise on a Super Admin's
  // sidebar, and the bypass silently overrode the one mechanism for saying so. No item excluded
  // Super Admin before this, so honouring it hides nothing that used to show.
  const gated = isSystemAdministratorWorkspace
    ? dedupeSectionsByHref(
        sections
          .map((section) => ({
            ...section,
            items: section.items.filter((item) => roleNotExcluded(role, item.excludedRoles)),
          }))
          .filter((section) => section.items.length > 0),
      )
    : sections
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) =>
              permissionAllowed(lookup, item.permissions) &&
              roleAllowed(role, item.roles) &&
              moduleIdAllowed(moduleIds, item) &&
              roleNotExcluded(role, item.excludedRoles),
          ),
        }))
        .filter((section) => section.items.length > 0);

  // Section headings are role-scoped (see flatSidebarRoles): the SFE Manager keeps the flat,
  // headless sidebar; every other role keeps its titles. Applied here — after gating, before
  // ordering — so all three return paths below are covered by one pass.
  const visible = usesFlatSidebar(role)
    ? gated.map((section) => ({ ...section, label: "" }))
    : gated;

  // When an explicit, ordered module list is supplied (a Modules Control assignment
  // for this user/role/position/line), honor that order so admins can curate BOTH
  // which items appear AND the sequence — items within a section, and the sections
  // themselves (a section sorts by its earliest-ranked item). Without an assignment
  // (moduleIds null/empty) the natural config order is preserved for everyone else.
  if (isSystemAdministratorWorkspace) {
    return visible.filter((section) => section.items.length > 0);
  }

  if (Array.isArray(moduleIds) && moduleIds.length > 0) {
    const orderRank = new Map(moduleIds.map((moduleId, index) => [moduleId, index] as const));
    const rankOf = (item: NavigationSectionItem) =>
      orderRank.get(item.moduleId) ?? Number.MAX_SAFE_INTEGER;
    return visible
      .map((section) => ({
        ...section,
        items: [...section.items].sort((left, right) => rankOf(left) - rankOf(right)),
      }))
      .sort(
        (left, right) =>
          Math.min(...left.items.map(rankOf)) - Math.min(...right.items.map(rankOf)),
      );
  }

  return visible;
}

// ── Active-route detection (data-driven via item.exact / item.activeTab) ─────
export function isActivePath(pathname: string, item: NavigationSectionItem, activeTab: string | null) {
  const baseHref = item.href.split("?")[0];
  // Two items can share a path but differ by ?tab=/?action=; the active tab decides.
  if (item.activeTab) return pathname === baseHref && activeTab === item.activeTab;
  // Exact items never stay active on their child routes (e.g. /sales vs /sales/import).
  if (item.exact) return pathname === baseHref;
  return pathname === baseHref || pathname.startsWith(`${baseHref}/`);
}

export function getActiveHref(
  pathname: string,
  sections: readonly NavigationSection[],
  activeTab: string | null,
) {
  const matches = sections
    .flatMap((section) => section.items)
    .filter((item) => isActivePath(pathname, item, activeTab))
    .sort((left, right) => right.href.split("?")[0].length - left.href.split("?")[0].length);
  return matches[0]?.href ?? null;
}

/**
 * The ONE active nav row for a path, resolved from a bare href list: the DEEPEST match wins.
 *
 * The employee-portal sidebar builds its own sections (buildEmployeePortalSections in
 * employee-portal-layout.tsx) rather than NavigationSection, so it cannot use getActiveHref above —
 * but it needs the identical longest-match rule. Without it a plain prefix test lights every
 * ancestor too: /employee-portals/direct-orders/report highlighted "Direct Orders Report" AND its
 * parent "Direct Orders" at once. The portal's previous guard was a hand-kept list of parent hrefs
 * pinned to exact-match, and /direct-orders was simply never added to it.
 *
 * `exactOnlyHrefs` covers hub roots that must not stay lit on a child route even when nothing
 * deeper matches — the portal root is one, because destinations like /employee-portals/profile have
 * no sidebar row of their own and would otherwise leave "Command Center" lit.
 *
 * A route with no row of its own still lights its nearest ancestor, which is what detail pages want.
 */
export function resolveDeepestActiveHref(
  pathname: string,
  hrefs: readonly string[],
  exactOnlyHrefs: ReadonlySet<string> = new Set<string>(),
): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const hrefPath = href.split("#")[0].split("?")[0];
    const matches = exactOnlyHrefs.has(hrefPath)
      ? pathname === hrefPath
      : pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
    if (!matches) continue;
    if (best === null || hrefPath.length > best.length) best = hrefPath;
  }
  return best;
}
