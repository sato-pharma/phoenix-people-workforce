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
import { isPageFencedForRole } from "@/lib/auth/seat-page-fences";

export type PermissionLookup = Partial<Record<`${PermissionResource}:${PermissionAction}`, boolean>>;
type PermissionLookupKey = keyof PermissionLookup;

// ── Shell chrome and URL prefix, by mode ─────────────────────────────────────
/**
 * Does this mode render the ADMIN chrome — dark rail, section headings, hub buttons, the admin
 * background, the collapsible sidebar?
 *
 * There are three modes and only two looks. `hr` (2026-08-28) is the admin shell served under its
 * own URL prefix, NOT a third design: the owner's standing rule is that a new surface matches the
 * design identity of its siblings rather than inventing a one-off look, and the HR seats are
 * admin-shell accounts by his decision. Every `mode === "admin"` test that was really asking "is
 * this the admin LOOK" now asks this instead; the one test that genuinely means "admin and not
 * HR" — the personal-layout store, which is keyed per person, not per mode — still compares the
 * mode directly.
 */
export function usesAdminChrome(mode: NavigationMode | undefined): boolean {
  return mode === "admin" || mode === "hr";
}

/**
 * Surfaces that carry the arrangeable horizontal nav rows.
 *
 * DELIBERATELY WIDER THAN `usesAdminChrome`, which is a PALETTE question. Keeping the two separate
 * is what stopped the portal rows inheriting the dark admin chrome while the portal had rows.
 *
 * THE PORTAL NO LONGER HAS ANY. Owner rule 2026-09-03 (PR #2994): nothing renders above a person's
 * own identity card, so `EmployeePortalChrome` dropped `HorizontalNavProvider` entirely along with
 * the header "+" that was its entry point — read the comment there before changing anything here,
 * and do NOT "restore parity" by putting them back. `AppShell` is the only surface that mounts the
 * rows, and every one of its call sites states `navigationMode="admin"`, so this predicate is not
 * reachable with `"employee-portal"` today.
 *
 * It still answers true for the portal on purpose. The value is not what makes the portal
 * row-less — the shell not mounting the provider is — and narrowing it here would move a live
 * decision out of the component that states it, into a predicate whose next reader has no way to
 * see why. It stays a question about which surfaces are ALLOWED rows.
 *
 * One stored layout document serves all three modes, and that is safe by construction rather than
 * by luck: each mode's sections carry disjoint href prefixes — `/admin/...`, `/hr/...`,
 * `/employee-portals/...` — so an href from one mode matches nothing in another mode's `byHref` map
 * and `applyPersonalLayout` simply drops it. The modes cannot collide.
 */
export function carriesNavRows(mode: NavigationMode | undefined): boolean {
  return usesAdminChrome(mode) || mode === "employee-portal";
}

/** The URL prefix every link in this mode is served under. Empty for admin and the portal. */
export function navigationPathPrefix(mode: NavigationMode | undefined): string {
  return mode === "hr" ? "/hr" : "";
}

/**
 * Bring a browser pathname into the form this mode's hrefs are authored in.
 *
 * `hrNavigationSections` authors real, prefixed hrefs (`/hr/probation`) so a sidebar click needs
 * no redirect. Active-row detection then has to compare against a prefixed pathname — and whether
 * `usePathname()` reports the browser path or the rewritten one after a middleware rewrite is a
 * Next.js implementation detail that has changed between releases. Normalising UP to the prefixed
 * form is correct under BOTH behaviours, so the sidebar never depends on which one is in force.
 */
export function normalizePathnameForMode(pathname: string, mode: NavigationMode | undefined): string {
  const prefix = navigationPathPrefix(mode);
  if (!prefix) return pathname;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return pathname;
  if (!pathname.startsWith("/")) return prefix;
  return pathname === "/" ? prefix : `${prefix}${pathname}`;
}

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

/**
 * Resolve an item's DISPLAYED label for `role` — the per-role override from `labelByRole` if one
 * is set for this role, else the item's own canonical `label`. The canonical label is what
 * canonical label alone, at config-build time (see `defaultModuleId` in system-navigation.ts), so
 * search and the command palette use, so a per-role override never fragments an item.
 */
