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

export function getSections(
  sections: readonly NavigationSection[],
  mode: NavigationMode,
  lookup: PermissionLookup,
  role?: PhoenixRole,
  moduleIds?: ModuleIdLookup,
  isSystemAdministratorWorkspace = false,
): NavigationSection[] {
  const visible = isSystemAdministratorWorkspace
    ? sections.map((section) => ({ ...section, items: [...section.items] }))
    : sections
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) =>
              permissionAllowed(lookup, item.permissions) &&
              roleAllowed(role, item.roles) &&
              moduleIdAllowed(moduleIds, item) &&
              (mode === "admin" || roleNotExcluded(role, item.excludedRoles)),
          ),
        }))
        .filter((section) => section.items.length > 0);

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
