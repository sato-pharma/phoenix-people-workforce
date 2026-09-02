import type { LucideIcon } from "lucide-react";

import { getNavigationSections } from "@/config/system-navigation";
import type { NavigationMode, PhoenixRole } from "@/lib/auth/permissions";
import { getSections, type PermissionLookup } from "@/lib/navigation/active-path";
import { getHubCardSections } from "@/lib/navigation/hub-card-sections";

export type CommandPaletteItem = { href: string; icon: LucideIcon; label: string; section: string };

/**
 * Addresses that are the SAME SCREEN, collapsed to one palette row.
 *
 * `/admin/marketing-requests` and `/workspace/marketing-requests` both render
 * `MarketingRequestDraftWorkspace`, under the same heading, with the same blurb. Only the shell
 * and the gate differ: the admin one is behind `assertMarketingAdminPageAccess` (it bounces the
 * Finance Manager), the workspace one is behind `workspaceMarketingRoles` (it admits him). Super
 * Admin and the SFE Manager are the only two who are offered both — measured, all 17 roles — and
 * for them the palette showed one screen twice under one name.
 *
 * A rename was the obvious fix and is the wrong one: there is no difference to name. The
 * company-wide register is a THIRD route, `/admin/marketing-requests/all`, already called "All
 * Marketing Requests", so nothing here is the register.
 *
 * SCOPE: the palette only. The hub CARD stays on the hub page — it is a District Manager's only
 * link to the workspace (he is not on the sidebar row), and this map never removes the last row
 * for a destination: it dedupes on the canonical key while each row keeps its OWN href. Grants
 * nothing, gates nothing — both addresses enforce their own access exactly as before.
 */
const SAME_SCREEN_ALIASES: Readonly<Record<string, string>> = {
  "/admin/marketing-requests": "/workspace/marketing-requests",
};

/** The href two aliased addresses share, so a dedupe can treat them as one destination. */
function destinationKey(href: string): string {
  return SAME_SCREEN_ALIASES[href] ?? href;
}

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
 *
 * ── 2026-09-02, second pass ──────────────────────────────────────────────────
 * The fold itself now lives in `getHubCardSections`, because the nav row's "+" hit this identical
 * wall the same day — the owner opened it and found "some pages are compacted and not appearing.
 * I want all pages to appear." Two sessions wrote the same shared-`seen` dedupe within hours of
 * each other, which is exactly the duplicate-list defect this repo keeps paying for, so there is
 * now ONE fold with two callers.
 *
 * `getHubCardSections` applies the same rule stated above: one `seen` set seeded with every sidebar
 * href, then across the hub groups in order, keeping each href's first occurrence. So the behaviour
 * the tests below pin is unchanged — the dedupe MOVED, it did not weaken. The belt-and-braces
 * filter at the end is kept regardless, because "one row per href" is the property that matters
 * here and it should hold whatever feeds it.
 *
 * The rule worth remembering: a page findable by Cmd+K is a page addable to a nav row.
 */
export function buildCommandPaletteItems(
  navigationMode: NavigationMode,
  permissionLookup: PermissionLookup,
  currentRole?: PhoenixRole,
): CommandPaletteItem[] {
  const gatedSections = getSections(
    getNavigationSections(navigationMode),
    navigationMode,
    permissionLookup,
    currentRole,
  );
  const sidebarItems = gatedSections.flatMap((section) =>
    section.items.map((item) => ({ href: item.href, icon: item.icon, label: item.label, section: section.label })),
  );

  const hubItems: CommandPaletteItem[] = getHubCardSections(
    navigationMode,
    permissionLookup,
    currentRole,
    gatedSections,
  ).flatMap((section) =>
    section.items.map((item) => ({
      href: item.href,
      icon: item.icon,
      label: item.label,
      section: section.label,
    })),
  );

  const seen = new Set<string>();
  return [...sidebarItems, ...hubItems].filter((item) => {
    const key = destinationKey(item.href);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
