import type { NavigationSectionItem } from "@/config/system-navigation";

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

/**
 * The identity a layout is stored under: hr_id when there is one, otherwise the login id.
 *
 * WHY THE FALLBACK EXISTS — it is not a nicety. Production has exactly one account with a NULL
 * hr_id, and it is an ACTIVE SUPER ADMIN: `admin-HR`. `app_auth_users.hr_id` carries a foreign key
 * to `employees`, production has no employees row for that login, and the column is deliberately
 * left NULL because satisfying the FK would mean injecting a synthetic person into a live payroll
 * platform. `resolveAccessContext` passes that column straight through (`hrId: row.hr_id`) with no
 * fallback -- unlike `mapAuthUserRow`, which does `row.hr_id?.trim() || row.login_id.trim()`. So
 * before this function existed, that account's every save died on
 * "Cannot save a navigation layout without an hr_id": a 500 on the one screen whose entire purpose
 * is saving, from the one account most likely to be arranging the nav.
 *
 * WHY IT IS SAFE HERE AND NOWHERE ELSE. This key names a row in `nav_personal_layout` and nothing
 * else. That table has no foreign key to `employees` (checked: primary key on hr_id, a lowercase
 * CHECK, two jsonb shape CHECKs -- nothing referential), and a layout grants no access to anything,
 * so the worst a wrong key can do is show one person the default menu. Do NOT reuse this for
 * payroll, attribution, permissions, or anything that identifies a PERSON -- there, hr_id is the
 * only correct key and a login-id fallback would silently attribute work to a row that is not an
 * employee.
 *
 * Read and write must derive the key identically, or a layout saves under one key and renders from
 * another -- which looks exactly like "saving does nothing". Every call site therefore goes through
 * this one function.
 */
export function layoutOwnerKey(access: {
  hrId?: string | null;
  loginId?: string | null;
}): string | null {
  return layoutKeyFor(access.hrId) ?? layoutKeyFor(access.loginId);
}

/** A section in a saved layout. `label` is the owner's own name for it; `id` ties back to the
 *  code-defined section so a renamed section still matches its default when the layout is reset. */
export type PersonalLayoutSection = {
  id: string;
  label: string;
  /** Ordered hrefs. An href listed here is pulled OUT of whatever section defined it. */
  items: readonly string[];
};

/** The two horizontal rows as one unit — what a module override stores, and what resolving one returns. */
export type PersonalLayoutRowSet = {
  upperRow: readonly string[];
  lowerRow: readonly string[];
};

export type PersonalNavigationLayout = {
  version: typeof PERSONAL_LAYOUT_VERSION;
  /** Layer 1 — the utility strip. Owner's ruling 2026-08-28: Approvals + Organogram only. */
  strip: readonly string[];
  /**
   * ZONE 2 — the horizontal nav bar ABOVE the page title.
   *
   * Added 2026-08-28 for the owner's three-row navigation (the shape in
   * Phoenix_God_Mode_Context_OS_V9_Sovereign.html, where `nav.domainbar` sits at y=56 and the page
   * title at y=173). His ask, verbatim: "I want to be freely able to exchange tabs that appeared
   * either above or either down", and "in all modules — I want this to be the shape of the system".
   *
   * OPTIONAL ON PURPOSE, and this is the reason the version below is still 1. A saved layout
   * already exists in production — the owner's own, the single row in `nav_personal_layout`. Bumping
   * PERSONAL_LAYOUT_VERSION would make `isPersonalNavigationLayout` reject it, and the loader's
   * fail-safe would then silently serve him the code-defined nav instead: his saved arrangement
   * would appear to have been wiped, with no error anywhere. Widening the document with optional
   * fields keeps every stored layout valid and simply gives it two empty rows.
   */
  upperRow?: readonly string[];
  /**
   * ZONE 3 — the horizontal nav row BELOW the page title (`nav.moduledeck` in the prototype, y=338).
   * Same optionality rule as `upperRow` above.
   */
  lowerRow?: readonly string[];
  /**
   * PER-MODULE ROW OVERRIDES, keyed by the code-defined section id.
   *
   * The owner's follow-up, 2026-08-28: "in the marketing and ROI, I want to have [tabs] related in
   * the horizontal like this. But in sales, I want to have another." So the two rows are not one
   * fixed set — inside a module they can carry that module's own tabs.
   *
   * Keyed on the MODULE, not the page. That is the unit he named, and a per-page arrangement would
   * mean maintaining 243 of them. A module with an entry here REPLACES the default rows above while
   * you are inside it; a module with no entry uses the defaults. The strip is deliberately not
   * scoped — it belongs to the sidebar, which does not change as you move between modules.
   *
   * Optional for the same reason `upperRow` is: an already-saved layout must stay valid.
   */
  moduleRows?: Readonly<Record<string, PersonalLayoutRowSet>>;
  /** Layer 2 + 3 — modules and the pages inside them. */
  sections: readonly PersonalLayoutSection[];
  /** Hrefs the owner chose to hide. Hiding is cosmetic and personal; it revokes nothing. */
  hidden: readonly string[];
};

