import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  adminHubPromotions,
  adminNavigationSectionSeeds,
  adminNavigationSections,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import {
  buildPermissionLookup,
  permissionMatrix,
  phoenixRoles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections, navigationItemVisible } from "../src/lib/navigation/active-path.ts";

/**
 * Every admin route whose page renders a hub card list, read off disk.
 *
 * The config cannot be asked this question. `adminHubPromotions` is a list of hubs SOMEONE
 * REMEMBERED, so every check written against it is blind in the one direction that matters: add a
 * hub page, give it a rail row, forget the promotion entry, and the door is back on the rail while
 * every assertion about "the hubs" passes, because that hub is not one of them. Measured: deleting
 * a promotion entry left this file green until this scan was added.
 *
 * A hub page is identifiable without the config — it is a page that imports one of the
 * `*PageItems` card arrays and renders it as a grid. That is what makes it a page of modules, and
 * it is the same property the owner's rule is about.
 */
function hubRoutesOnDisk(): string[] {
  const appRoot = path.join(process.cwd(), "app");
  const routes = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "page.tsx") continue;
      const source = readFileSync(full, "utf8");
      // Anchored to the IMPORT, not to the word: a page that merely mentions PageItems in a
      // comment is not a hub, and `[^}]` spans newlines so a multi-line import still matches.
      if (!/import\s*\{[^}]*PageItems[^}]*\}\s*from\s*"@\/config\/system-navigation"/.test(source)) {
        continue;
      }
      const segments = path.relative(appRoot, path.dirname(full)).split(path.sep);
      // Route groups — `(admin)` — are folders, not URL segments.
      routes.add(`/${segments.filter((segment) => !segment.startsWith("(")).join("/")}`);
    }
  };

  walk(appRoot);
  return [...routes].sort();
}

/**
 * The hub promotion, pinned: no rail row opens a page of modules, and nobody's rail moved.
 *
 * The owner's rule, 2026-09-05, in his words: "I don't want any subtitle to be the one that when I
 * press, it redirects me to a page that has big modules. I want a Recruitment and its modules under
 * it." `promoteHubRows` implements it by replacing each hub row with that hub's own cards under a
 * heading carrying the hub's name.
 *
 * That transformation is invisible in review and invisible in production. A rail still renders, CI
 * is still green, and the two ways it can be wrong both fail SILENTLY:
 *
 *   WIDENED  — a card's own gate is only half of what made it reachable before. The other half was
 *              being able to open the hub at all. Dropping that hands a seat rows it never had:
 *              measured across all 17 roles x 18 hubs while this was built, exactly one card set
 *              did it — HR Operations holds `employee_documents` but not `recruitment`, so Hiring
 *              Documents and HR Forms appeared on a rail that has never carried them. The fix was
 *              to carry the hub row's gate onto the SECTION, which is why NavigationSection.gate
 *              is a list.
 *   NARROWED  — a plain row that shared a section with a hub row is dropped along with it, and the
 *              module simply becomes unreachable from the sidebar. AGENTS.md has the general form:
 *              a feature can ship green, deploy cleanly, and be reachable by nobody.
 *
 * Both were measured by hand at 0 when the promotion landed. A measurement taken once is not a
 * guard, so this file re-takes it on every run, against the SEEDS — which is the only reason
 * `adminNavigationSectionSeeds` is exported. Without the before-state there is nothing to compare
 * the rail to, and "the rail renders" is all any other test can say.
 */
