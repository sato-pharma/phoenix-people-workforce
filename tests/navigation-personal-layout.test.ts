import assert from "node:assert/strict";

import type { NavigationSection, NavigationSectionItem } from "../src/config/system-navigation.ts";
import {
  applyPersonalLayout,
  defaultLayoutFrom,
  isPersonalNavigationLayout,
  PERSONAL_LAYOUT_VERSION,
  type PersonalNavigationLayout,
} from "../src/lib/navigation/personal-layout.ts";

// Minimal typed fixture builder — applyPersonalLayout only ever reads `href` and carries the item
// through by reference, so we synthesise items without real lucide icons (same approach as
// navigation-active-path.test.ts). Keeping lucide out means this file has no runtime import at all.
const item = (href: string, label: string): NavigationSectionItem =>
  ({ href, label }) as unknown as NavigationSectionItem;

// Stands in for the output of getSections — i.e. ALREADY permission- and role-filtered.
const gated: readonly NavigationSection[] = [
  { id: "sales", label: "Sales", items: [item("/admin/sales", "Sales"), item("/admin/targets", "Targets")] },
  { id: "people", label: "People", items: [item("/admin/employees", "Employees"), item("/admin/organogram", "Organogram")] },
];

const layout = (over: Partial<PersonalNavigationLayout> = {}): PersonalNavigationLayout => ({
  version: PERSONAL_LAYOUT_VERSION,
  strip: [],
  sections: [],
  hidden: [],
  ...over,
});

const hrefsOf = (sections: readonly NavigationSection[]) =>
  sections.map((s) => [s.id, s.items.map((i) => i.href)] as const);

export function runNavigationPersonalLayoutTests() {
  // ── No layout saved: the sidebar is exactly what the code defines ────────────────────────────
  {
    const applied = applyPersonalLayout(gated, null);
    assert.deepEqual(applied.strip, [], "no layout means nothing is promoted to the strip");
    assert.deepEqual(hrefsOf(applied.sections), hrefsOf(gated), "no layout is a passthrough");
  }

  // ── THE SECURITY INVARIANT ──────────────────────────────────────────────────────────────────
  // A layout naming an href the viewer was not gated into must emit NOTHING for it. This is the
  // property that keeps a personal layout from becoming an access-control bypass.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({
        strip: ["/admin/payroll-secrets"],
        sections: [{ id: "mine", label: "Mine", items: ["/admin/sales", "/admin/not-permitted"] }],
      }),
    );
    const emitted = [...applied.strip.map((i) => i.href), ...applied.sections.flatMap((s) => s.items.map((i) => i.href))];
    assert.ok(!emitted.includes("/admin/payroll-secrets"), "a layout cannot promote an ungated href into the strip");
    assert.ok(!emitted.includes("/admin/not-permitted"), "a layout cannot add an ungated href to a section");
    const gatedHrefs = new Set(gated.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of emitted) {
      assert.ok(gatedHrefs.has(href), `every emitted href must come from the gated input: ${href}`);
    }
  }

  // ── Move a page from one module to another, and promote one to the strip ────────────────────
  {
    const applied = applyPersonalLayout(
      gated,
      layout({
        strip: ["/admin/organogram"],
        sections: [
          { id: "sales", label: "Commercial", items: ["/admin/targets", "/admin/employees", "/admin/sales"] },
        ],
      }),
    );
    assert.deepEqual(applied.strip.map((i) => i.href), ["/admin/organogram"], "organogram is promoted to layer 1");
    assert.equal(applied.sections[0].label, "Commercial", "the owner's own section name is used");
    assert.deepEqual(
      applied.sections[0].items.map((i) => i.href),
      ["/admin/targets", "/admin/employees", "/admin/sales"],
      "pages move across modules and keep the owner's order",
    );
    // "people" held only those two hrefs; both were placed elsewhere, so it must not linger empty.
    assert.ok(!applied.sections.some((s) => s.id === "people"), "a section emptied by moves is dropped");
  }

  // ── A page the layout never mentions still appears (the 13-day-silent-failure guard) ────────
  {
    const withNewPage: readonly NavigationSection[] = [
      ...gated,
      { id: "sales", label: "Sales", items: [item("/admin/brand-new", "Brand New")] },
    ];
    const applied = applyPersonalLayout(
      withNewPage,
      layout({ sections: [{ id: "sales", label: "Sales", items: ["/admin/sales", "/admin/targets"] }] }),
    );
    const emitted = applied.sections.flatMap((s) => s.items.map((i) => i.href));
    assert.ok(emitted.includes("/admin/brand-new"), "a page added after the layout was saved must still render");
    assert.ok(emitted.includes("/admin/employees"), "a page whose whole section is missing from the layout still renders");
  }

  // ── Hiding is personal and cosmetic ─────────────────────────────────────────────────────────
  {
    const applied = applyPersonalLayout(gated, layout({ hidden: ["/admin/targets"] }));
    const emitted = applied.sections.flatMap((s) => s.items.map((i) => i.href));
    assert.ok(!emitted.includes("/admin/targets"), "a hidden page is not rendered");
    assert.ok(emitted.includes("/admin/sales"), "hiding one page does not affect its siblings");
  }

  // ── A stale layout naming the same href twice renders it once ───────────────────────────────
  {
    const applied = applyPersonalLayout(
      gated,
      layout({
        sections: [
          { id: "a", label: "A", items: ["/admin/sales"] },
          { id: "b", label: "B", items: ["/admin/sales"] },
        ],
      }),
    );
    const count = applied.sections.flatMap((s) => s.items).filter((i) => i.href === "/admin/sales").length;
    assert.equal(count, 1, "a duplicated href renders exactly once");
  }

  // ── defaultLayoutFrom round-trips to an unchanged sidebar ────────────────────────────────────
  {
    const round = applyPersonalLayout(gated, defaultLayoutFrom(gated));
    assert.deepEqual(hrefsOf(round.sections), hrefsOf(gated), "the default layout reproduces the code-defined nav");
    assert.deepEqual(round.strip, [], "the default layout promotes nothing");
  }

  // ── Shape validation rejects junk before it reaches the renderer ─────────────────────────────
  {
    assert.equal(isPersonalNavigationLayout(defaultLayoutFrom(gated)), true, "a real layout validates");
    assert.equal(isPersonalNavigationLayout(null), false, "null is not a layout");
    assert.equal(isPersonalNavigationLayout({ version: 99, strip: [], sections: [], hidden: [] }), false, "a future version is rejected");
    assert.equal(isPersonalNavigationLayout({ version: PERSONAL_LAYOUT_VERSION, strip: [1], sections: [], hidden: [] }), false, "non-string hrefs are rejected");
  }
}