/**
 * The three horizontal zones, in the order they appear down the page. Exported as data rather than
 * written out at each call site so the editor, the shell and the tests iterate ONE list — adding a
 * fourth zone later means adding it here, not hunting for the places that enumerate three.
 */
export const HORIZONTAL_ZONES = [
  { key: "strip", label: "Top strip", hint: "Pinned above the sidebar modules." },
  { key: "upperRow", label: "Upper nav row", hint: "Above the page title." },
  { key: "lowerRow", label: "Lower nav row", hint: "Below the page title." },
] as const;

export type HorizontalZoneKey = (typeof HORIZONTAL_ZONES)[number]["key"];

/**
 * The rearrangement below is generic over the item type, and deliberately so. The live sidebar
 * applies it to NavigationSectionItem (icons and all); the editor applies it to a plain
 * {href, label} shape, because a React icon component cannot cross from a server component to a
 * client one. Sharing ONE implementation is what stops the editor's preview and the real sidebar
 * disagreeing about where a page ends up — two copies of this reconciliation would drift, and the
 * symptom would be an editor that lies about the result.
 */
export type LayoutItemLike = { href: string };
export type LayoutSectionLike<TItem extends LayoutItemLike> = {
  id: string;
  label: string;
  items: readonly TItem[];
};

export type AppliedNavigationOf<TItem extends LayoutItemLike> = {
  /** Zone 1 — items promoted to the utility strip, in the owner's order. */
  strip: readonly TItem[];
  /** Zone 2 — the horizontal bar above the page title. */
  upperRow: readonly TItem[];
  /** Zone 3 — the horizontal row below the page title. */
  lowerRow: readonly TItem[];
  /** The sidebar, after rearrangement. */
  sections: readonly LayoutSectionLike<TItem>[];
};

/** The live-sidebar case: the same result, over real navigation items. */
export type AppliedNavigation = AppliedNavigationOf<NavigationSectionItem>;

export function isPersonalNavigationLayout(value: unknown): value is PersonalNavigationLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersonalNavigationLayout>;
  if (candidate.version !== PERSONAL_LAYOUT_VERSION) return false;
  if (!Array.isArray(candidate.strip) || !candidate.strip.every((h) => typeof h === "string")) return false;
  if (!Array.isArray(candidate.hidden) || !candidate.hidden.every((h) => typeof h === "string")) return false;
  // ABSENT is valid — see the comment on `upperRow`. Every layout saved before the two horizontal
  // rows existed omits these, and rejecting one would look to its owner like his arrangement had
  // been wiped. PRESENT but malformed is not valid, and falls back like any other bad document.
  const rowsAreValid = ([candidate.upperRow, candidate.lowerRow] as const).every(
    (row) => row === undefined || (Array.isArray(row) && row.every((h) => typeof h === "string")),
  );
  if (!rowsAreValid) return false;
  // Same absent-is-valid rule for the per-module overrides. A present value must be a plain object
  // whose every entry carries both rows as string arrays — a half-written entry is junk, not a
  // partial override, because "which row did he mean" has no safe answer.
  if (candidate.moduleRows !== undefined) {
    if (
      typeof candidate.moduleRows !== "object" ||
      candidate.moduleRows === null ||
      Array.isArray(candidate.moduleRows)
    ) {
      return false;
    }
    const entriesAreValid = Object.values(candidate.moduleRows).every(
      (set) =>
        set !== null &&
        typeof set === "object" &&
        Array.isArray((set as PersonalLayoutRowSet).upperRow) &&
        (set as PersonalLayoutRowSet).upperRow.every((h) => typeof h === "string") &&
        Array.isArray((set as PersonalLayoutRowSet).lowerRow) &&
        (set as PersonalLayoutRowSet).lowerRow.every((h) => typeof h === "string"),
    );
    if (!entriesAreValid) return false;
  }
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
export function defaultLayoutFrom<TItem extends LayoutItemLike>(
  sections: readonly LayoutSectionLike<TItem>[],
): PersonalNavigationLayout {
  return {
    version: PERSONAL_LAYOUT_VERSION,
    strip: [],
    upperRow: [],
    lowerRow: [],
    moduleRows: {},
    sections: sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map((item) => item.href),
    })),
    hidden: [],
  };
}

