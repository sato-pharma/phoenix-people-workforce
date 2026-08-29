import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { NavigationSection, NavigationSectionItem } from "../src/config/system-navigation.ts";
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
  placementOf,
  resolveRowSet,
  resolveStripConflicts,
  rowsWithout,
  stripRowConflicts,
  stripWithout,
  unpinHrefFromRows,
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
      "the picker must be built from the GATED sections, so it can no more introduce an href than applyPersonalLayout can",
    );
    assert.ok(
      /canAdd: usesAdminChrome\(navigationMode\)/.test(rows),
      "admin chrome — admin AND hr, the two workspaces that share this shell",
    );
    assert.ok(
      /const layout = usesAdminChrome\(navigationMode\) \? personalLayout : null;/.test(rows),
      "the layout itself must reach the same two modes, or hr gets a + with nothing behind it",
    );
    assert.ok(
      /if \(items\.length === 0 && !keepWhenEmpty\) return null;/.test(rows),
      "an empty row renders nothing UNLESS this viewer has a layout — otherwise a lone + appears on 243 pages for 158 people who never asked for it",
    );
    assert.equal(
      (rows.match(/keepWhenEmpty=\{canAdd && hasSavedLayout\}/g) ?? []).length,
      2,
      "both rows must survive being emptied, or the one you emptied has no way back",
    );
    assert.ok(
      /target="upperRow"/.test(rows) && /target="lowerRow"/.test(rows),
      "each row's + writes its OWN row",
    );
    assert.ok(
      /<ApprovalNavBadge compact=\{false\} navBadge=\{item\.navBadge\} \/>/.test(rows),
      "a tab pinned into a row must not be the one place a pending count is invisible",
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
    assert.ok(
      shell.includes("const { layout: personalLayout } = await loadEffectiveLayout(layoutOwnerKey(access));"),
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
}