export function runNavHubPromotionTests() {
  // `new Set<string>` on every one of these, deliberately. The seeds are declared `as const`, so
  // their hrefs infer as a 54-member literal union while a promotion's `hubHref` is the wider
  // `/${string}` — and `Set<union>.has(wider)` is a type error rather than a false answer. Widening
  // at construction keeps the comparison about hrefs instead of about which literal the compiler
  // happened to keep.
  const hubHrefs = new Set<string>(adminHubPromotions.map((hub) => hub.hubHref));
  const cardHrefs = new Set<string>(
    adminHubPromotions.flatMap((hub) => hub.items.map((card) => card.href)),
  );
  const seedHrefs = new Set<string>(
    adminNavigationSectionSeeds.flatMap((section) => section.items.map((item) => item.href)),
  );
  const railHrefs = new Set<string>(
    adminNavigationSections.flatMap((section) => section.items.map((item) => item.href)),
  );

  // ── The module anchors ──────────────────────────────────────────────────────
  //
  // A promotion anchor that is NOT a page of modules. Written out here by hand, one line per
  // exception, and cross-checked against the config below — because this list is the thing the
  // owner's rule is suspended for, and a flag read straight out of the config would let a real
  // door be exempted by a one-word edit that no assertion questions.
  //
  // /admin/direct-orders is the Direct Orders WORKSPACE: tabs, the needs-action queue, every
  // order. The hub page it was once paired with, /sales/direct-orders-tools, no longer exists.
  // It reads as a hub to `hubRoutesOnDisk` above only because the workspace imports
  // `directOrdersPageItems` to draw a shortcut list INSIDE itself — which is why the scan, this
  // file, and every assertion below agreed for a day that the module's own row was a door and
  // was correctly gone. It was not: Super Admin, CEO, Finance Manager and the SFE Manager lost
  // their only rail row to the module, and the Finance Manager lost the unbooked-sales-month
  // badge with it.
  const MODULE_ANCHORS = new Set<string>(["/admin/direct-orders"]);
  assert.deepEqual(
    adminHubPromotions.filter((hub) => hub.anchorIsAModule === true).map((hub) => hub.hubHref).sort(),
    [...MODULE_ANCHORS].sort(),
    "`anchorIsAModule` in src/config/system-navigation.ts and MODULE_ANCHORS here have drifted. " +
      "Every exception to the owner's no-door rule is named in both places on purpose: the flag " +
      "alone would let a real page of modules back onto the rail with nothing to argue about it.",
  );

  assert.ok(
    adminHubPromotions.length >= 15,
    `only ${adminHubPromotions.length} hub promotions are configured — 18 when this was written. ` +
      "Every assertion below loops over them, so a collapsed list passes vacuously",
  );

  // ── 1. every promotion is actually wired to something ───────────────────────
  //
  // A promotion whose href matches no row anywhere is dead config that READS as handled: the hub
  // is listed here, so a session checking "is this hub promoted?" answers yes, while the door it
  // names still sits on the rail under a different href.
  //
  // Two shapes are legitimate. Seventeen replace a seed ROW. One replaces a CARD — Customers
  // Database sits on the Master Data hub, and `promoteHubRows` runs to a fixed point to reach it.
  for (const hub of adminHubPromotions) {
    assert.ok(
      seedHrefs.has(hub.hubHref) || cardHrefs.has(hub.hubHref),
      `the "${hub.heading}" promotion names ${hub.hubHref}, which is neither a row in the admin ` +
        "seeds nor a card on another hub. It replaces nothing, and reads as though it does",
    );
  }

  // ── 1b. …and every hub page on disk is one of them ─────────────────────────
  //
  // Read off the filesystem rather than the config, because the config is the thing that can be
  // incomplete. Set EQUALITY, both directions: a route on disk and not here is a door nothing is
  // promoting, and an href here that is not a hub page on disk is a promotion pointing at a page
  // that has stopped being a grid of modules.
  const onDisk = hubRoutesOnDisk();
  assert.ok(
    onDisk.length >= 15,
    `the hub scan found only ${onDisk.length} hub pages under app/ — 18 when this was written. A ` +
      "scan that finds nothing agrees with any config, so this fails rather than passing quietly",
  );
  assert.deepEqual(
    onDisk,
    [...hubHrefs].sort(),
    "the hub pages on disk and the promoted hubs have drifted apart. A page of modules with no " +
      "promotion keeps its rail row — which is the owner's rule broken, and invisible to every " +
      "other assertion in this file, because a hub the config does not list is a hub nothing " +
      "checks. If a hub page is deliberately unlisted, it must also have no rail row, and the " +
      "reason belongs here in writing.",
  );

  // ── 2. THE HEADLINE: no hub door survives on the rail ───────────────────────
  const doorsLeft = [...hubHrefs]
    .filter((href) => railHrefs.has(href) && !MODULE_ANCHORS.has(href))
    .sort();
  assert.deepEqual(
    doorsLeft,
    [],
    `these hub pages are still rail rows: ${doorsLeft.join(", ")}. The owner's rule is that no ` +
      "row may open a page of modules — press it and you should land on the module, not on a " +
      "grid of them",
  );

  // ── 2b. …and every module anchor DOES survive ───────────────────────────────
  //
  // The mirror of the assertion above, and the one that was missing. Section 2 is one-directional
  // by construction — it can only complain about a row that is still there — so the day
  // /admin/direct-orders was swept up with the doors, this file went green on it.
  const anchorsLost = [...MODULE_ANCHORS].filter((href) => !railHrefs.has(href)).sort();
  assert.deepEqual(
    anchorsLost,
    [],
    `these are modules, not doors, and they are no longer rail rows: ${anchorsLost.join(", ")}. ` +
      "Press one and you land on the module itself, so it must survive the promotion like any " +
      "other row.",
  );

  // ── 2c. …carrying the SEED row, not the hub's card for the same href ────────
  //
  // `hubRowsFor` re-inserts the seed row rather than the card, and the difference is not cosmetic.
  // A card cannot carry `navBadge`, and the Direct Orders badge counts approved orders with no
  // sales month — the Finance Manager's one exclusive duty and the only queue in the product with
  // no chaser of any kind behind it. Rebuilding the row from the card would put the link back and
  // leave the badge gone, which is the same defect wearing a fix.
  //
  // `widenedSeeds`, because the seeds are declared `as const`: `flatMap` over them yields a union
  // of 37 literal TUPLES, and reading `.navBadge` off that union is a type error on every member
  // that happens not to carry one. Same reason `new Set<string>` is spelled out above.
  const widenedSeeds: readonly NavigationSection[] = adminNavigationSectionSeeds;
  for (const href of MODULE_ANCHORS) {
    const seedRow = widenedSeeds
      .flatMap((section) => section.items)
      .find((item) => item.href === href);
    const railRow = adminNavigationSections
      .flatMap((section) => section.items)
      .find((item) => item.href === href);
    assert.ok(seedRow, `${href} is flagged as a module anchor but is not a row in the admin seeds`);
    assert.equal(
      railRow?.label,
      seedRow?.label,
      `${href} reaches the rail under a different label than the seed row gives it`,
    );
    assert.equal(
      railRow?.navBadge,
      seedRow?.navBadge,
      `${href} lost its navBadge on the way to the rail. The row is only half the fix: the badge ` +
        "is what chases the queue behind it.",
    );
  }

  // ── 3. nothing was lost in the swap, before any role is considered ──────────
  //
  // Ungated, so this catches the structural half: `promoteHubRows` emits a section only when it
  // still has rows (`kept.length > 0`), and a bug there takes a hub row's SIBLINGS with it.
  const lost = [...seedHrefs].filter((href) => !railHrefs.has(href)).sort();
  const expectedLost = [...seedHrefs]
    .filter((href) => hubHrefs.has(href) && !MODULE_ANCHORS.has(href))
    .sort();
  assert.deepEqual(
    lost,
    expectedLost,
    "the promotion removed rows that are not hub doors. Only a hub row may disappear — every " +
      `other row must survive it. Removed: ${lost.join(", ")}`,
  );

  // ── 4. per role: 0 widened, 0 narrowed ──────────────────────────────────────
  //
  // The reachability rule the promotion has to preserve, stated once: a row shows iff the viewer
  // COULD HAVE OPENED THE HUB and the hub page WOULD HAVE RENDERED THAT CARD for them. Both halves
  // are computed here from the real resolvers — `getSections` for the before-state and
  // `navigationItemVisible` for each card — rather than re-derived, so this compares the rail
  // against the config it came from and not against a second copy of the same mistake.
  let rolesSwept = 0;
  let gainedTotal = 0;

  for (const role of phoenixRoles as readonly PhoenixRole[]) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    const before = new Set<string>(
      getSections(adminNavigationSectionSeeds, "admin", lookup, role).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    );
    const after = new Set<string>(
      getSections(adminNavigationSections, "admin", lookup, role).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    );

    // Which hubs this role could actually open, to a fixed point for the nested one: Customers
    // Database is reachable only by opening Master Data first, so its cards were reachable only
    // for a role that could open BOTH doors.
    const openable = new Set<string>();
    for (;;) {
      let moved = false;
      for (const hub of adminHubPromotions) {
        if (openable.has(hub.hubHref)) continue;
        const asRow = before.has(hub.hubHref);
        const asCard = adminHubPromotions.some(
          (parent) =>
            openable.has(parent.hubHref) &&
            parent.items.some(
              (card) => card.href === hub.hubHref && navigationItemVisible(card, lookup, role),
            ),
        );
        if (!asRow && !asCard) continue;
        openable.add(hub.hubHref);
        moved = true;
      }
      if (!moved) break;
    }

    const reachableThroughHubs = new Set<string>();
    for (const hub of adminHubPromotions) {
      if (!openable.has(hub.hubHref)) continue;
      for (const card of hub.items) {
        if (card.href === hub.hubHref) continue;
        if (navigationItemVisible(card, lookup, role)) reachableThroughHubs.add(card.href);
      }
    }

    // `!hubHrefs.has(href)` is what lets a DOOR disappear — that is the promotion working. A
    // module anchor is exempted from the exemption: it is in `hubHrefs` but it is a module, so
    // losing it for even one seat is a narrowing like any other. This clause is the per-role half
    // of 2b, and without it the whole /admin/direct-orders regression is invisible here too.
    const narrowed = [...before]
      .filter((href) => !after.has(href) && (!hubHrefs.has(href) || MODULE_ANCHORS.has(href)))
      .sort();
    assert.deepEqual(
      narrowed,
      [],
      `${role} lost rail rows to the promotion: ${narrowed.join(", ")}. Only the hub DOOR may go; ` +
        "a module that was on this rail before must still be on it, or it is reachable by URL and " +
        "by nobody",
    );

    const gained = [...after].filter((href) => !before.has(href)).sort();
    const widened = gained.filter((href) => !reachableThroughHubs.has(href));
    assert.deepEqual(
      widened,
      [],
      `${role} gained rail rows the seat could not reach before: ${widened.join(", ")}. A card's ` +
        "own gate is only half the answer — the other half is whether this role could open the " +
        "hub at all, which is what NavigationSection.gate carries. A row that appears here is a " +
        "module handed to a seat that has never had it",
    );

    rolesSwept += 1;
    gainedTotal += gained.length;
  }

  // Anti-vacuity, both halves. A sweep of nothing passes every assertion above, and so does a
  // promotion that promoted nothing — the rail would simply still be full of doors, which
  // section 2 catches, but the per-role comparison would be comparing a set to itself.
  assert.equal(rolesSwept, phoenixRoles.length, "every role must be swept");
  assert.ok(
    gainedTotal > 100,
    `the promotion added only ${gainedTotal} rows across all ${rolesSwept} roles. It replaced 18 ` +
      "doors with their modules; a figure this low means the comparison is reading the same set twice",
  );

  // ── 4b. a split hub deals EVERY row into exactly one band ───────────────────
  //
  // Ten hubs are split into several bands (`AdminHubPromotion.split`, 2026-09-05) because a band of
  // 17 rows is a wall the eye slides off. `hubBandsFor` is deliberately forgiving at runtime — a row
  // no band names is appended to the FIRST band rather than dropped, because an unreachable link is
  // the one failure nobody notices — so this is the check that makes the mistake loud instead.
  //
  // Landing in the first band silently is exactly how a new module ends up filed under whatever
  // heading happens to come first: it renders, it works, and it reads as someone's decision. The
  // hrefs are also checked the other way round, because a split still naming an href its hub has
  // dropped leaves a band that can only shrink, and an EMPTY band is a phantom section id in
  // src/config/sidebar-domains.ts — caught there, but with a message about the wrong file.
  let splitHubs = 0;
  for (const hub of adminHubPromotions) {
    if (hub.split === undefined) continue;
    splitHubs += 1;

    // The hub's own card is dropped by `hubRowsFor` — keeping it would rebuild in one row the
    // "press it and land on a page of modules" the promotion exists to remove — so compare against
    // the rows the hub actually becomes, never against `hub.items`. A MODULE ANCHOR is the one
    // case where the anchor href does come back as a row (the seed row itself, not the card), so
    // the split must name it like any other.
    const rows: string[] = hub.items
      .filter((card) => card.href !== hub.hubHref)
      .map((card) => card.href);
    if (MODULE_ANCHORS.has(hub.hubHref)) rows.unshift(hub.hubHref);
    const named = hub.split.flatMap((band) => band.hrefs);

    assert.deepEqual(
      named.filter((href, index) => named.indexOf(href) !== index),
      [],
      `the "${hub.heading}" split names an href in two bands. The first band wins and the second ` +
        "renders a row short, which reads as a gating problem rather than as a typo here",
    );
    assert.deepEqual(
      rows.filter((href) => !named.includes(href)).sort(),
      [],
      `the "${hub.heading}" split leaves rows unnamed. They are appended to its FIRST band rather ` +
        "than dropped, so nothing looks broken — they are simply filed under a heading nobody chose",
    );
    assert.deepEqual(
      named.filter((href) => !rows.includes(href)).sort(),
      [],
      `the "${hub.heading}" split names hrefs the hub no longer offers. Drop them here, or the band ` +
        "shrinks toward empty and fails as a phantom section in src/config/sidebar-domains.ts",
    );

    // The first band inherits the id, and that is not cosmetic: sidebar-layout-editor.tsx saves a
    // per-role arrangement keyed by section id, so the id has to stay on the biggest slice or every
    // saved layout silently loses the section it names.
    assert.equal(
      hub.split[0].sectionId,
      hub.sectionId,
      `the "${hub.heading}" split must open with its own sectionId (${hub.sectionId}); a saved ` +
        "navigation layout keyed by that id is orphaned otherwise",
    );

    const ids = hub.split.map((band) => band.sectionId);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `the "${hub.heading}" split reuses a sectionId across two bands: ${ids.join(", ")}`,
    );
  }
  assert.equal(
    splitHubs,
    10,
    `${splitHubs} hubs carry a split — 10 when the rebalance shipped. Every assertion above loops ` +
      "over them, so a collapsed list passes without checking anything",
  );

  // ── 5. Sales Analytics stays off the rail ───────────────────────────────────
  //
  // Said twice on the day this shipped: "note that I don't want sales analytics module. Leave it
  // archival for now and don't touch it", then "But without the sales analytics." The owner then
  // retired the module outright on 2026-09-17 ("drop and retire the sales analytics module"), and
  // `salesAnalyticsPageItems`, kept until then as a record of who could reach each dashboard, went
  // with it; next.config.ts redirects the old addresses.
  //
  // tests/navigation-ruling-11-analytics.test.ts pins the analytics tree out of `hubPageItemGroups`,
  // the Cmd+K route. This pins the LOUDER route the promotion opened: a promoted row into that tree
  // would put a retired dashboard's redirect on the rail itself. The one page the retirement kept,
  // the Finance Manager's export, is a Monthly Closing rail row, never a promoted one.
  const analyticsRows = adminHubPromotions.flatMap((hub) =>
    hub.items
      .filter((item) => item.href === "/admin/analytics" || item.href.startsWith("/admin/analytics/"))
      .map((item) => `${hub.heading}: ${item.href}`),
  );
  assert.deepEqual(
    analyticsRows,
    [],
    "a hub promotion puts the retired Sales Analytics module back on the rail as rows. The owner " +
      "retired it on 2026-09-17; these addresses only redirect now",
  );
}