/**
 * Which two rows apply while you are inside `moduleId`.
 *
 * A module with an override REPLACES the default rows rather than adding to them — "in sales I want
 * another" means another set, not the default plus a few. A module with no entry, or no module at
 * all (a page belonging to no section), gets the defaults.
 *
 * Exported because the editor resolves the same question when you pick a module to arrange, and two
 * copies of this rule would drift into an editor that lies about what will render.
 */
export function resolveRowSet(
  layout: PersonalNavigationLayout | null,
  moduleId: string | null | undefined,
): PersonalLayoutRowSet {
  const override = moduleId ? layout?.moduleRows?.[moduleId] : undefined;
  if (override) return { upperRow: override.upperRow, lowerRow: override.lowerRow };
  return { upperRow: layout?.upperRow ?? [], lowerRow: layout?.lowerRow ?? [] };
}

/**
 * -- THE ONE-ZONE RULE -----------------------------------------------------------------------
 *
 * A page renders in exactly ONE place, and `applyPersonalLayout` resolves the strip BEFORE the two
 * rows: `take` marks an href placed, so whichever zone asks first keeps it and every later zone
 * gets nothing. That order is deliberate and stays -- but it means a document listing one page in
 * BOTH the strip and a row is not a preference, it is a contradiction, and the losing zone renders
 * empty with no error anywhere.
 *
 * That contradiction shipped, and cost a real evening on 2026-08-28. The owner put Organogram in
 * the Top strip, then opened a module's own rows -- a view that does not show the strip at all --
 * and added Organogram there too. His layout saved perfectly (a 200, the row read back from the
 * database), and the nav above the page title stayed empty on every page, because the strip had
 * already claimed the only Organogram there is. From his seat: "I selected the layout, then I save,
 * and nothing happens."
 *
 * So the editor has to enforce what the renderer enforces. These functions are that rule, kept here
 * rather than in the editor for two reasons: `sidebar-layout-editor.tsx` is a client component with
 * JSX, which the test runner's type stripping cannot import, so a rule written there cannot be
 * tested at all; and the rule belongs beside the precedence it mirrors, where whoever changes one
 * is already reading the other.
 *
 * SCOPE OF THE RULE -- it is narrower than "no href twice", and the difference is load-bearing:
 *   - strip vs any row -- A CONFLICT. The strip is global and resolved first, so it always wins.
 *   - the default rows vs a module override -- fine. An override REPLACES the defaults, so the two
 *     never resolve together.
 *   - one module's rows vs another's -- fine, for the same reason.
 *   - a row vs a sidebar section -- fine, and deliberate: the row claims the page only inside that
 *     module, and it stays in the sidebar everywhere else.
 *   - upper vs lower inside one row set -- a conflict, but not one the editor can create: a move
 *     always removes the page from the column it came from.
 */

/** The three horizontal zones, in the one shape the editor's state and a saved layout share. */
export type ZonePlacement = {
  strip: readonly string[];
  /** The DEFAULT pair of rows. */
  rows: PersonalLayoutRowSet;
  /** Per-module overrides, keyed by section id. */
  moduleRows: Readonly<Record<string, PersonalLayoutRowSet>>;
};

