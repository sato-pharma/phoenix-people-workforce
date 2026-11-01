import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { NavigationSection, NavigationSectionItem } from "../src/config/system-navigation.ts";
import { carriesNavRows, usesAdminChrome } from "../src/lib/navigation/active-path.ts";
import {
  applyPersonalLayout,
  COMPANY_DEFAULT_LAYOUT_KEY,
  countLayoutHrefs,
  defaultLayoutFrom,
  isPersonalNavigationLayout,
  layoutKeyFor,
  layoutOwnerKey,
  MAX_LAYOUT_HREFS,
  PERSONAL_LAYOUT_VERSION,
  pinHrefToRow,
  placeHrefInRow,
  placementOf,
  resolveRowSet,
  rowPositionOf,
  resolveStripConflicts,
  rowsWithout,
  stripRowConflicts,
  stripWithout,
  unpinHrefFromRows,
  type PersonalNavigationLayout,
} from "../src/lib/navigation/personal-layout.ts";
import { stripComments } from "./support/comment-strip.ts";

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
  //
  // The counter MOVED on 2026-08-29, out of the personal route and into personal-layout.ts, so the
  // company-default route could enforce the same rule instead of carrying a second copy of it. The
  // pin follows it. That the routes actually CALL it — both of them — is asserted in the shared-cap
  // block further down, together with a behavioural count that this source check cannot make.
  {
    const shared = readFileSync("src/lib/navigation/personal-layout.ts", "utf8");
    assert.ok(
      /countLayoutHrefs[\s\S]{0,600}moduleRows/.test(shared),
      "the shared size cap must count the per-module rows",
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

  // ── THE ROWS ARE ACTUALLY RENDERED, AND FROZEN ──────────────────────────────────────────────
  // applyPersonalLayout returning the right items proves nothing on its own: the feature is
  // invisible unless something renders them. The owner's rule (2026-08-29) is that both rows stay
  // FIXED in every module — pinned while the page scrolls, and in the same place on every page.
  // That is a DOM-shape property no unit test can execute, so it is pinned at the source: each
  // module must keep both rows inside one sticky container, and no page surface may render a copy
  // of its own. A row rendered inside a page hero can never be frozen — `position: sticky` is
  // bounded by its containing block, so such a row unpins the instant the hero scrolls away.
  {
    const shell = readFileSync("src/components/layout/app-shell.tsx", "utf8");
    assert.ok(shell.includes("<HorizontalNavProvider"), "AppShell must mount the horizontal-nav provider");
    assert.ok(shell.includes("phx-navrow-scope"), "the rows must sit inside the navrow scope");

    // The freeze itself: the Topbar and BOTH rows share one sticky container. Two stickies at the
    // same offset do not stack — they overlap — so splitting this block is what breaks the pin.
    // Find the block by SHAPE, not by its exact class string. Pinning the literal would mean any
    // restyle (a different z-index, an added class) silently matched nothing, and every assertion
    // below would then fire about a missing row when the row had never moved.
    const shellSticky = /<div className="(sticky top-0[^"]*)">/.exec(shell);
    assert.ok(shellSticky, "AppShell must pin its chrome in a sticky container at the top of the viewport");
    const afterSticky = shell.slice(shellSticky.index + shellSticky[0].length);
    const frozen = afterSticky.slice(0, afterSticky.indexOf("</div>"));
    assert.ok(frozen.includes("<Topbar"), "the Topbar must travel inside the frozen block");
    assert.ok(frozen.includes("<UpperNavRow />"), "zone 2 must be frozen with it — this is what reaches every page");
    assert.ok(frozen.includes("<LowerNavRow />"), "zone 3 must be frozen with it, not left to scroll away");

    // Its counterpart: the Topbar must NOT also be sticky on its own. A second sticky at top-0
    // inside the first pins nothing and adds a stacking context the row dropdowns must escape.
    // Read the <header>'s own leading class string, not the whole file: the prose above that
    // element names `sticky top-0` to say why it must not come back, and a whole-file substring
    // check would match that comment and pass for the wrong reason.
    const topbar = readFileSync("src/components/layout/topbar.tsx", "utf8");
    const afterHeader = topbar.split("<header className={")[1] ?? "";
    const headerClasses = afterHeader.slice(0, afterHeader.indexOf("$"));
    assert.ok(afterHeader.length > 0, "topbar must still render a <header> with a class expression");
    assert.ok(!headerClasses.includes("sticky"), "the Topbar is pinned BY AppShell and must not be sticky itself");

    // The negative pin, and the one that catches the regression: no page surface may render a row.
    const hero = readFileSync("src/components/admin/admin-design-system.tsx", "utf8");
    assert.ok(
      !hero.includes("<LowerNavRow"),
      "AdminPageHero must NOT render zone 3 — a row inside this hero cannot be frozen at all, because sticky is bounded by its containing block",
    );

    // THE PORTAL FREEZES NOTHING, because it renders no rows. It used to pin them in a sticky
    // block offset by its fixed header's height; the owner removed the rows from the portal on
    // 2026-09-03 ("never put anything above the identity banner … remove it totally"), so the
    // offset arithmetic that used to be pinned here has nothing left to describe.
    //
    // Inverted rather than deleted: the admin shell's half above is untouched, and this half now
    // states the rule the portal is actually held to, so "restore parity with admin" fires here
    // instead of shipping.
    const portal = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
    for (const row of ["<UpperNavRow", "<LowerNavRow", "<HorizontalNavProvider", "<NavRowAddButton"]) {
      assert.ok(
        !portal.includes(row),
        `the employee portal renders ${row} again. It has no arrangeable nav rows — owner rule, ` +
          "2026-09-03. Anything between the portal header and `main` is above the identity card by " +
          "construction, which is the placement he removed. The ADMIN shell keeps its rows; that is " +
          "not a parity gap to close.",
      );
    }

    // And with one copy per module there is nothing to deduplicate, so the :has() rule that hid
    // the duplicate is gone. Leaving it behind would be dead CSS keyed on markers no row carries.
    const css = readFileSync("app/globals.css", "utf8");
    assert.ok(
      !css.includes(":has(.phx-navrow--inpage)"),
      "the dedup rule must go with the second placement — a rule keyed on markers no row carries any more is dead",
    );
  }

  // ── The sidebar must out-rank the frozen chrome ───────────────────────────────────────────────
  // The rail toggle hangs 12px PAST the sidebar's right edge (`-right-3`) and the rail tooltips are
  // `fixed`, so both cross into the column the nav rows occupy. `position: sticky` with a z-index
  // makes the sidebar a stacking context, which traps those children at the ASIDE's own level however
  // high their own z-index climbs — the toggle's z-40 and the tooltip's z-[70] are each worth exactly
  // the sidebar's number when measured from outside it. Both the sidebar and the chrome were z-30, so
  // the tie broke on DOM order and the nav block wins that by being written second: measured in a
  // browser, the toggle's outer 11px were painted over by the row. Comparing the two NUMBERS is the
  // assertion, rather than pinning either literal, so a future restyle of either surface still has to
  // keep the relationship that makes the toggle clickable.
  {
    const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
    const shellSource = readFileSync("src/components/layout/app-shell.tsx", "utf8");

    const asideZ = /"sticky top-0 z-(\d+) hidden h-screen/.exec(sidebarSource);
    assert.ok(asideZ, "the desktop sidebar must still be a sticky, z-indexed <aside>");
    const chromeZ = /<div className="sticky top-0 z-(\d+)">/.exec(shellSource);
    assert.ok(chromeZ, "AppShell must still pin its chrome in a sticky, z-indexed container");
    assert.ok(
      Number(asideZ[1]) > Number(chromeZ[1]),
      `the sidebar (z-${asideZ[1]}) must stack ABOVE the frozen chrome (z-${chromeZ[1]}). At an equal or ` +
        `lower number the nav rows paint over the rail toggle's 12px overhang, because they are written ` +
        `later in the DOM and an equal z-index breaks on document order.`,
    );

    // Raising the sidebar must not bury the two surfaces that have to cover it.
    assert.ok(
      sidebarSource.includes("fixed inset-0 z-50"),
      "the mobile drawer must stay above the sidebar it replaces",
    );
    const palette = /z-\[(\d+)\]/.exec(readFileSync("src/components/layout/command-palette.tsx", "utf8"));
    assert.ok(
      palette && Number(palette[1]) > Number(asideZ[1]),
      "the command palette must still open above the sidebar",
    );
  }

  // ── The employee portal's rows are untouched ──────────────────────────────────────────────────
  // Owner, 2026-08-29: "DONOT TOUCH THE EMPLOYEE PORTAL I AM TALKING ON ADMIN SHELL". Both rows are
  // SHARED components, so every visual change had to land in the `dark` branch — `usesAdminChrome`,
  // which is admin and HR. This pins that split from both ends: the light class strings carry none of
  // the new utilities, and the scroll-shadow CSS is scoped to `.admin-shell` rather than sitting on
  // the bare `.phoenix-navrow-scroll` the portal's rows also carry.
  {
    const rows = readFileSync("src/components/layout/horizontal-nav-rows.tsx", "utf8");
    // Pinned VERBATIM rather than by slicing out a "light branch" and scanning it for banned
    // utilities. Slicing fails OPEN on exactly the change it exists to catch: the slice has to be
    // anchored on one of these strings, so editing that string makes the anchor miss, the slice
    // collapse to nothing, and the scan pass over an empty haystack. A literal check cannot fail
    // that way round — any edit to a portal class string breaks its own match.
    for (const shipped of [
      '"bg-phx-accent-soft text-phx-accent"',
      '"text-phx-ink-soft hover:bg-phx-paper hover:text-phx-ink"',
      '"border-phx-line bg-white"',
      '"border-phx-line bg-white/95"',
    ]) {
      assert.ok(
        rows.includes(shipped),
        `the employee portal's nav-row classes must stay exactly as shipped — ${shipped} is no longer present verbatim`,
      );
    }

    const rowCss = readFileSync("app/globals.css", "utf8");
    assert.ok(
      rowCss.includes(".admin-shell .phoenix-navrow-scroll"),
      "the overflow affordance must exist — a row with a hidden scrollbar and no edge shadow gives no sign it scrolls",
    );
    const bare = /\n\.phoenix-navrow-scroll \{([^}]*)\}/.exec(rowCss);
    assert.ok(bare, "the unscoped .phoenix-navrow-scroll rule must still exist for the hidden scrollbar");
    assert.ok(
      !bare[1].includes("background"),
      "the scroll shadows must NOT sit on the unscoped .phoenix-navrow-scroll — the portal's rows carry that class too",
    );

    // The arrow-key walk finds its tabs by attribute. Rendering one name and querying another leaves
    // keyboard navigation silently dead, with nothing visible to notice: the row still looks right.
    assert.ok(
      rows.includes('data-navrow-tab=""') && rows.includes("a[data-navrow-tab]"),
      "the arrow-key walk must query the same attribute the tabs render",
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

    // ── THE REGRESSION ────────────────────────────────────────────────────────────────────────
    // Production has exactly ONE account with a NULL hr_id, and it is an ACTIVE SUPER ADMIN:
    // `admin-HR`. app_auth_users.hr_id carries an FK to employees, production has no employees row
    // for that login, and the column is deliberately NULL because satisfying the FK would mean
    // inventing a person on a live payroll platform. resolveAccessContext passes the column through
    // raw (`hrId: row.hr_id`), so keying storage on access.hrId alone made every save from that
    // account return 500 "Cannot save a navigation layout without an hr_id" -- measured against
    // production 2026-08-28, a hard failure on the one screen whose entire purpose is saving.
    assert.equal(layoutOwnerKey({ hrId: "SA-0001", loginId: "someone-else" }), "sa-0001", "hr_id wins whenever there is one");
    assert.equal(
      layoutOwnerKey({ hrId: null, loginId: "admin-HR" }),
      "admin-hr",
      "an account with NO hr_id still gets a key - it falls back to the login id, lowercased",
    );
    assert.equal(layoutOwnerKey({ hrId: "   ", loginId: "admin-HR" }), "admin-hr", "a blank hr_id falls back too, not only a null one");
    assert.equal(layoutOwnerKey({ hrId: null, loginId: null }), null, "with neither identity there is still no key");
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
    const route = stripComments(readFileSync("app/api/navigation/personal-layout/route.ts", "utf8"));

    assert.ok(
      !/searchParams|nextUrl\.search|\?hrId=/.test(route),
      "the layout route must not read a query string — that is how a caller would name someone else",
    );
    assert.ok(
      !/\bhrId\b\s*[:=]\s*(body|payload|json|request)/i.test(route),
      "the layout route must never take hr_id from the request body",
    );
    // Every store call must be keyed on the resolved session, and on nothing else.
    const storeCalls = [
      ...route.matchAll(
        /(?:loadPersonalLayout|savePersonalLayout|clearPersonalLayout)\(\s*([A-Za-z0-9_.]+\([^()]*\)|[A-Za-z0-9_.]+)/g,
      ),
    ];
    assert.equal(storeCalls.length, 3, "GET, PUT and DELETE each call the store exactly once");
    for (const call of storeCalls) {
      assert.equal(
        call[1].trim(),
        "layoutOwnerKey(access)",
        `store calls must key on layoutOwnerKey(access), found: ${call[1].trim()}`,
      );
    }
    // The identity rule this pin exists for is unchanged: the key is derived from the RESOLVED
    // SESSION, never from anything the caller sent. The moment a request can name whose layout to
    // read or write, this stops being "my own account".
    assert.ok(
      !/(?:load|save|clear)PersonalLayout\([^)]*\b(?:request|body|searchParams|params|url)\b/.test(route),
      "the storage key must come from the resolved session, never from the request",
    );
    // Read and write must derive the key the SAME way. A layout saved under one key and rendered
    // from another is indistinguishable from "saving does nothing" - which is exactly how this bug
    // presented.
    for (const [path, what] of [
      ["src/components/layout/app-shell.tsx", "the shell that renders the sidebar"],
      ["app/(admin)/admin/sidebar-layout/page.tsx", "the editor that loads the saved arrangement"],
    ] as const) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      // Either loader is fine — both surfaces moved to loadEffectiveLayout on 2026-08-29 so a
      // company default can fill in for people who have saved nothing. What is pinned is the KEY:
      // whatever reads, it must read under layoutOwnerKey(access), the same expression the route
      // writes under.
      assert.ok(
        /load(?:Personal|Effective)Layout\(layoutOwnerKey\(access\)\)/.test(source),
        `${what} must read under layoutOwnerKey(access), or it renders a layout the route never wrote`,
      );
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

  // ── THE ONE-ZONE RULE ───────────────────────────────────────────────────────────────────────
  //
  // The mechanism first, because every assertion below exists to stop it recurring. A document
  // listing one page in BOTH the strip and a row is a contradiction, not a preference: the strip is
  // resolved first, `take` marks the href placed, and the row renders empty with no error anywhere.
  // Shipped 2026-08-28, and from the owner's seat it read as "I select the layout, then I save, and
  // nothing happens" — a save that returned 200 and a row that read back from the database intact.
  {
    const conflicted = layout({
      strip: ["/admin/organogram"],
      moduleRows: { people: { upperRow: ["/admin/organogram"], lowerRow: [] } },
    });
    const applied = applyPersonalLayout(gated, conflicted, "people");
    assert.deepEqual(
      applied.strip.map((i) => i.href),
      ["/admin/organogram"],
      "the strip is resolved before the rows, so it keeps the page",
    );
    assert.deepEqual(
      applied.upperRow.map((i) => i.href),
      [],
      "THE BUG: the row listing the same page renders empty, and nothing reports it",
    );

    // The same document with the strip entry released — one line different — renders the row.
    const released = layout({
      strip: stripWithout(placementOf(conflicted), ["/admin/organogram"]),
      moduleRows: conflicted.moduleRows,
    });
    assert.deepEqual(
      applyPersonalLayout(gated, released, "people").upperRow.map((i) => i.href),
      ["/admin/organogram"],
      "releasing it from the strip is what makes the row render",
    );
  }

  // stripRowConflicts names exactly the pages whose row entry can never render.
  {
    assert.deepEqual(
      stripRowConflicts(placementOf(layout({ strip: ["/admin/organogram"], upperRow: ["/admin/organogram"] }))),
      ["/admin/organogram"],
      "a conflict against the DEFAULT rows is found",
    );
    assert.deepEqual(
      stripRowConflicts(
        placementOf(
          layout({
            strip: ["/admin/organogram"],
            moduleRows: { people: { upperRow: [], lowerRow: ["/admin/organogram"] } },
          }),
        ),
      ),
      ["/admin/organogram"],
      "a conflict against a module override is found, in either row",
    );
    assert.deepEqual(
      stripRowConflicts(
        placementOf(layout({ strip: ["/admin/organogram", "/admin/organogram"], upperRow: ["/admin/organogram"] })),
      ),
      ["/admin/organogram"],
      "a page is reported once however many times the strip lists it",
    );
  }

  // ── What is NOT a conflict, and must never be "fixed" into one ──────────────────────────────
  // The rule is narrower than "no href twice". Widening it would break arrangements that work: a
  // module override REPLACES the defaults rather than adding to them, so two row sets that never
  // resolve together cannot contradict each other, and a page in a row still belongs to its sidebar
  // section everywhere outside that module.
  {
    assert.deepEqual(
      stripRowConflicts(
        placementOf(
          layout({
            strip: [],
            upperRow: ["/admin/organogram"],
            moduleRows: {
              sales: { upperRow: ["/admin/organogram"], lowerRow: [] },
              people: { upperRow: ["/admin/organogram"], lowerRow: [] },
            },
            sections: [{ id: "people", label: "People", items: ["/admin/organogram"] }],
          }),
        ),
      ),
      [],
      "defaults, two module overrides and a sidebar section may all list one page: none of them collide",
    );

    // And prove it renders, rather than only that the checker stays quiet about it.
    const shared = layout({
      upperRow: ["/admin/organogram"],
      moduleRows: { sales: { upperRow: ["/admin/targets"], lowerRow: [] } },
      sections: [{ id: "people", label: "People", items: ["/admin/organogram", "/admin/employees"] }],
    });
    assert.deepEqual(
      applyPersonalLayout(gated, shared, "sales").upperRow.map((i) => i.href),
      ["/admin/targets"],
      "inside a module with its own rows, the override replaces the defaults",
    );
    assert.deepEqual(
      applyPersonalLayout(gated, shared, "people").upperRow.map((i) => i.href),
      ["/admin/organogram"],
      "in a module without its own rows, the defaults still apply",
    );
  }

  // ── Releasing sweeps every row set, not just the one on screen ──────────────────────────────
  // The strip applies in EVERY module, so pinning a page there has to clear it out of arrangements
  // the editor is not currently showing. A copy left behind in some other module would be dead the
  // moment it was written — the same silent-empty-row failure, one module over.
  {
    const placement = placementOf(
      layout({
        strip: [],
        upperRow: ["/admin/organogram", "/admin/sales"],
        moduleRows: {
          sales: { upperRow: ["/admin/organogram"], lowerRow: ["/admin/targets"] },
          people: { upperRow: [], lowerRow: ["/admin/organogram"] },
        },
      }),
    );
    const swept = rowsWithout(placement, ["/admin/organogram"]);
    assert.deepEqual(swept.rows.upperRow, ["/admin/sales"], "the default rows lose it");
    assert.deepEqual(swept.moduleRows.sales.upperRow, [], "an override the caller was not looking at loses it too");
    assert.deepEqual(swept.moduleRows.sales.lowerRow, ["/admin/targets"], "and nothing else is touched");
    assert.deepEqual(swept.moduleRows.people.lowerRow, [], "in whichever of the two rows it sat");

    assert.deepEqual(
      stripWithout(placementOf(layout({ strip: ["/admin/sales", "/admin/organogram"] })), ["/admin/organogram"]),
      ["/admin/sales"],
      "releasing from the strip keeps the order of everything that stays",
    );
  }

  // placementOf must read a document saved before the rows existed. The one row in production is
  // that shape, and a throw here would be a 500 on the screen whose only job is saving.
  {
    const placement = placementOf(legacyLayout({ strip: ["/admin/organogram"] }) as PersonalNavigationLayout);
    assert.deepEqual(placement.rows, { upperRow: [], lowerRow: [] }, "a pre-rows document reads as two empty rows");
    assert.deepEqual(placement.moduleRows, {}, "and no module overrides");
    assert.deepEqual(stripRowConflicts(placement), [], "so it can hold no conflict");
  }


  // ── Repairing a stored contradiction, and the trap inside the repair ────────────────────────
  //
  // Clearing the dead row entries is render-neutral: they could not appear, so removing them
  // changes nothing on screen. But a module override REPLACES the defaults, so an override left
  // holding two empty rows shows NO rows in that module — and the obvious next move, sending the
  // page from the strip down to the default Upper nav row, would then work everywhere except the
  // modules he had been trying to arrange. This is the owner's own saved layout, verbatim.
  {
    const his = layout({
      strip: ["/admin/organogram"],
      upperRow: [],
      moduleRows: {
        sales: { upperRow: ["/admin/organogram"], lowerRow: [] },
        people: { upperRow: ["/admin/organogram"], lowerRow: [] },
      },
    });
    const repaired = resolveStripConflicts(placementOf(his));
    assert.deepEqual(repaired.conflicts, ["/admin/organogram"], "the contradiction is named, not swallowed");
    assert.deepEqual(
      repaired.moduleRows,
      {},
      "an override the clearing emptied is dropped, so the module falls back to the defaults",
    );

    // The whole point of dropping it: the follow-up move now reaches those modules.
    const afterHisNextMove = layout({ strip: [], upperRow: ["/admin/organogram"], moduleRows: repaired.moduleRows });
    for (const moduleId of ["sales", "people"]) {
      assert.deepEqual(
        applyPersonalLayout(gated, afterHisNextMove, moduleId).upperRow.map((i) => i.href),
        ["/admin/organogram"],
        `moving it out of the strip must reach ${moduleId} — the module he was arranging`,
      );
    }
  }

  // A deliberately empty override is NOT the same thing and must survive: "no rows in this module"
  // is a real choice, and nothing about it contradicts the strip.
  {
    const repaired = resolveStripConflicts(
      placementOf(
        layout({
          strip: ["/admin/organogram"],
          moduleRows: {
            sales: { upperRow: [], lowerRow: [] },
            people: { upperRow: ["/admin/organogram", "/admin/employees"], lowerRow: [] },
          },
        }),
      ),
    );
    assert.deepEqual(repaired.moduleRows.sales, { upperRow: [], lowerRow: [] }, "an already-empty override is kept");
    assert.deepEqual(
      repaired.moduleRows.people,
      { upperRow: ["/admin/employees"], lowerRow: [] },
      "an override that still holds something keeps it, minus the entry that could never render",
    );
  }

  // A clean document must come back untouched — the repair may never be a silent rewrite.
  {
    const clean = layout({
      strip: ["/admin/sales"],
      upperRow: ["/admin/organogram"],
      moduleRows: { people: { upperRow: ["/admin/employees"], lowerRow: [] } },
    });
    const repaired = resolveStripConflicts(placementOf(clean));
    assert.deepEqual(repaired.conflicts, [], "nothing to report");
    assert.deepEqual(repaired.rows, { upperRow: ["/admin/organogram"], lowerRow: [] }, "the rows are unchanged");
    assert.deepEqual(repaired.moduleRows, { people: { upperRow: ["/admin/employees"], lowerRow: [] } }, "so are the overrides");
  }

  // ── The editor must enforce what the renderer enforces ──────────────────────────────────────
  // Pinned by source, not behaviour, and deliberately: sidebar-layout-editor.tsx is a client
  // component with JSX, which the test runner's type stripping cannot import. That is exactly why
  // the rule itself lives in personal-layout.ts, where the assertions above can reach it — these
  // three only check that the editor still calls it.
  {
    const editor = readFileSync("src/components/admin/sidebar-layout-editor.tsx", "utf8");
    assert.ok(
      /return enforceOneZone\(next, to, activeId\);/.test(editor),
      "every move must go through enforceOneZone, or the editor can save a layout that renders nothing",
    );
    assert.ok(
      /const unavailable = new Set\(\[[^\]]*current\.strip[^\]]*\]\)/.test(editor),
      "the pool must not offer a page the strip already holds",
    );
    assert.ok(
      /containerId=\{STRIP\}/.test(editor),
      "module scope must show the Top strip: a zone that silently outranks the one being edited has to be visible",
    );
  }

  // ── The rows' "+" — pinHrefToRow and unpinHrefFromRows ───────────────────────────────────────
  // Owner, 2026-08-28: pressing "+" and choosing a page makes it "embedded like the organogram",
  // i.e. fixed in EVERY module. Each assertion below is one of the ways a naive append would have
  // produced a 200 OK that changed nothing on screen.

  // Nothing saved yet: the function has to invent a whole valid document, not patch a null.
  {
    const next = pinHrefToRow(null, "/admin/organogram");
    assert.equal(next.version, PERSONAL_LAYOUT_VERSION, "a fresh document carries the current version");
    assert.deepEqual(next.upperRow, ["/admin/organogram"], "the page lands in the upper row");
    assert.ok(
      isPersonalNavigationLayout(next),
      "the PUT route validates with isPersonalNavigationLayout, so an invalid document would 400",
    );
  }

  // TRAP 1 — the strip outranks the row. Adding to the row without releasing the strip entry saves
  // cleanly and renders nothing new; this is the failure the owner actually hit.
  {
    const next = pinHrefToRow(layout({ strip: ["/admin/organogram", "/admin/sales"] }), "/admin/organogram");
    assert.deepEqual(next.strip, ["/admin/sales"], "the strip releases the page");
    assert.deepEqual(next.upperRow, ["/admin/organogram"], "and the row takes it");
    assert.deepEqual(
      applyPersonalLayout(gated, next).upperRow.map((i) => i.href),
      ["/admin/organogram"],
      "so it actually RENDERS in the row — the assertion the strip conflict used to break",
    );
  }

  // TRAP 2 — a module override REPLACES the defaults. Appending only to the default upperRow would
  // skip exactly the modules the viewer had already arranged.
  {
    const next = pinHrefToRow(
      layout({
        upperRow: ["/admin/sales"],
        moduleRows: {
          people: { upperRow: ["/admin/employees"], lowerRow: [] },
          sales: { upperRow: [], lowerRow: ["/admin/targets"] },
        },
      }),
      "/admin/organogram",
    );
    assert.deepEqual(next.upperRow, ["/admin/sales", "/admin/organogram"], "the default row gains it");
    assert.deepEqual(
      next.moduleRows?.people,
      { upperRow: ["/admin/employees", "/admin/organogram"], lowerRow: [] },
      "and so does an override that already had a row",
    );
    assert.deepEqual(
      next.moduleRows?.sales,
      { upperRow: ["/admin/organogram"], lowerRow: ["/admin/targets"] },
      "and one whose upper row was empty",
    );
    for (const moduleId of [null, "people", "sales", "nonexistent"]) {
      assert.ok(
        applyPersonalLayout(gated, next, moduleId).upperRow.some((i) => i.href === "/admin/organogram"),
        `it renders in every module — module ${moduleId ?? "(none)"} is missing it`,
      );
    }
  }

  // TRAP 3 — a page cannot sit in both rows, and a hidden page must come back when pinned.
  {
    const next = pinHrefToRow(
      layout({ lowerRow: ["/admin/organogram", "/admin/targets"], hidden: ["/admin/organogram"] }),
      "/admin/organogram",
    );
    assert.deepEqual(next.lowerRow, ["/admin/targets"], "the lower row releases it");
    assert.deepEqual(next.hidden, [], "and it is no longer hidden");
    assert.deepEqual(next.upperRow, ["/admin/organogram"], "the upper row has it");
  }

  // Pressing "+" twice on the same page must not put two identical tabs in the row.
  {
    const once = pinHrefToRow(layout({ upperRow: ["/admin/sales"] }), "/admin/organogram");
    const twice = pinHrefToRow(once, "/admin/organogram");
    assert.deepEqual(twice.upperRow, ["/admin/sales", "/admin/organogram"], "no duplicate, and no reordering");
    assert.deepEqual(twice, once, "the second press is a no-op on the whole document");
  }

  // The `sections` list is left alone on purpose: a row entry outranks a section entry, so the
  // section copy is inert while pinned, and is where the page returns to if it comes off the row.
  {
    const before = layout({ sections: [{ id: "people", label: "People", items: ["/admin/organogram"] }] });
    const next = pinHrefToRow(before, "/admin/organogram");
    assert.deepEqual(next.sections, before.sections, "the section entry survives the pin");
    const rendered = applyPersonalLayout(gated, next);
    assert.deepEqual(
      rendered.sections.flatMap((s) => s.items.map((i) => i.href)).sort(),
      ["/admin/employees", "/admin/sales", "/admin/targets"],
      "and the row still wins: the page is claimed by the row, so no section renders it as well",
    );
    assert.deepEqual(
      rendered.upperRow.map((i) => i.href),
      ["/admin/organogram"],
      "it appears exactly once, in the row",
    );
  }

  // The LOWER row's "+" writes the same document through the same function, and pinning DOWN a page
  // that is currently up top is a MOVE, not a duplicate — the owner's "freely able to exchange tabs
  // that appeared either above or either down", now reachable without opening the editor.
  {
    const down = pinHrefToRow(
      layout({
        upperRow: ["/admin/organogram"],
        moduleRows: { sales: { upperRow: ["/admin/organogram"], lowerRow: [] } },
      }),
      "/admin/organogram",
      "lowerRow",
    );
    assert.deepEqual(down.lowerRow, ["/admin/organogram"], "the lower row takes it");
    assert.deepEqual(down.upperRow, [], "and the upper row releases it — a move, not a copy");
    assert.deepEqual(
      down.moduleRows?.sales,
      { upperRow: [], lowerRow: ["/admin/organogram"] },
      "including inside a module override, which would otherwise keep the old placement",
    );
    const rendered = applyPersonalLayout(gated, down);
    assert.deepEqual(rendered.lowerRow.map((i) => i.href), ["/admin/organogram"], "it renders below");
    assert.deepEqual(rendered.upperRow, [], "and no longer above");
  }

  // ── Removal — the tick in the same panel ────────────────────────────────────────────────────
  // Without this the "+" was a one-way door: the only way back out of a row was /admin/sidebar-layout,
  // which is the exact trip the "+" exists to save.
  {
    const on = pinHrefToRow(
      layout({
        moduleRows: {
          people: { upperRow: ["/admin/employees"], lowerRow: [] },
          sales: { upperRow: [], lowerRow: ["/admin/targets"] },
        },
      }),
      "/admin/organogram",
    );
    const off = unpinHrefFromRows(on, "/admin/organogram");
    assert.deepEqual(off.upperRow, [], "the default row releases it");
    assert.deepEqual(off.hidden, [], "removal never HIDES a page — it puts it back, it does not bury it");
    for (const moduleId of [null, "people", "sales", "nonexistent"]) {
      const applied = applyPersonalLayout(gated, off, moduleId);
      const inRows = [...applied.upperRow, ...applied.lowerRow].some((i) => i.href === "/admin/organogram");
      assert.ok(!inRows, `still on a row in module ${moduleId ?? "(none)"} — pinning wrote every override, so removal must clear every one`);
      assert.ok(
        applied.sections.some((s) => s.items.some((i) => i.href === "/admin/organogram")),
        `the page vanished entirely in module ${moduleId ?? "(none)"} — taking a tab off a row must return it to the sidebar, never make it unreachable`,
      );
    }
  }

  // It clears the lower row too, and leaves that row's other tabs alone.
  {
    const off = unpinHrefFromRows(
      layout({ lowerRow: ["/admin/organogram", "/admin/targets"] }),
      "/admin/organogram",
    );
    assert.deepEqual(off.lowerRow, ["/admin/targets"], "only the named page comes off");
  }

  // Pin-then-unpin is NOT a full round trip, deliberately: the strip entry pinning released (trap 1)
  // is not reconstructable, because the document does not record where an href came from. Documented
  // in unpinHrefFromRows — the page is still reachable, in the sidebar.
  {
    const after = unpinHrefFromRows(
      pinHrefToRow(layout({ strip: ["/admin/organogram"] }), "/admin/organogram"),
      "/admin/organogram",
    );
    assert.deepEqual(after.strip, [], "the strip entry stays released");
    assert.ok(
      applyPersonalLayout(gated, after).sections.some((s) =>
        s.items.some((i) => i.href === "/admin/organogram"),
      ),
      "and the page is back in the sidebar, so nothing was lost",
    );
  }

  // A null layout cannot happen from the panel (you can only remove what is pinned) but must still
  // produce a document the PUT route accepts rather than throwing.
  {
    const off = unpinHrefFromRows(null, "/admin/organogram");
    assert.ok(isPersonalNavigationLayout(off), "a valid empty document");
    assert.deepEqual(off.upperRow, [], "with nothing in it");
  }

  // ── REORDERING — placeHrefInRow and rowPositionOf ────────────────────────────────────────────
  // The write behind dragging a tab, the right-click move items, and the arrow-key reorder.
  {
    const before = layout({ upperRow: ["/admin/sales", "/admin/targets", "/admin/employees"] });
    const moved = placeHrefInRow(before, null, "/admin/employees", "upperRow", 0);
    assert.deepEqual(
      moved.upperRow,
      ["/admin/employees", "/admin/sales", "/admin/targets"],
      "a page dragged to the front lands at the front",
    );
    assert.ok(isPersonalNavigationLayout(moved), "and the result is a document the PUT route accepts");
  }

  // The index means "where it ends up", not "where it was aimed before the old copy shifted things".
  // Dragging the FIRST tab to index 2 of the same row must leave it third, not second — this is the
  // off-by-one that makes a same-row drag land one slot early.
  {
    const before = layout({ upperRow: ["/admin/sales", "/admin/targets", "/admin/employees"] });
    const moved = placeHrefInRow(before, null, "/admin/sales", "upperRow", 2);
    assert.deepEqual(
      moved.upperRow,
      ["/admin/targets", "/admin/employees", "/admin/sales"],
      "removal happens before insertion, so a same-row drag lands where the pointer is",
    );
  }

  // Dragging ACROSS the two rows: it leaves the row it came from in the same write.
  {
    const before = layout({ upperRow: ["/admin/sales", "/admin/targets"], lowerRow: ["/admin/employees"] });
    const moved = placeHrefInRow(before, null, "/admin/targets", "lowerRow", 0);
    assert.deepEqual(moved.upperRow, ["/admin/sales"], "the source row releases it");
    assert.deepEqual(moved.lowerRow, ["/admin/targets", "/admin/employees"], "the target row takes it at the index");
  }

  // An out-of-range index appends rather than throwing or dropping the page — a drag past the last
  // tab is a real gesture, not an error.
  {
    const before = layout({ upperRow: ["/admin/sales"] });
    assert.deepEqual(
      placeHrefInRow(before, null, "/admin/targets", "upperRow", 99).upperRow,
      ["/admin/sales", "/admin/targets"],
      "an index past the end appends",
    );
    assert.deepEqual(
      placeHrefInRow(before, null, "/admin/targets", "upperRow", -5).upperRow,
      ["/admin/targets", "/admin/sales"],
      "a negative index clamps to the front",
    );
  }

  // THE SCOPING RULE, and the reason this is not pinHrefToRow with an index. Reordering inside a
  // module that has its OWN rows must edit that override and leave the defaults — and every other
  // module's override — alone. Getting this wrong reshuffles modules the owner is not looking at.
  {
    const before = layout({
      upperRow: ["/admin/sales", "/admin/targets"],
      moduleRows: {
        people: { upperRow: ["/admin/employees", "/admin/organogram"], lowerRow: [] },
        sales: { upperRow: ["/admin/targets", "/admin/sales"], lowerRow: [] },
      },
    });
    const moved = placeHrefInRow(before, "people", "/admin/organogram", "upperRow", 0);
    assert.deepEqual(
      moved.moduleRows?.people?.upperRow,
      ["/admin/organogram", "/admin/employees"],
      "the module being looked at is the one that reorders",
    );
    assert.deepEqual(
      moved.upperRow,
      ["/admin/sales", "/admin/targets"],
      "the DEFAULT rows are untouched — they are not what was on screen",
    );
    assert.deepEqual(
      moved.moduleRows?.sales?.upperRow,
      ["/admin/targets", "/admin/sales"],
      "and another module's override is untouched — a drag is never company-wide",
    );
  }

  // The mirror of the rule: inside a module with NO override, the defaults ARE what renders, so the
  // defaults are what must change. Writing an override here would silently freeze this module away
  // from the defaults as a side effect of a drag.
  {
    const before = layout({ upperRow: ["/admin/sales", "/admin/targets"] });
    const moved = placeHrefInRow(before, "people", "/admin/targets", "upperRow", 0);
    assert.deepEqual(moved.upperRow, ["/admin/targets", "/admin/sales"], "the defaults reorder");
    assert.deepEqual(
      moved.moduleRows ?? {},
      {},
      "and no override is invented — a drag must not create module scoping nobody asked for",
    );
  }

  // Trap 1 again, from the new door: the strip resolves BEFORE the rows, so a page left in both
  // renders in the strip and the row comes back empty. Placing must release the strip, exactly as
  // pinning does — and the proof is that the page actually renders in the row afterwards.
  {
    const moved = placeHrefInRow(
      layout({ strip: ["/admin/organogram"], upperRow: ["/admin/sales"] }),
      null,
      "/admin/organogram",
      "upperRow",
      0,
    );
    assert.deepEqual(moved.strip, [], "the strip releases the page");
    assert.deepEqual(
      applyPersonalLayout(gated, moved).upperRow.map((i) => i.href),
      ["/admin/organogram", "/admin/sales"],
      "so the row it was dragged into actually renders it",
    );
  }

  // rowPositionOf answers "can this move left" once, for both the drag handler and the menu.
  {
    const doc = layout({ upperRow: ["/admin/sales", "/admin/targets"], lowerRow: ["/admin/employees"] });
    assert.deepEqual(rowPositionOf(doc, null, "/admin/targets"), { row: "upperRow", index: 1 });
    assert.deepEqual(rowPositionOf(doc, null, "/admin/employees"), { row: "lowerRow", index: 0 });
    assert.equal(rowPositionOf(doc, null, "/admin/organogram"), null, "a page on neither row is null");
    // It must read the SAME resolved set placeHrefInRow writes, or the menu offers moves that do
    // nothing. Inside a module with an override, that is the override.
    const scoped = layout({
      upperRow: ["/admin/sales"],
      moduleRows: { people: { upperRow: ["/admin/employees"], lowerRow: [] } },
    });
    assert.deepEqual(rowPositionOf(scoped, "people", "/admin/employees"), { row: "upperRow", index: 0 });
    assert.equal(rowPositionOf(scoped, "people", "/admin/sales"), null, "the override REPLACES the defaults");
  }

  // ── The "+" must be wired to those functions, and offer only gated pages ─────────────────────
  // Source-pinned for the same reason as the editor checks above: both components are JSX, which
  // the runner's type stripping cannot import.
  {
    const button = readFileSync("src/components/layout/nav-row-add-button.tsx", "utf8");
    assert.ok(
      /pinHrefToRow\(current, href, target\)/.test(button),
      "the + must write through pinHrefToRow, or it re-opens all three traps above",
    );
    assert.ok(
      /unpinHrefFromRows\(current, href\)/.test(button),
      "and the tick must write through unpinHrefFromRows, or removal misses the module overrides",
    );
    assert.ok(
      /method: "PUT"/.test(button) && /router\.refresh\(\)/.test(button),
      "a save that never refreshes leaves the row unchanged on screen — the original complaint",
    );

    const rows = readFileSync("src/components/layout/horizontal-nav-rows.tsx", "utf8");
    assert.ok(
      /const addableFor = \(row: readonly NavigationSectionItem\[\]\)/.test(rows),
      "the picker must be built from the GATED sets, so it can no more introduce an href than applyPersonalLayout can",
    );
    // 2026-09-02. The picker offers the whole catalogue — rail sections AND hub cards — and the
    // same hub items are handed to applyPersonalLayout as its zone-only pool. Both lines, because
    // either one alone is a defect: offering without resolving saves and shows nothing, and
    // resolving without offering leaves the pages unreachable, which is the state he reported.
    assert.ok(
      rows.includes("mergeCatalogueSections(gated, hubSections)"),
      "the + must offer the hub cards too — 'I want all pages to appear' (owner, 2026-09-02) — and MERGED by label, or the panel grows a second heading per module",
    );
    assert.ok(
      rows.includes("applyPersonalLayout(gated, layout, activeModuleId, hubItems)"),
      "and the same hub items must reach applyPersonalLayout, or adding one saves a 200 and moves nothing on screen",
    );
    // REPOINTED when the row reached the employee portal. The property these two pin is unchanged
    // — the "+" and the layout behind it must reach exactly the surfaces that carry rows, and the
    // same predicate must decide both, or a mode gets a "+" with nothing behind it. What changed is
    // that the predicate is no longer `usesAdminChrome`: that one answers a PALETTE question, and
    // the portal carries rows without wearing admin chrome. Written with `includes` rather than a
    // regex so the pin has no escaping to get wrong.
    assert.ok(
      rows.includes("canAdd: carriesNavRows(navigationMode),"),
      "the + reaches every surface that carries rows — admin, hr, and the employee portal",
    );
    assert.ok(
      rows.includes("const layout = carriesNavRows(navigationMode) ? personalLayout : null;"),
      "the layout itself must reach the same modes on the same test, or a surface gets a + with nothing behind it",
    );
    assert.ok(
      /if \(items\.length === 0 && !keepWhenEmpty\) return null;/.test(rows),
      "an empty row renders nothing UNLESS this viewer has a layout — otherwise a lone + appears on 243 pages for 158 people who never asked for it",
    );
    // `alwaysOfferAdd` (2026-09-01, removed same day) forced both rows open EMPTY on the portal, so
    // an account with no saved layout got two full-width "+"-only bars stacked above the dashboard —
    // reported as clutter the day it shipped. `keepWhenEmpty` is uniform across every mode now; the
    // portal got a compact header “+” instead — which then went too, along with the rows
    // themselves, when the owner removed them from the portal on 2026-09-03.
    // AND THEN THE ROWS THEMSELVES WENT, on 2026-09-03. The owner had them taken off the portal
    // that morning ("remove it totally"), then named the HR one from its own tab labels - "My
    // pages / My Calendar / Payslips / ... REMOVE THIS NAV BAR" - so NOTHING passes keepWhenEmpty
    // any more, and an empty row is simply absent in admin and HR as well as the portal.
    //
    // INVERTED rather than deleted, because the guard asserted just above is still what decides
    // whether the bar exists at all. THE CONSEQUENCE IS REAL AND WAS ACCEPTED: a viewer who unpins
    // the last tab from a row loses the row and the "+" that lived in it, so there is no way back
    // through the UI - those pages stay reachable from the sidebar and at their own URLs. A future
    // session that reintroduces the rows turns this red, and should read this before changing it.
    assert.equal(
      rows.split("keepWhenEmpty={").length - 1,
      0,
      "nothing may pass keepWhenEmpty - an empty nav row is absent, by the owner’s 2026-09-03 call",
    );
    assert.ok(
      !/alwaysOfferAdd\s*[:?]/.test(rows),
      "alwaysOfferAdd forced two empty full-width bars onto the portal — the FIELD must not come back (mentioning its name in a comment, to explain why, is fine)",
    );
    assert.ok(
      /target="upperRow"/.test(rows) && /target="lowerRow"/.test(rows),
      "each row's + writes its OWN row",
    );
    // Prop-TOLERANT on purpose. This pinned the call verbatim until 2026-09-04, when the badge
    // gained a `dark` prop so it could ring itself in the rail's own background instead of
    // assuming the dark one — and this assertion went red for a change that did exactly what it
    // asks for. What it means to pin is that a pinned tab renders the badge, expanded, for its
    // own item; the prop LIST is not the contract, so match the parts that are.
    assert.ok(
      /<ApprovalNavBadge[^>]*compact=\{false\}[^>]*navBadge=\{item\.navBadge\}[^>]*\/>/.test(rows),
      "a tab pinned into a row must not be the one place a pending count is invisible",
    );
  }

  // ── THE ZONE-ONLY POOL — hub cards are placeable, and never widen the rail ───────────────────
  // 2026-09-02, the owner on the "+": "some pages are compacted and not appearing. I want all pages
  // to appear… Any page I have, appear in the add and I can add it."
  //
  // Most admin modules are collapsed to ONE hub button, with their real pages living as cards on
  // that hub page rather than as rows in the rail. So the picker has to offer a set WIDER than the
  // sidebar — and the moment it does, the second half becomes load-bearing: a page the "+" offers
  // but `applyPersonalLayout` cannot resolve saves a 200 and changes nothing on screen, which is
  // the exact failure this whole feature was born out of.
  //
  // The pool is deliberately asymmetric. It feeds the three ZONES and is invisible to the leftovers
  // pass, so a hub card appears in a row because the viewer put it there and never turns up in the
  // sidebar on its own. Both halves are pinned here, and the second is the one that would rot.
  {
    const hubCards: readonly NavigationSectionItem[] = [
      item("/admin/employees/contracts", "Contract Renewal"),
      item("/admin/employees/retention", "Retention Register"),
    ];

    // Half one: a page outside every gated section resolves when the layout names it.
    const placed = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/employees/contracts"], lowerRow: ["/admin/sales"] }),
      null,
      hubCards,
    );
    assert.deepEqual(
      placed.upperRow.map((i) => i.href),
      ["/admin/employees/contracts"],
      "a hub card the viewer added to a row must actually render there — otherwise the + saves and the screen does not move",
    );
    assert.deepEqual(
      placed.lowerRow.map((i) => i.href),
      ["/admin/sales"],
      "the rail's own pages keep resolving alongside it",
    );

    // Half two, and the one that would rot: it must NOT reach the sidebar. The leftovers pass walks
    // the gated sections alone, which is what keeps the collapsed rail collapsed.
    const sidebarHrefs = placed.sections.flatMap((section) => section.items.map((i) => i.href));
    assert.ok(
      !sidebarHrefs.includes("/admin/employees/contracts"),
      "a placed hub card must not ALSO appear in the sidebar",
    );
    assert.ok(
      !sidebarHrefs.includes("/admin/employees/retention"),
      "and an UNPLACED hub card must not appear in the sidebar either — the pool widens the picker, never the rail",
    );

    // An unplaced pool item renders nowhere at all. Stated separately from the sidebar check
    // because "not in the rail" and "not on screen" are different claims.
    const unplaced = [
      ...placed.strip,
      ...placed.upperRow,
      ...placed.lowerRow,
      ...placed.sections.flatMap((section) => section.items),
    ].map((i) => i.href);
    assert.ok(
      !unplaced.includes("/admin/employees/retention"),
      "a pool page the layout never names is invisible — the pool is a resolution source, not a second rail",
    );

    // The strip takes them too, on the same terms.
    const stripped = applyPersonalLayout(
      gated,
      layout({ strip: ["/admin/employees/retention"] }),
      null,
      hubCards,
    );
    assert.deepEqual(
      stripped.strip.map((i) => i.href),
      ["/admin/employees/retention"],
      "the strip resolves a hub card as readily as either row",
    );

    // The rail's copy wins a collision. A page holding BOTH a rail row and a hub card must resolve
    // to the rail's item, which is the one carrying that section's label and badge.
    const collided = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/sales"] }),
      null,
      [item("/admin/sales", "Sales (hub card copy)")],
    );
    assert.equal(
      collided.upperRow[0]?.label,
      "Sales",
      "the gated rail item outranks a same-href pool entry — the pool is added second on purpose",
    );

    // And the security invariant is unchanged: the pool is gated input, so it can widen what a
    // layout RESOLVES but a layout still cannot name a page that is in neither source.
    const forged = applyPersonalLayout(
      gated,
      layout({ upperRow: ["/admin/payroll-secrets"] }),
      null,
      hubCards,
    );
    assert.deepEqual(
      forged.upperRow,
      [],
      "a layout naming a page in neither the gated sections nor the pool still resolves to nothing",
    );
  }

  // ── ONE badge switch, not a copy per surface ─────────────────────────────────────────────────
  // The sidebar, the nav rows and (next) the portal all read the same map from navBadge value to
  // counting endpoint. A hand-written second copy is how #2237's Capture Evidence shipped green and
  // rejected 59 of its 65 customers: one omitted entry in one duplicated list, no error anywhere.
  {
    const badge = readFileSync("src/components/layout/nav-badge.tsx", "utf8");
    assert.ok(
      /export function NavBadge\(/.test(badge) && /export function ApprovalNavBadge\(/.test(badge),
      "both live in the shared module",
    );
    const sidebar = readFileSync("src/components/layout/sidebar.tsx", "utf8");
    assert.ok(
      !/function ApprovalNavBadge\(/.test(sidebar),
      "the sidebar must IMPORT the switch, never redeclare one of its own",
    );
    assert.ok(
      /from "@\/components\/layout\/nav-badge"/.test(sidebar),
      "and it must import it from the shared module",
    );

    // Completeness: every navBadge value the navigation config declares has a case in the switch.
    // Without this the omission is silent — the badge simply never renders, which is indistinguishable
    // from a queue that happens to be empty.
    // Completeness, keyed on the TYPE UNION rather than on today's declarations. Two of the eight
    // values are currently assignable but unused (`direct-orders-approvals-pending` and
    // `direct-orders-unbooked`, both folded into the one Direct Orders row), so a check driven by
    // the seeds alone would pass while a case for either was deleted — measured: it did.
    // Without this the omission is silent either way. The badge simply never renders, which is
    // indistinguishable from a queue that happens to be empty.
    const navConfig = readFileSync("src/config/system-navigation.ts", "utf8");
    const union = navConfig.match(/navBadge\?:\s*((?:"[a-z0-9-]+"\s*\|\s*)*"[a-z0-9-]+")\s*;/);
    assert.ok(union, "the navBadge union is no longer where this test reads it from");
    const allowed = Array.from(union[1].matchAll(/"([a-z0-9-]+)"/g), (m) => m[1]);
    assert.ok(
      allowed.length >= 8,
      `only ${allowed.length} navBadge values parsed out of the union — the regex has stopped matching, so the loop below proves nothing`,
    );
    for (const value of allowed) {
      assert.ok(
        badge.includes(`case "${value}":`),
        `nav-badge.tsx has no case for navBadge "${value}" — that tab would show no count at all, on every surface`,
      );
    }
    // And nothing is assigned that the union does not allow, which is what keeps the check honest.
    for (const [, value] of navConfig.matchAll(/navBadge:\s*"([a-z0-9-]+)"/g)) {
      assert.ok(allowed.includes(value), `a nav item declares navBadge "${value}", which is not in the union`);
    }
  }
  // ── The company default layout ─────────────────────────────────────────────────────────────
  //
  // One reserved row in nav_personal_layout holds the arrangement that everybody who has saved
  // nothing falls back to. It ships with NO migration: the table is keyed by a bare
  // `hr_id text primary key` with no foreign key to employees, so a reserved key is already legal.
  //
  // Two properties carry the whole safety story and both are pinned below:
  //   1. No PERSON can ever resolve to that row (or a personal save rewrites everyone's nav).
  //   2. A published default never overwrites a saved personal layout (or publishing destroys work).
  {
    // The table CHECKs `hr_id = lower(hr_id)`. A sentinel that fails it would make every publish
    // die at the database with a constraint error, which is a deploy-time failure nothing catches.
    assert.equal(
      COMPANY_DEFAULT_LAYOUT_KEY,
      COMPANY_DEFAULT_LAYOUT_KEY.toLowerCase(),
      "the company-default key must be lowercase or the table's own CHECK rejects every publish",
    );
    assert.ok(
      COMPANY_DEFAULT_LAYOUT_KEY.startsWith("__"),
      "the sentinel must sit outside the space of real hr_ids and login ids",
    );
    // layoutKeyFor is the normaliser both reads and writes go through. If it mangled the sentinel,
    // the writer and the reader would disagree and a published default would render for nobody.
    assert.equal(
      layoutKeyFor(COMPANY_DEFAULT_LAYOUT_KEY),
      COMPANY_DEFAULT_LAYOUT_KEY,
      "layoutKeyFor must round-trip the sentinel unchanged",
    );

    // THE GUARD THAT MATTERS. An account resolving to the sentinel would edit everybody's
    // navigation from the screen that promises it changes nobody else's.
    assert.equal(
      layoutOwnerKey({ hrId: COMPANY_DEFAULT_LAYOUT_KEY, loginId: null }),
      null,
      "layoutOwnerKey must refuse the company-default key, not hand it back as a personal identity",
    );
    assert.equal(
      layoutOwnerKey({ hrId: null, loginId: COMPANY_DEFAULT_LAYOUT_KEY.toUpperCase() }),
      null,
      "and it must refuse it through the login-id fallback too, in any casing",
    );
    // The ordinary path is untouched — a guard that also broke real accounts would be worse.
    assert.equal(layoutOwnerKey({ hrId: "HR042", loginId: "someone" }), "hr042");
    assert.equal(layoutOwnerKey({ hrId: null, loginId: "admin-HR" }), "admin-hr");
  }

  // The href cap is now SHARED by two write routes. A hand-copied second cap is how Capture
  // Evidence shipped rejecting 59 of the 65 customers it existed for, so this pins both that the
  // counter sees every zone and that neither route carries a local duplicate of it.
  {
    const full: PersonalNavigationLayout = {
      version: PERSONAL_LAYOUT_VERSION,
      strip: ["/a"],
      upperRow: ["/b"],
      lowerRow: ["/c"],
      moduleRows: { people: { upperRow: ["/d"], lowerRow: ["/e"] } },
      sections: [{ id: "s", label: "S", items: ["/f", "/g"] }],
      hidden: ["/h"],
    };
    assert.equal(
      countLayoutHrefs(full),
      8,
      "countLayoutHrefs must count every zone — a zone it forgets is a hole in the cap on BOTH routes",
    );
    // The module-row half is the part that grows with the number of modules rather than pages, so
    // it is the half worth proving separately: dropping it would leave the ceiling silently low.
    const withoutModules: PersonalNavigationLayout = { ...full, moduleRows: {} };
    assert.equal(countLayoutHrefs(withoutModules), 6, "module overrides must be inside the count");
    assert.ok(MAX_LAYOUT_HREFS >= 2000, "the shared ceiling must stay generous enough for real use");

    const personalRoute = readFileSync("app/api/navigation/personal-layout/route.ts", "utf8");
    const companyRoute = readFileSync("app/api/navigation/company-layout/route.ts", "utf8");
    for (const [name, source] of [["personal", personalRoute], ["company", companyRoute]] as const) {
      assert.ok(
        source.includes("countLayoutHrefs(layout) > MAX_LAYOUT_HREFS"),
        `the ${name} layout route must enforce the SHARED cap`,
      );
      assert.ok(
        !/function countHrefs\(/.test(source),
        `the ${name} layout route must not carry its own copy of the counter — that is the duplicate-list trap`,
      );
    }
  }

  // Source pins on the store. These are behaviours no unit test can reach without a database, and
  // each one, if it broke, would fail SILENTLY — the wrong menu, or a wide write, with no error.
  {
    const store = readFileSync("src/lib/navigation/personal-layout-store.ts", "utf8");

    // PERSONAL WINS. If this order inverted, publishing a company default would visually overwrite
    // every arrangement anyone had ever saved, while their row still sat in the table untouched.
    assert.ok(
      store.includes('if (personal) return { layout: personal, source: "personal" };'),
      "loadEffectiveLayout must return a personal layout before it ever looks at the company default",
    );

    // ONE round trip, not two. Two sequential awaits would double the shell's latency on every
    // admin page render for exactly the people who have no personal layout — nearly everyone.
    assert.ok(
      store.includes('.select("hr_id, layout").in("hr_id", keys)'),
      "loadEffectiveLayout must fetch both keys in a single query",
    );
    const effective = store.slice(store.indexOf("export async function loadEffectiveLayout"));
    const body = effective.slice(0, effective.indexOf("\n}\n"));
    assert.equal(
      (body.match(/await getSupabaseAdmin\(\)/g) ?? []).length,
      1,
      "loadEffectiveLayout must make exactly one database call — a fallback read is the thing it exists to avoid",
    );

    // The second of the two independent guards against a personal save reaching everybody.
    assert.ok(
      store.includes("if (key === COMPANY_DEFAULT_LAYOUT_KEY) {"),
      "savePersonalLayout must refuse the reserved key outright",
    );
    assert.ok(
      store.includes("if (!key || key === COMPANY_DEFAULT_LAYOUT_KEY) return;"),
      "clearPersonalLayout must refuse it too — otherwise a DELETE could withdraw the company default",
    );
  }

  // The route gate, the shell wiring, and the one client-bundle hazard this feature introduced.
  {
    const companyRoute = readFileSync("app/api/navigation/company-layout/route.ts", "utf8");
    // Server-side gate. Hiding the button is UX; this is the security boundary, and it is the whole
    // difference between "a Super Admin publishes a default" and "anyone signed in can".
    assert.ok(
      companyRoute.includes('if (access.role !== "Super Admin") {'),
      "the company-layout route must gate on Super Admin server-side",
    );
    // Guest first, or a signed-out caller gets a misleading 403 instead of 401. An unauthenticated
    // caller resolves to role "Employee" here, never null — `!access.role` is dead code repo-wide.
    assert.ok(
      companyRoute.indexOf('access.source === "guest"') < companyRoute.indexOf('access.role !== "Super Admin"'),
      "the guest check must come before the role check",
    );
    // Written as a real multi-line template rather than a regex: the CSRF assert has to be the
    // FIRST statement in the try, and an "is it somewhere in the file" check would pass even if it
    // sat after the write.
    for (const verb of ["PUT", "DELETE"]) {
      const opening = `export async function ${verb}(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);`;
      assert.ok(
        companyRoute.includes(opening),
        `${verb} on the company-layout route must assert same-origin before anything else`,
      );
    }

    // The PERSONAL route must never learn to name a target. The moment it takes a scope or an hrId
    // from the request, the narrow route becomes the wide one and the separate gate above is moot.
    const personalRoute = readFileSync("app/api/navigation/personal-layout/route.ts", "utf8");
    assert.ok(
      !/COMPANY_DEFAULT_LAYOUT_KEY|saveCompanyDefaultLayout|scope|hrId\?:/.test(personalRoute),
      "the personal-layout route must have no way to address the company default",
    );

    // The shell must read the EFFECTIVE layout, or a published default renders for nobody.
    const shell = readFileSync("src/components/layout/app-shell.tsx", "utf8");
    // Read beside the topbar's identity since 2026-10-16 (one round trip instead of two) — still the
    // EFFECTIVE layout, still under the session's own key, and still what the sidebar renders.
    // The same wave carries the mailbox connection and the push identity since 1 Nov 2026 (the shell
    // stopped chattering); the layout is still its first read.
    assert.ok(
      /const \[\{ layout: personalLayout \}, viewer(?:, \w+)*\] = await Promise\.all\(\[\s*loadEffectiveLayout\(layoutOwnerKey\(access\)\),/.test(shell),
      "the app shell must resolve the effective layout, not just the personal one",
    );

    // CLIENT BUNDLE HAZARD. The editor is a "use client" component; personal-layout-store imports
    // the service-role Supabase client. LayoutSource therefore lives in the pure module, and the
    // editor must import it from there. A type-only import erases, but the specifier is a live
    // module-graph edge that a later value import turns into a real server-code leak.
    const editor = readFileSync("src/components/admin/sidebar-layout-editor.tsx", "utf8");
    assert.ok(editor.startsWith('"use client";'), "the layout editor is a client component");
    assert.ok(
      !editor.includes("personal-layout-store"),
      "the client editor must never import the layout store — it pulls the service-role client into the browser graph",
    );
    assert.ok(
      editor.includes("type LayoutSource,") && editor.includes('} from "@/lib/navigation/personal-layout";'),
      "LayoutSource must reach the editor from the server-free module",
    );
    // The company controls are hidden for everyone else rather than shown disabled.
    assert.ok(
      editor.includes("{canManageCompanyDefault ? ("),
      "the company-default buttons must be gated on canManageCompanyDefault",
    );
    assert.ok(
      editor.includes('fetch("/api/navigation/company-layout", {') &&
        editor.includes('fetch("/api/navigation/company-layout", { method: "DELETE" })'),
      "publish and withdraw must both go to the company-layout route, never the personal one",
    );
  }

  // ── The row reaches the EMPLOYEE PORTAL ────────────────────────────────────────────────────
  // 116 accounts, 72% of everyone with a login, and until now the only workspace with no
  // arrangeable row at all.
  {
    // `carriesNavRows` and `usesAdminChrome` must stay two different questions. The first asks
    // whether a surface HAS rows; the second is a PALETTE question. The portal answers yes to one
    // and no to the other, so collapsing them would either paint the portal black or take its rows
    // away — and both read as a styling slip rather than the wiring mistake they would be.
    assert.equal(carriesNavRows("employee-portal"), true, "the portal carries rows");
    assert.equal(usesAdminChrome("employee-portal"), false, "…and is NOT dark chrome");
    for (const mode of ["admin", "hr"] as const) {
      assert.equal(carriesNavRows(mode), true, `${mode} carries rows`);
      assert.equal(usesAdminChrome(mode), true, `${mode} wears admin chrome`);
    }
    assert.equal(carriesNavRows(undefined), false, "an unset mode carries no rows");

    // THE SECURITY PROPERTY, tested rather than reasoned about. The portal hands its own gated
    // sections in, and a layout naming anything outside that set — an admin page, or a portal page
    // this viewer's visibility flags withheld — must render nothing. It is the same guarantee the
    // admin row has, and it is what makes ONE stored document safe across every mode.
    const portalGated: readonly NavigationSection[] = [
      { id: "my-workspace", label: "My Workspace", items: [item("/employee-portals", "Command Center")] },
    ];
    const portalApplied = applyPersonalLayout(
      portalGated,
      layout({ upperRow: ["/employee-portals", "/admin/employees", "/employee-portals/payslips"] }),
      null,
    );
    assert.deepEqual(
      portalApplied.upperRow.map((entry) => entry.href),
      ["/employee-portals"],
      "a portal row may carry only hrefs from the sections handed in — never an admin page, never a withheld portal page",
    );
  }

  // The portal's wiring — what is left of it. Until 2026-09-03 this block pinned three things:
  // that the portal shell read the effective layout inside its existing Promise.all (one
  // cross-Atlantic round trip, not two), that /payslips made the same read because it mounts the
  // chrome directly, and that the portal's compact header "+" existed at all, since the portal has
  // no /admin/sidebar-layout editor to reach `pinHrefToRow` from.
  //
  // All three described the arrangeable nav rows, and the owner removed those from the portal
  // outright: "never put anything above the identity banner … remove it totally." So the layout
  // read is gone from both files with them — including that Frankfurt round trip, which ran on
  // every portal page render — and there is no "+" left to need an entry point.
  //
  // What remains worth pinning is the negative: neither file may quietly grow the read back.
  {
    const portalShell = readFileSync("src/components/employee-portal/employee-portal-server-shell.tsx", "utf8");
    const payslipsPage = readFileSync("app/payslips/page.tsx", "utf8");
    for (const [path, source] of [
      ["src/components/employee-portal/employee-portal-server-shell.tsx", portalShell],
      ["app/payslips/page.tsx", payslipsPage],
    ] as const) {
      assert.ok(
        !/loadEffectiveLayout|personalLayout=/.test(source),
        `${path} reads the personal nav layout again. The portal has no arrangeable rows to render ` +
          "it into — owner rule, 2026-09-03 — so this is a cross-Atlantic round trip on every portal " +
          "page render, buying nothing. The ADMIN shell still reads it, and should.",
      );
    }

    // ONE list. buildEmployeePortalSections is what the sidebar, the top nav and the bottom nav all
    // read, so they cannot drift from each other. A hand-copied second list is how Capture Evidence
    // shipped rejecting 59 of the 65 customers it existed for.
    const portalLayout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
    assert.ok(
      /function buildEmployeePortalSections\(/.test(portalLayout),
      "the portal must still derive its navigation from one section builder, never a second list",
    );
    assert.ok(
      !/usePortalCompactNavAdd/.test(portalLayout),
      "the portal header renders the rows' add button again. There are no rows for it to add to.",
    );
  }
}
