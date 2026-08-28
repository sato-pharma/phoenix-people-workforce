import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { NavigationSection, NavigationSectionItem } from "../src/config/system-navigation.ts";
import {
  applyPersonalLayout,
  defaultLayoutFrom,
  isPersonalNavigationLayout,
  layoutKeyFor,
  PERSONAL_LAYOUT_VERSION,
  resolveRowSet,
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

/**
 * A layout in the shape saved BEFORE the two horizontal rows existed — no upperRow, no lowerRow.
 * Written as its own literal rather than by deleting keys, so it stays a genuine old document even
 * if the builder above gains defaults later. The saved row in production is this shape.
 */
const legacyLayout = (over: Record<string, unknown> = {}): unknown => ({
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


  // ── THE THREE HORIZONTAL ZONES ──────────────────────────────────────────────────────────────
  // The owner's ask, 2026-08-28: a nav row above the page title and another below it, with any tab
  // freely movable between them. A tab moved into a row must LEAVE the sidebar — rendering in both
  // places is the failure mode that makes an arrangement look broken rather than moved.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({
        strip: ["/admin/organogram"],
        upperRow: ["/admin/sales", "/admin/targets"],
        lowerRow: ["/admin/employees"],
      }),
    );
    assert.deepEqual(applied.upperRow.map((i) => i.href), ["/admin/sales", "/admin/targets"], "the upper row keeps the saved order");
    assert.deepEqual(applied.lowerRow.map((i) => i.href), ["/admin/employees"], "the lower row resolves");
    assert.deepEqual(applied.strip.map((i) => i.href), ["/admin/organogram"], "the strip still resolves alongside the rows");
    assert.deepEqual(applied.sections, [], "every page was placed in a zone, so no sidebar section remains");
  }

  // A page may sit in exactly ONE zone. A stale layout naming it in two renders it in the first.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/sales"], lowerRow: ["/admin/sales"] }),
    );
    assert.deepEqual(applied.upperRow.map((i) => i.href), ["/admin/sales"], "the first zone listed wins");
    assert.deepEqual(applied.lowerRow, [], "the same page does not render twice across zones");
  }

  // The security invariant again, this time through the two new doors. A row is exactly as unable
  // to introduce an href as the strip and the sections are.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/payroll-secrets"], lowerRow: ["/admin/not-permitted"] }),
    );
    assert.deepEqual(applied.upperRow, [], "the upper row cannot conjure an ungated href");
    assert.deepEqual(applied.lowerRow, [], "the lower row cannot conjure an ungated href");
    const gatedHrefs = new Set(gated.flatMap((s) => s.items.map((i) => i.href)));
    const emitted = [
      ...applied.strip,
      ...applied.upperRow,
      ...applied.lowerRow,
      ...applied.sections.flatMap((s) => s.items),
    ].map((i) => i.href);
    for (const href of emitted) {
      assert.ok(gatedHrefs.has(href), "every emitted href must come from the gated input: " + href);
    }
  }

  // Hiding still wins over a row — a hidden page is not resurrected by being listed in one.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/sales"], hidden: ["/admin/sales"] }),
    );
    assert.deepEqual(applied.upperRow, [], "a hidden page stays hidden even when a row names it");
  }

  // ── BACKWARD COMPATIBILITY WITH THE LAYOUT ALREADY IN PRODUCTION ────────────────────────────
  // This is why PERSONAL_LAYOUT_VERSION is still 1. A saved layout exists in nav_personal_layout,
  // written before these two fields did. If validation rejected it, the loader's fail-safe would
  // serve the code-defined nav instead and that arrangement would look WIPED, with no error
  // anywhere. So: an old document must validate, and must simply come back with empty rows.
  {
    const old = legacyLayout({ strip: ["/admin/organogram"] });
    assert.equal(isPersonalNavigationLayout(old), true, "a layout saved before the rows existed is still valid");
    const applied = applyPersonalLayout(gated, old as PersonalNavigationLayout);
    assert.deepEqual(applied.upperRow, [], "an old layout yields an empty upper row, not a crash");
    assert.deepEqual(applied.lowerRow, [], "an old layout yields an empty lower row");
    assert.deepEqual(applied.strip.map((i) => i.href), ["/admin/organogram"], "everything it DID say still applies");
    const emitted = applied.sections.flatMap((s) => s.items.map((i) => i.href));
    assert.ok(emitted.includes("/admin/sales") && emitted.includes("/admin/employees"), "unplaced pages still render");
  }

  // Present-but-malformed is a different case from absent, and must be rejected like any junk.
  {
    assert.equal(isPersonalNavigationLayout(legacyLayout({ upperRow: "sales" })), false, "a non-array upper row is rejected");
    assert.equal(isPersonalNavigationLayout(legacyLayout({ lowerRow: [1, 2] })), false, "non-string hrefs in a row are rejected");
    assert.equal(isPersonalNavigationLayout(legacyLayout({ upperRow: [], lowerRow: [] })), true, "explicitly empty rows are valid");
  }

  // ── PER-MODULE ROWS ─────────────────────────────────────────────────────────────────────────
  // The owner's follow-up, 2026-08-28: "in the marketing and ROI, I want to have [tabs] related in
  // the horizontal like this. But in sales, I want to have another." So the two rows carry one set
  // inside one module and a different set inside another, keyed on the MODULE.
  {
    const l = layout({
      upperRow: ["/admin/sales"],
      moduleRows: { people: { upperRow: ["/admin/organogram"], lowerRow: ["/admin/employees"] } },
    });

    assert.deepEqual(
      resolveRowSet(l, "people"),
      { upperRow: ["/admin/organogram"], lowerRow: ["/admin/employees"] },
      "a module with its own rows gets them",
    );
    assert.deepEqual(
      resolveRowSet(l, "sales"),
      { upperRow: ["/admin/sales"], lowerRow: [] },
      "a module with no arrangement of its own falls back to the default rows",
    );
    assert.deepEqual(resolveRowSet(l, null), { upperRow: ["/admin/sales"], lowerRow: [] }, "no module means the defaults");
    assert.deepEqual(resolveRowSet(null, "people"), { upperRow: [], lowerRow: [] }, "no layout means no rows at all");
  }

  // An override REPLACES the default rows. "In sales I want another" means another set, not the
  // default set plus a few — a merge would leave marketing tabs sitting in the sales rows forever.
  {
    const l = layout({
      upperRow: ["/admin/sales"],
      moduleRows: { people: { upperRow: ["/admin/organogram"], lowerRow: [] } },
    });
    const inPeople = applyPersonalLayout(gated, l, "people");
    assert.deepEqual(
      inPeople.upperRow.map((i) => i.href),
      ["/admin/organogram"],
      "the module's own row replaces the default one rather than being appended to it",
    );
  }

  // THE PROPERTY THAT MAKES THIS SAFE TO USE: a page listed in one module's rows is pulled out of
  // the sidebar only WHILE YOU ARE IN THAT MODULE. Anywhere else it is back where it belongs. Without
  // this, arranging one module would quietly strip pages out of the sidebar across the whole app.
  {
    const l = layout({ moduleRows: { sales: { upperRow: ["/admin/organogram"], lowerRow: [] } } });

    const inSales = applyPersonalLayout(gated, l, "sales");
    assert.deepEqual(inSales.upperRow.map((i) => i.href), ["/admin/organogram"], "inside Sales the tab is in the row");
    assert.ok(
      !inSales.sections.flatMap((s) => s.items.map((i) => i.href)).includes("/admin/organogram"),
      "and it has LEFT the sidebar there — rendering in both places is what makes a move look broken",
    );

    const inPeople = applyPersonalLayout(gated, l, "people");
    assert.deepEqual(inPeople.upperRow, [], "outside Sales that row does not apply");
    assert.ok(
      inPeople.sections.flatMap((s) => s.items.map((i) => i.href)).includes("/admin/organogram"),
      "and the page is back in the sidebar — a per-module row must not remove it everywhere",
    );
  }

  // An override that is present but EMPTY means "no rows in this module", not "use the defaults".
  // The distinction is the whole reason an override is a document rather than two optional arrays.
  {
    const l = layout({ upperRow: ["/admin/sales"], moduleRows: { people: { upperRow: [], lowerRow: [] } } });
    assert.deepEqual(applyPersonalLayout(gated, l, "people").upperRow, [], "an empty override means no rows here");
    assert.deepEqual(
      applyPersonalLayout(gated, l, "sales").upperRow.map((i) => i.href),
      ["/admin/sales"],
      "while a module without one still shows the defaults",
    );
  }

  // The security invariant once more, through the newest door. A per-module row is exactly as unable
  // to introduce an href as the default rows, the strip and the sections are.
  {
    const applied = applyPersonalLayout(
      gated,
      layout({ moduleRows: { sales: { upperRow: ["/admin/payroll"], lowerRow: ["/admin/secret"] } } }),
      "sales",
    );
    assert.deepEqual(applied.upperRow, [], "a module row cannot introduce an href the viewer was not gated into");
    assert.deepEqual(applied.lowerRow, [], "nor can the lower one");
  }

  // Absent is valid (an already-saved layout has no such key); present-but-malformed is not.
  {
    assert.equal(isPersonalNavigationLayout(legacyLayout({})), true, "a layout with no moduleRows key is valid");
    assert.equal(isPersonalNavigationLayout(legacyLayout({ moduleRows: {} })), true, "an empty override map is valid");
    assert.equal(
      isPersonalNavigationLayout(legacyLayout({ moduleRows: { sales: { upperRow: [], lowerRow: [] } } })),
      true,
      "a well-formed override is valid",
    );
    assert.equal(isPersonalNavigationLayout(legacyLayout({ moduleRows: [] })), false, "an array is not an override map");
    assert.equal(isPersonalNavigationLayout(legacyLayout({ moduleRows: { sales: null } })), false, "a null entry is rejected");
    assert.equal(
      isPersonalNavigationLayout(legacyLayout({ moduleRows: { sales: { upperRow: [] } } })),
      false,
      "a half-written entry is junk, not a partial override — 'which row did he mean' has no safe answer",
    );
    assert.equal(
      isPersonalNavigationLayout(legacyLayout({ moduleRows: { sales: { upperRow: [1], lowerRow: [] } } })),
      false,
      "non-string hrefs in an override are rejected",
    );
  }

  // The size cap has to see the overrides too: they are the one part of the document that grows with
  // the number of MODULES, so a cap that ignored them would not be a cap.
  {
    const route = readFileSync("app/api/navigation/personal-layout/route.ts", "utf8");
    assert.ok(
      /countHrefs[\s\S]{0,600}moduleRows/.test(route),
      "the route's size cap must count the per-module rows",
    );
  }

  // And something has to CHOOSE the module at render time, or every override is dead data.
  {
    const rows = readFileSync("src/components/layout/horizontal-nav-rows.tsx", "utf8");
    assert.ok(/activeModuleId/.test(rows), "the provider must resolve which module the page is in");
    assert.ok(
      /applyPersonalLayout\([\s\S]{0,200}activeModuleId/.test(rows),
      "and must pass it to applyPersonalLayout — without this the override never applies",
    );

    const editor = readFileSync("src/components/admin/sidebar-layout-editor.tsx", "utf8");
    assert.ok(/moduleRows/.test(editor), "the editor must be able to write a per-module arrangement");
  }

  // ── THE ROWS ARE ACTUALLY RENDERED ──────────────────────────────────────────────────────────
  // applyPersonalLayout returning the right items proves nothing on its own: the feature is
  // invisible unless something renders them, and the "exactly one copy of the lower row" rule is
  // CSS, which no unit test can execute. Source pins, by pattern rather than a byte window.
  {
    const shell = readFileSync("src/components/layout/app-shell.tsx", "utf8");
    assert.ok(/<HorizontalNavProvider/.test(shell), "AppShell must mount the horizontal-nav provider");
    assert.ok(/<UpperNavRow\s*\/>/.test(shell), "AppShell must render zone 2 — this is what reaches every page");
    assert.ok(/<LowerNavRow placement="fallback"/.test(shell), "AppShell must render the zone-3 fallback");
    assert.ok(/phx-navrow-scope/.test(shell), "the fallback must sit inside the scope the CSS rule keys on");

    const hero = readFileSync("src/components/admin/admin-design-system.tsx", "utf8");
    assert.ok(
      /<LowerNavRow[\s\S]{0,200}placement="in-page"/.test(hero),
      "AdminPageHero must render zone 3 in-page — it is the shared page title for the bulk of the admin surface",
    );

    // The dedup rule. Without it the fallback and the in-page copy both render on every page that
    // uses the hero, which is the majority of the admin surface.
    const css = readFileSync("app/globals.css", "utf8");
    assert.ok(
      /\.phx-navrow-scope:has\(\.phx-navrow--inpage\)\s+\.phx-navrow--fallback\s*\{\s*display:\s*none/.test(css),
      "globals.css must hide the fallback row whenever a page placed the row itself",
    );
  }

  // ── The storage key is always lowercased ────────────────────────────────────────────────────
  // hr_id casing is inconsistent in this database — a raw .eq() once hid 28% of reps' own orders.
  {
    assert.equal(layoutKeyFor("SA-0001"), "sa-0001", "an upper-case hr_id normalises");
    assert.equal(layoutKeyFor("  sa-0001  "), "sa-0001", "surrounding whitespace is trimmed");
    assert.equal(layoutKeyFor("sa-0001"), "sa-0001", "an already-lowercase hr_id is unchanged");
    assert.equal(layoutKeyFor(null), null, "a null identity has no key");
    assert.equal(layoutKeyFor(undefined), null, "an absent identity has no key");
    assert.equal(layoutKeyFor("   "), null, "a blank identity has no key");
  }

  // ── THE IDENTITY RULE ───────────────────────────────────────────────────────────────────────
  // The whole point of retiring Modules Control was that it targeted OTHER people. If the route
  // ever accepts an hr_id from the caller, this feature silently becomes that same targeting
  // matrix. Pinned by pattern rather than a byte window — a fixed source slice false-fails the
  // moment anything above it shifts.
  {
    // Strip comments before matching. The route's own header comment explains the rule in prose
    // ("there is no ?hrId=..."), and a pin that reads prose fails on a file that is documenting the
    // very thing it is being checked for — which is exactly what happened when this was written.
    const route = readFileSync("app/api/navigation/personal-layout/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    assert.ok(
      !/searchParams|nextUrl\.search|\?hrId=/.test(route),
      "the layout route must not read a query string — that is how a caller would name someone else",
    );
    assert.ok(
      !/\bhrId\b\s*[:=]\s*(body|payload|json|request)/i.test(route),
      "the layout route must never take hr_id from the request body",
    );
    // Every store call must be keyed on the resolved session, and on nothing else.
    const storeCalls = [...route.matchAll(/(?:loadPersonalLayout|savePersonalLayout|clearPersonalLayout)\(([^,)]*)/g)];
    assert.equal(storeCalls.length, 3, "GET, PUT and DELETE each call the store exactly once");
    for (const call of storeCalls) {
      assert.equal(call[1].trim(), "access.hrId", `store calls must key on access.hrId, found: ${call[1].trim()}`);
    }
    // An unauthenticated caller resolves to role "Employee", not null, so a !access.role check is
    // dead code. The guest test has to be on `source`.
    assert.ok(
      /access\.source === "guest"/.test(route),
      "the route must reject guests by access.source, not by a role check that can never fire",
    );
    assert.ok(
      !/if\s*\(\s*!\s*access\.role\s*\)/.test(route),
      "a !access.role guard never fires here — an unauthenticated caller has role Employee",
    );
  }
}