/** A row set the caller may write to -- what the release helpers below hand back. */
export type MutableRowSet = { upperRow: string[]; lowerRow: string[] };

/** Read a stored layout as a ZonePlacement, so the rule can be asked of it directly. */
export function placementOf(layout: PersonalNavigationLayout): ZonePlacement {
  return {
    strip: layout.strip,
    rows: { upperRow: layout.upperRow ?? [], lowerRow: layout.lowerRow ?? [] },
    moduleRows: layout.moduleRows ?? {},
  };
}

/**
 * Every href the strip claims that a row also lists -- i.e. every page whose row entry can never
 * render. Empty for a well-formed document, so a non-empty answer is always something to act on.
 */
export function stripRowConflicts(placement: ZonePlacement): string[] {
  const inARow = new Set<string>();
  for (const set of [placement.rows, ...Object.values(placement.moduleRows)]) {
    for (const href of set.upperRow) inARow.add(href);
    for (const href of set.lowerRow) inARow.add(href);
  }
  const seen = new Set<string>();
  return placement.strip.filter((href) => {
    if (!inARow.has(href) || seen.has(href)) return false;
    seen.add(href);
    return true;
  });
}

/** The strip, minus `hrefs` -- for when a page has just been placed in a row. */
export function stripWithout(placement: ZonePlacement, hrefs: readonly string[]): string[] {
  const drop = new Set(hrefs);
  return placement.strip.filter((href) => !drop.has(href));
}

/**
 * The default rows and every module override, each minus `hrefs` -- for when a page has just been
 * pinned to the strip, or when a stored contradiction is being cleared. EVERY row set is swept, not
 * only the one on screen: the copy that renders empty is usually in a module you are not looking at.
 */
export function rowsWithout(
  placement: ZonePlacement,
  hrefs: readonly string[],
): { rows: MutableRowSet; moduleRows: Record<string, MutableRowSet> } {
  const drop = new Set(hrefs);
  const clean = (set: PersonalLayoutRowSet): MutableRowSet => ({
    upperRow: set.upperRow.filter((href) => !drop.has(href)),
    lowerRow: set.lowerRow.filter((href) => !drop.has(href)),
  });
  const moduleRows: Record<string, MutableRowSet> = {};
  for (const [moduleId, set] of Object.entries(placement.moduleRows)) {
    moduleRows[moduleId] = clean(set);
  }
  return { rows: clean(placement.rows), moduleRows };
}

/**
 * Clear a stored contradiction: every row entry the strip has already claimed, gone.
 *
 * Render-neutral by construction -- those entries could never appear, so removing them changes the
 * document and changes nothing on screen. What it is NOT is cosmetic: leaving them would put one
 * href in two columns of the editor, which is a duplicate dnd-kit id, i.e. a broken board on top of
 * a broken layout.
 *
 * AND IT DROPS AN OVERRIDE THE CLEARING EMPTIED, which is the part that is easy to miss and was.
 * A module override REPLACES the defaults, so a module left holding two empty rows shows no rows at
 * all -- and the obvious next move, sending the page from the strip to the default Upper nav row,
 * would then work everywhere EXCEPT the modules he had been trying to arrange. The override existed
 * only to hold entries that could never render, so dropping it puts the module back exactly where
 * it would be had the override never been created.
 *
 * An override that was ALREADY empty is kept: that one is a deliberate "no rows in this module",
 * and nothing about it is a contradiction.
 */
export function resolveStripConflicts(placement: ZonePlacement): {
  conflicts: string[];
  rows: MutableRowSet;
  moduleRows: Record<string, MutableRowSet>;
} {
  const conflicts = stripRowConflicts(placement);
  const cleared = rowsWithout(placement, conflicts);
  const moduleRows: Record<string, MutableRowSet> = {};
  for (const [moduleId, set] of Object.entries(cleared.moduleRows)) {
    const before = placement.moduleRows[moduleId];
    const wasEmpty = before.upperRow.length === 0 && before.lowerRow.length === 0;
    const isEmpty = set.upperRow.length === 0 && set.lowerRow.length === 0;
    if (isEmpty && !wasEmpty) continue;
    moduleRows[moduleId] = set;
  }
  return { conflicts, rows: cleared.rows, moduleRows };
}

