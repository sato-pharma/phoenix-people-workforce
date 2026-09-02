/**
 * The pages that exist but are NOT in the sidebar — every hub's own card list, gated for one
 * viewer and shaped like a sidebar section.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * Most admin modules were collapsed into a single hub button: the sidebar shows "People
 * Management", and the twelve pages it leads to live as cards on that hub page instead of as rows
 * in the rail. That is deliberate and stays — the rail would be unreadable otherwise.
 *
 * The cost is that anything built from the SIDEBAR sees the hub button and none of the pages behind
 * it. Cmd+K hit this first and solved it locally, inside command-palette.tsx. The nav row's "+"
 * then hit exactly the same wall: the owner opened it, found "some pages are compacted and not
 * appearing", and asked for every page to be addable.
 *
 * Two copies of that fold is the shape of defect this repo has shipped before, so it is ONE
 * function with two callers. The rule it encodes is worth stating plainly: **a page findable by
 * Cmd+K is a page addable to a row.** Those two sets are now the same set by construction rather
 * than by two lists agreeing.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 * It does not widen the sidebar. `applyPersonalLayout` appends leftovers by walking the GATED
 * SECTIONS, so these items are handed to it as a separate zone-only pool: a hub card can be placed
 * in a row because the viewer put it there, and can never appear in the rail on its own.
 *
 * It introduces no href and grants no access. Every item is filtered through
 * `navigationItemVisible` — the same gate the hub page itself applies to the same card — so this
 * can only ever return a subset of what the viewer already reaches. The route handler's
 * `assertPermission` remains the only security boundary; this is a findability helper.
 */

import {
  hubPageItemGroups,
  type NavigationSection,
  type NavigationSectionItem,
} from "@/config/system-navigation";
import { type NavigationMode, type PhoenixRole } from "@/lib/auth/permissions";
import { navigationItemVisible, type PermissionLookup } from "@/lib/navigation/active-path";

/** Stable, collision-free section id for a hub group, derived from its label. */
function hubSectionId(label: string): string {
  return `hub:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * Every hub card this viewer may reach, grouped under its hub's own name, MINUS anything already
 * present in `sidebarSections`.
 *
 * `hubPageItemGroups` names two groups "Leave Management" (the standard list and the finance one),
 * and a picker keyed by section id cannot render two sections with the same key. They are merged
 * into one section by label, which is also what a reader wants: one heading per module.
 *
 * Admin only. `hubPageItemGroups` is the admin catalogue; the HR rail is not collapsed this way,
 * and the employee portal builds its navigation from its own registry.
 */
export function getHubCardSections(
  mode: NavigationMode,
  lookup: PermissionLookup,
  role: PhoenixRole | undefined,
  sidebarSections: readonly NavigationSection[],
): NavigationSection[] {
  if (mode !== "admin") return [];

  // Deduped against the sidebar so a page holding BOTH a rail row and a hub card is offered once,
  // and offered as the rail knows it.
  const seen = new Set<string>();
  for (const section of sidebarSections) {
    for (const item of section.items) seen.add(item.href);
  }

  const byLabel = new Map<string, NavigationSectionItem[]>();
  for (const group of hubPageItemGroups) {
    for (const item of group.items) {
      if (seen.has(item.href)) continue;
      if (!navigationItemVisible(item, lookup, role)) continue;
      seen.add(item.href);
      const bucket = byLabel.get(group.label);
      if (bucket) bucket.push(item);
      else byLabel.set(group.label, [item]);
    }
  }

  return Array.from(byLabel.entries()).map(([label, items]) => ({
    id: hubSectionId(label),
    items,
    label,
  }));
}

/**
 * The rail's sections and the hub's, as ONE list with same-named sections merged.
 *
 * Needed because a hub group almost always shares its name with the rail row that opens it —
 * "Master Data" the button, "Master Data" the twelve cards behind it. Concatenating the two lists
 * put 9 duplicated headings in the "+" panel on the first run of this change, which reads as a bug
 * rather than as depth. Merged, each module is one heading: the hub button first, then its pages.
 *
 * Rail order is preserved and rail items come first within a merged section, because the rail's
 * ordering is the deliberate one and its item is the one carrying that section's badge. Hub groups
 * with no rail counterpart keep their own heading, appended in catalogue order.
 */
export function mergeCatalogueSections(
  railSections: readonly NavigationSection[],
  hubSections: readonly NavigationSection[],
): NavigationSection[] {
  // `NavigationSection.items` is readonly, so the accumulator carries a mutable copy and the
  // readonly shape is restored on the way out.
  type Draft = { id: string; label: string; items: NavigationSectionItem[] };

  const merged: Draft[] = railSections.map((section) => ({
    id: section.id,
    items: [...section.items],
    label: section.label,
  }));
  const byLabel = new Map(merged.map((section) => [section.label, section]));

  for (const hub of hubSections) {
    const home = byLabel.get(hub.label);
    if (home) {
      home.items.push(...hub.items);
      continue;
    }
    const added: Draft = { id: hub.id, items: [...hub.items], label: hub.label };
    merged.push(added);
    byLabel.set(added.label, added);
  }

  return merged;
}

/** The same set, flattened — what `applyPersonalLayout` takes as its zone-only pool. */
export function getHubCardItems(
  mode: NavigationMode,
  lookup: PermissionLookup,
  role: PhoenixRole | undefined,
  sidebarSections: readonly NavigationSection[],
): NavigationSectionItem[] {
  return getHubCardSections(mode, lookup, role, sidebarSections).flatMap((section) => section.items);
}
