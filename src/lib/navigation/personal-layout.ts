import type { NavigationSection, NavigationSectionItem } from "@/config/system-navigation";

/**
 * Personal navigation layout — the owner rearranging HIS OWN sidebar.
 *
 * This is deliberately NOT the retired Modules Control model. That one keyed on
 * `target_type in ('user','role','position','line')` — a targeting matrix deciding what OTHER
 * people see — and could only reorder or disable whole modules by `module_id`. The owner's actual
 * ask (2026-08-28, verbatim: "I don't mean in anyone account. I mean in my own account") is one
 * target and finer granularity: move any PAGE into any module, or up into the utility strip.
 *
 * ── The one invariant that makes this safe ──────────────────────────────────────────────────
 * A layout REARRANGES the already-gated set. It can never introduce an href, so it can never
 * grant access. `applyPersonalLayout` runs strictly AFTER `getSections` has done permission and
 * role filtering, and every href it emits must have been present in that input. Navigation was
 * never the security boundary here (CLAUDE.md) and this does not make it one — the route handler's
 * `assertPermission` is still the only thing that matters.
 *
 * ── Why unknown hrefs fall back instead of being dropped ────────────────────────────────────
 * A stored layout is a snapshot of the nav as it was the day it was saved. Pages get added
 * constantly (~30 commits/day). If a saved layout were treated as the complete list, every new
 * page would be invisible to the one account that most needs to see it, with no error — the exact
 * silent-degradation shape that made the outbox drain sit dead for 13 days. So anything in the
 * gated input that the layout does not mention is APPENDED to its original section. New work
 * always shows up; the owner can then place it deliberately.
 */

export const PERSONAL_LAYOUT_VERSION = 1 as const;

/**
 * The storage key for a person's layout: their hr_id, lowercased and trimmed. Null when there is no
 * usable identity to key on.
 *
 * Lives in this dependency-free module rather than beside the database calls so it can be tested
 * without loading a Supabase client. It exists at all because hr_id casing is genuinely
 * inconsistent here — `activity_events.hr_id` is mixed case, the direct-order tables carry both
 * spellings, and a plain `.eq()` on the raw value once hid 28% of reps' own orders. The table
 * CHECKs that stored keys are lowercase; this is the other half of that guarantee.
 */
export function layoutKeyFor(hrId: string | null | undefined): string | null {
  const key = String(hrId ?? "").trim().toLowerCase();
  return key.length > 0 ? key : null;
}

/** A section in a saved layout. `label` is the owner's own name for it; `id` ties back to the
 *  code-defined section so a renamed section still matches its default when the layout is reset. */
export type PersonalLayoutSection = {
  id: string;
  label: string;
  /** Ordered hrefs. An href listed here is pulled OUT of whatever section defined it. */
  items: readonly string[];
};

export type PersonalNavigationLayout = {
  version: typeof PERSONAL_LAYOUT_VERSION;
  /** Layer 1 — the utility strip. Owner's ruling 2026-08-28: Approvals + Organogram only. */
  strip: readonly string[];
  /** Layer 2 + 3 — modules and the pages inside them. */
  sections: readonly PersonalLayoutSection[];
  /** Hrefs the owner chose to hide. Hiding is cosmetic and personal; it revokes nothing. */
  hidden: readonly string[];
};

export type AppliedNavigation = {
  /** Items promoted to the utility strip, in the owner's order. */
  strip: readonly NavigationSectionItem[];
  /** The sidebar, after rearrangement. */
  sections: readonly NavigationSection[];
};

export function isPersonalNavigationLayout(value: unknown): value is PersonalNavigationLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersonalNavigationLayout>;
  if (candidate.version !== PERSONAL_LAYOUT_VERSION) return false;
  if (!Array.isArray(candidate.strip) || !candidate.strip.every((h) => typeof h === "string")) return false;
  if (!Array.isArray(candidate.hidden) || !candidate.hidden.every((h) => typeof h === "string")) return false;
  if (!Array.isArray(candidate.sections)) return false;
  return candidate.sections.every(
    (section) =>
      section &&
      typeof section === "object" &&
      typeof (section as PersonalLayoutSection).id === "string" &&
      typeof (section as PersonalLayoutSection).label === "string" &&
      Array.isArray((section as PersonalLayoutSection).items) &&
      (section as PersonalLayoutSection).items.every((h) => typeof h === "string"),
  );
}

/** The layout the owner sees before he has saved one — i.e. exactly what the code defines today. */
export function defaultLayoutFrom(sections: readonly NavigationSection[]): PersonalNavigationLayout {
  return {
    version: PERSONAL_LAYOUT_VERSION,
    strip: [],
    sections: sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map((item) => item.href),
    })),
    hidden: [],
  };
}

/**
 * Rearrange `gatedSections` according to `layout`.
 *
 * `gatedSections` MUST be the output of `getSections` — already permission- and role-filtered.
 * Passing raw config here would still not grant anything (every emitted href comes from the
 * input), but the result would show pages the viewer cannot open.
 */
export function applyPersonalLayout(
  gatedSections: readonly NavigationSection[],
  layout: PersonalNavigationLayout | null,
): AppliedNavigation {
  if (!layout) {
    return { strip: [], sections: gatedSections };
  }

  // Index the gated set by href. This map is the ONLY source of items below — which is what makes
  // it impossible for a layout to conjure a page the viewer was not already allowed to see.
  const byHref = new Map<string, NavigationSectionItem>();
  const sectionOfHref = new Map<string, string>();
  for (const section of gatedSections) {
    for (const item of section.items) {
      if (!byHref.has(item.href)) {
        byHref.set(item.href, item);
        sectionOfHref.set(item.href, section.id);
      }
    }
  }

  const hidden = new Set(layout.hidden);
  // Tracks every href the layout has already placed, so nothing renders twice when a stale layout
  // names the same page in two sections.
  const placed = new Set<string>();

  const take = (href: string): NavigationSectionItem | null => {
    if (placed.has(href) || hidden.has(href)) return null;
    const item = byHref.get(href);
    if (!item) return null; // gone from the nav, or not permitted for this viewer
    placed.add(href);
    return item;
  };

  const strip = layout.strip.map(take).filter((item): item is NavigationSectionItem => item !== null);

  const laidOut = layout.sections.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.items.map(take).filter((item): item is NavigationSectionItem => item !== null),
  }));

  // Anything gated-in that the layout never mentioned: append to its original section, or to a
  // section carrying its original id if the layout dropped that section entirely. See the header
  // comment — a new page must never be silently invisible.
  const unplaced: NavigationSectionItem[] = [];
  for (const section of gatedSections) {
    for (const item of section.items) {
      if (placed.has(item.href) || hidden.has(item.href)) continue;
      placed.add(item.href);
      unplaced.push(item);
    }
  }

  const sections = laidOut.map((section) => ({ ...section, items: [...section.items] }));
  for (const item of unplaced) {
    const originId = sectionOfHref.get(item.href);
    const home = sections.find((section) => section.id === originId);
    if (home) {
      home.items.push(item);
      continue;
    }
    // Its original section is not in the layout at all — recreate it from the code definition so
    // the page still has a labelled home rather than being dumped somewhere arbitrary.
    const origin = gatedSections.find((section) => section.id === originId);
    sections.push({
      id: origin?.id ?? "unfiled",
      label: origin?.label ?? "More",
      items: [item],
    });
  }

  return {
    strip,
    sections: sections
      .filter((section) => section.items.length > 0)
      .map((section) => ({ id: section.id, label: section.label, items: section.items })),
  };
}