/**
 * Rearrange `gatedSections` according to `layout`.
 *
 * `gatedSections` MUST be the output of `getSections` — already permission- and role-filtered.
 * Passing raw config here would still not grant anything (every emitted href comes from the
 * input), but the result would show pages the viewer cannot open.
 *
 * `activeModuleId` is the code-defined section id of the page being rendered, and selects which of
 * the per-module row overrides applies. It is resolved from the GATED sections, never from the
 * rearranged ones: a page moved into a row has left its section, so asking the rearranged tree
 * which module you are in would answer differently once you arranged anything.
 */
export function applyPersonalLayout<TItem extends LayoutItemLike>(
  gatedSections: readonly LayoutSectionLike<TItem>[],
  layout: PersonalNavigationLayout | null,
  activeModuleId?: string | null,
): AppliedNavigationOf<TItem> {
  if (!layout) {
    return { strip: [], upperRow: [], lowerRow: [], sections: gatedSections };
  }
  const rows = resolveRowSet(layout, activeModuleId);

  // Index the gated set by href. This map is the ONLY source of items below — which is what makes
  // it impossible for a layout to conjure a page the viewer was not already allowed to see.
  const byHref = new Map<string, TItem>();
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

  const take = (href: string): TItem | null => {
    if (placed.has(href) || hidden.has(href)) return null;
    const item = byHref.get(href);
    if (!item) return null; // gone from the nav, or not permitted for this viewer
    placed.add(href);
    return item;
  };

  // The three horizontal zones are resolved BEFORE the sidebar, and that order is load-bearing.
  // `take` marks an href as placed, so a tab the owner moved up into a row is pulled OUT of whatever
  // sidebar section defined it rather than rendering in both places. Resolving the sidebar first
  // would claim every href and leave all three rows permanently empty.
  //
  // The two rows come from `rows`, which is the module override where one exists — so a page listed
  // in Sales' rows is claimed only while you are in Sales, and stays in the sidebar everywhere else.
  const strip = layout.strip.map(take).filter((item): item is TItem => item !== null);
  const upperRow = rows.upperRow.map(take).filter((item): item is TItem => item !== null);
  const lowerRow = rows.lowerRow.map(take).filter((item): item is TItem => item !== null);

  const laidOut = layout.sections.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.items.map(take).filter((item): item is TItem => item !== null),
  }));

  // Anything gated-in that the layout never mentioned: append to its original section, or to a
  // section carrying its original id if the layout dropped that section entirely. See the header
  // comment — a new page must never be silently invisible.
  const unplaced: TItem[] = [];
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
    upperRow,
    lowerRow,
    sections: sections
      .filter((section) => section.items.length > 0)
      .map((section) => ({ id: section.id, label: section.label, items: section.items })),
  };
}

/** The document a "+" writes into when the viewer has never saved a layout at all. */
function emptyLayout(): PersonalNavigationLayout {
  return {
    version: PERSONAL_LAYOUT_VERSION,
    strip: [],
    upperRow: [],
    lowerRow: [],
    moduleRows: {},
    sections: [],
    hidden: [],
  };
}

/**
 * Pin a page into one of the two horizontal nav rows — the write behind the "+" on each row.
 *
 * The owner's ask, 2026-08-28: a plus sign at the end of the row, which opens the list of modules,
 * and whatever he picks is "embedded like the organogram" — meaning fixed in EVERY module, not just
 * the one he happened to be standing in when he pressed it. `target` is which row; the upper row's
 * "+" passes "upperRow" and the lower row's passes "lowerRow".
 *
 * That phrase is the whole reason this is not a one-line append, and it is why the rule lives here
 * rather than in the button:
 *
 *  1. THE STRIP OUTRANKS THE ROW. `applyPersonalLayout` resolves the strip first and `take` marks
 *     the href placed, so a page listed in both renders in the strip and the row comes back EMPTY —
 *     a save that returns 200 and changes nothing on screen. Adding to a row must therefore release
 *     the strip entry in the same write. This is the same contradiction the editor's guard exists to
 *     stop; the "+" is a second door into the same document and needs the same lock.
 *  2. A MODULE OVERRIDE REPLACES THE DEFAULTS — it does not merge with them. So appending only to
 *     the default row would put the page in every module EXCEPT the ones carrying their own rows,
 *     which is precisely backwards: those are the modules the owner has already taken the trouble to
 *     arrange. Every existing override therefore gets the href too.
 *  3. A page cannot sit in both rows, so the OTHER row releases it. This is also what makes the
 *     lower row's "+" a MOVE rather than a duplicate when the page is already up top.
 *
 * `sections` is deliberately left alone. A page in a row has already been taken by the time
 * `applyPersonalLayout` reaches the sections, so its section entry is inert — and keeping it means
 * `unpinHrefFromRows` returns the page to where it came from rather than losing it.
 */