function resolveItemLabel(item: NavigationSectionItem, role?: PhoenixRole): string {
  const override = role && item.labelByRole?.[role];
  return override ?? item.label;
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

/**
 * The three gate fields, structurally. Both `NavigationSectionItem` (sidebar rows) and
 * `AdminToolsPageItem` (hub cards) carry them, and both are gated by the same rule — which is
 * the whole point of `navigationItemVisible` below.
 */
export type GatedNavigationItem = {
  excludedRoles?: readonly PhoenixRole[];
  /** Read only for the per-seat page fences (src/lib/auth/seat-page-fences.ts). */
  href?: string;
  permissions?: readonly NavigationPermission[];
  roles?: readonly PhoenixRole[];
};

/** The role that holds every seat. Named once so the rule below is greppable. */
export const SYSTEM_ADMINISTRATOR_ROLE: PhoenixRole = "Super Admin";

/**
 * Is this item offered to this role? THE one place the answer lives.
 *
 * Three gates, and exactly one exception:
 *
 *   excludedRoles — never waived, for anybody. It says "this item is not FOR you", which is a
 *                   different claim from "you lack rights", and it is the only way to say it.
 *   permissions   — never waived. The role must hold the grant.
 *   roles         — waived for the system administrator.
 *
 * WHY the exception is stated here rather than in the config. Super Admin holds every seat, so a
 * `roles:` list is never the mechanism that keeps them out of a module — `excludedRoles` is.
 * Measured when this replaced the old bypass: 44 config entries across the three modes (7 admin,
 * 35 employee-portal, 2 hr) are visible to Super Admin only because this waiver exists, rendering
 * as 41 rail rows once dedupeSectionsByHref has run. The alternative was naming "Super Admin" in
 * all 44 `roles` arrays, and that regenerates the defect — every future entry with a `roles` list
 * has to remember, and the one that forgets fails silently and invisibly.
 *
 * This is TIGHTER than the `isSystemAdministratorWorkspace` bypass it replaces, deliberately.
 * That bypass skipped `permissions` as well, so a Super Admin sidebar row outlived the grant
 * behind it and the rail could contradict the server. Measured at the time of the change:
 * 0 of those 44 entries were permission-blocked, so nothing moved — but a grant removed tomorrow
 * now reaches the rail instead of being silently ignored there.
 *
 * `roles: []` still means NOBODY (roleAllowed distinguishes it from `undefined`). The one item
 * that used it — the delisted portal Sales Analytics, retired with its module on 2026-09-17 —
 * paired it with `excludedRoles: ["Super Admin"]`, so the waiver above could not resurface it.
 * A page delisted that way again needs both halves.
 */
export function navigationItemVisible(
  item: GatedNavigationItem,
  lookup: PermissionLookup,
  role?: PhoenixRole,
): boolean {
  if (!roleNotExcluded(role, item.excludedRoles)) return false;
  // A page the owner left out of a seat that one of its keys would otherwise open. AppShell refuses
  // the same address server-side; this keeps the row from being offered in the first place.
  if (item.href && isPageFencedForRole(role, item.href)) return false;
  if (!permissionAllowed(lookup, item.permissions)) return false;
  return role === SYSTEM_ADMINISTRATOR_ROLE || roleAllowed(role, item.roles);
}

// Some hrefs are intentionally listed in more than one section with mutually-exclusive
// role/excludedRoles gates (e.g. Organogram: CEO-only in Command Center, everyone-else
// in People Management) so exactly one copy is visible to any given role. That per-role gating
// is what normally leaves exactly one copy standing — and `navigationItemVisible` waives the
// `roles` half of it for the system administrator, so without this both copies would surface on
// their sidebar. Runs unconditionally: measured across all 17 roles x 3 modes, no other role
// renders a duplicate href, so for everyone else it is a no-op. Keeps each href's first
// (highest-tier) occurrence.
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
): NavigationSection[] {
  // One gating path for every role. The `isSystemAdministratorWorkspace` parameter that used to
  // select a second path is gone: the rule it encoded now lives inside navigationItemVisible,
  // where the 20 hub pages and the command palette read the same copy of it.
  const gated = dedupeSectionsByHref(
    sections
      // Section-level gates are ANDed with every row's own gate, and with each other. The promoted
      // hub bands use them to say "only if you could have opened this hub", which no single item
      // gate can express — see `NavigationSection.gate`. There is more than one when hubs nest
      // (Customers Database sits on the Master Data hub), and `every` is what makes the chain an
      // AND; a section without any, which is every section that is not a promoted hub, passes
      // straight through. Filtered BEFORE the item pass and before dedupe, so a band nobody can
      // reach never takes an href away from a section that is visible.
      .filter((section) => (section.gate ?? []).every((gate) => navigationItemVisible(gate, lookup, role)))
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => navigationItemVisible(item, lookup, role)),
      }))
      .filter((section) => section.items.length > 0),
  );

  // Per-role item label overrides (`labelByRole`), resolved once here so every downstream
  // consumer of getSections — sidebar, search and the command palette — agrees
  // on what this role calls the item. Applied to the already-gated set: an item hidden from a
  // role never needs its label resolved for that role.
  const relabelled = gated.map((section) => ({
    ...section,
    label: (role && section.labelByRole?.[role]) || section.label,
    items: section.items.map((item) =>
      item.labelByRole ? { ...item, label: resolveItemLabel(item, role) } : item,
    ),
  }));

  // Section headings are role-scoped (see flatSidebarRoles): the SFE Manager keeps the flat,
  // headless sidebar; every other role keeps its titles. Applied here — after gating, before
  // ordering — so all three return paths below are covered by one pass.
  const visible = usesFlatSidebar(role)
    ? relabelled.map((section) => ({ ...section, label: "" }))
    : relabelled;

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
