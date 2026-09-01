import type { LucideIcon } from "lucide-react";

import { getNavigationSections, hubPageItemGroups } from "@/config/system-navigation";
import type { NavigationMode, PhoenixRole } from "@/lib/auth/permissions";
import { getSections, navigationItemVisible, type PermissionLookup } from "@/lib/navigation/active-path";

export type CommandPaletteItem = { href: string; icon: LucideIcon; label: string; section: string };

/**
 * Every destination Cmd/Ctrl+K offers this viewer, in rail-first order, **one row per href**.
 *
 * Two lists feed it. The sidebar is the obvious one. The second exists because the rail collapses
 * most admin sections into a single hub button, so a palette built only from the rail would surface
 * hub buttons and hide every module behind them — `hubPageItemGroups` folds each hub's own cards
 * back in, gated by exactly the same `navigationItemVisible` the hub page itself applies.
 *
 * WHY the dedupe runs across BOTH lists with one shared `seen` set. Some hrefs are deliberately
 * listed twice with mutually-exclusive role gates — `/leave-management/vacation-report` sits in the
 * Leave Management group for HR and again in the Finance Manager one; `/admin/notification-
 * confidence` sits in both Admin Tools and Access & Communication. Per-role gating normally leaves
 * exactly one copy standing, but `navigationItemVisible` waives the `roles` gate for the system
 * administrator (and the notification-confidence pair is Super Admin on BOTH sides regardless), so
 * both copies reach the palette. That rendered the same row twice and, because the React key was
 * `href-label` and both halves agree on both, tripped "two children with the same key" on every
 * admin page load. `getSections` already runs `dedupeSectionsByHref` over the rail for this exact
 * reason; the hub fold-in had no equivalent. Keeps each href's first (highest-tier) occurrence.
 */
export function buildCommandPaletteItems(
  navigationMode: NavigationMode,
  permissionLookup: PermissionLookup,
  currentRole?: PhoenixRole,
): CommandPaletteItem[] {
  const sidebarItems = getSections(
    getNavigationSections(navigationMode),
    navigationMode,
    permissionLookup,
    currentRole,
  ).flatMap((section) =>
    section.items.map((item) => ({ href: item.href, icon: item.icon, label: item.label, section: section.label })),
  );

  const hubItems: CommandPaletteItem[] =
    navigationMode === "admin"
      ? hubPageItemGroups.flatMap((group) =>
          group.items
            .filter((item) => navigationItemVisible(item, permissionLookup, currentRole))
            .map((item) => ({ href: item.href, icon: item.icon, label: item.label, section: group.label })),
        )
      : [];

  const seenHrefs = new Set<string>();
  return [...sidebarItems, ...hubItems].filter((item) => {
    if (seenHrefs.has(item.href)) return false;
    seenHrefs.add(item.href);
    return true;
  });
}