export function pinHrefToRow(
  layout: PersonalNavigationLayout | null,
  href: string,
  target: keyof PersonalLayoutRowSet = "upperRow",
): PersonalNavigationLayout {
  const base = layout ?? emptyLayout();

  // Append-if-absent rather than a blind push: pressing "+" twice on the same page must not put two
  // identical tabs in the row, and re-adding a page already there must not move it to the end.
  const without = (list: readonly string[] | undefined): string[] =>
    (list ?? []).filter((entry) => entry !== href);
  const withHref = (list: readonly string[] | undefined): string[] =>
    (list ?? []).includes(href) ? [...(list ?? [])] : [...(list ?? []), href];

  // Written out per branch rather than with a computed key, so the returned object is a
  // PersonalLayoutRowSet by construction and needs no cast to become one.
  const place = (set: Partial<PersonalLayoutRowSet> | undefined): PersonalLayoutRowSet =>
    target === "upperRow"
      ? { upperRow: withHref(set?.upperRow), lowerRow: without(set?.lowerRow) }
      : { upperRow: without(set?.upperRow), lowerRow: withHref(set?.lowerRow) };

  const moduleRows: Record<string, PersonalLayoutRowSet> = {};
  for (const [moduleId, set] of Object.entries(base.moduleRows ?? {})) {
    moduleRows[moduleId] = place(set);
  }

  const rootRows = place({ upperRow: base.upperRow, lowerRow: base.lowerRow });

  return {
    ...base,
    version: PERSONAL_LAYOUT_VERSION,
    strip: without(base.strip),
    upperRow: rootRows.upperRow,
    lowerRow: rootRows.lowerRow,
    moduleRows,
    hidden: without(base.hidden),
  };
}

/**
 * Take a page OFF both horizontal rows — the write behind the tick in the same "+" panel.
 *
 * Without this the "+" was a one-way door: the only way back out of a row was /admin/sidebar-layout,
 * which is exactly the trip the "+" exists to save. Removal has to reach the module overrides for
 * the same reason trap 2 above does — a page pinned "in every module" wrote itself into every
 * override, so clearing only the default rows would leave it stuck inside every module the owner has
 * arranged, and nowhere else.
 *
 * What it deliberately does NOT do:
 *  - It never adds to `hidden`. Removing a tab from a row means "put it back where it came from",
 *    not "make it unreachable" — `applyPersonalLayout` appends any unplaced gated page to its origin
 *    section, so the page reappears in the sidebar the moment the row releases it.
 *  - It never restores `strip`. Pinning released the strip entry (trap 1) and that is not
 *    reconstructable from here — the document does not record where an href came from. The strip is
 *    two pinned items by the owner's own ruling, so the editor is the right place to put one back.
 */
export function unpinHrefFromRows(
  layout: PersonalNavigationLayout | null,
  href: string,
): PersonalNavigationLayout {
  const base = layout ?? emptyLayout();
  const without = (list: readonly string[] | undefined): string[] =>
    (list ?? []).filter((entry) => entry !== href);

  const moduleRows: Record<string, PersonalLayoutRowSet> = {};
  for (const [moduleId, set] of Object.entries(base.moduleRows ?? {})) {
    moduleRows[moduleId] = { upperRow: without(set.upperRow), lowerRow: without(set.lowerRow) };
  }

  return {
    ...base,
    version: PERSONAL_LAYOUT_VERSION,
    upperRow: without(base.upperRow),
    lowerRow: without(base.lowerRow),
    moduleRows,
  };
}
