import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  adminHubPromotions,
  adminNavigationSectionSeeds,
  adminNavigationSections,
  salesAnalyticsPageItems,
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
  const hubHrefs = new Set(adminHubPromotions.map((hub) => hub.hubHref));
  const cardHrefs = new Set(adminHubPromotions.flatMap((hub) => hub.items.map((card) => card.href)));
  const seedHrefs = new Set(
    adminNavigationSectionSeeds.flatMap((section) => section.items.map((item) => item.href)),
  );
  const railHrefs = new Set(
    adminNavigationSections.flatMap((section) => section.items.map((item) => item.href)),
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
  const doorsLeft = [...hubHrefs].filter((href) => railHrefs.has(href)).sort();
  assert.deepEqual(
    doorsLeft,
    [],
    `these hub pages are still rail rows: ${doorsLeft.join(", ")}. The owner's rule is that no ` +
      "row may open a page of modules — press it and you should land on the module, not on a " +
      "grid of them",
  );

  // ── 3. nothing was lost in the swap, before any role is considered ──────────
  //
  // Ungated, so this catches the structural half: `promoteHubRows` emits a section only when it
  // still has rows (`kept.length > 0`), and a bug there takes a hub row's SIBLINGS with it.
  const lost = [...seedHrefs].filter((href) => !railHrefs.has(href)).sort();
  const expectedLost = [...seedHrefs].filter((href) => hubHrefs.has(href)).sort();
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
    const before = new Set(
      getSections(adminNavigationSectionSeeds, "admin", lookup, role).flatMap((section) =>
        section.items.map((item) => item.href),
      ),
    );
    const after = new Set(
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

    const narrowed = [...before].filter((href) => !after.has(href) && !hubHrefs.has(href)).sort();
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

  // ── 5. Sales Analytics stays off the rail ───────────────────────────────────
  //
  // Said twice on the day this shipped: "note that I don't want sales analytics module. Leave it
  // archival for now and don't touch it", then "But without the sales analytics." The module is
  // delisted under ruling 11, and `salesAnalyticsPageItems` is kept ONLY as a record of who could
  // reach each dashboard, so the decision is reversible in one line.
  //
  // tests/navigation-ruling-11-analytics.test.ts already pins it out of `hubPageItemGroups`, the
  // Cmd+K route. This pins the LOUDER route the promotion opened: wiring that array into a
  // promotion would put nine delisted dashboards on the rail itself, and it is one plausible line
  // for a session tidying up "the hub that was missed".
  assert.equal(
    adminHubPromotions.some((hub) => hub.items === salesAnalyticsPageItems),
    false,
    "salesAnalyticsPageItems is wired into a hub promotion, which would put the delisted analytics " +
      "dashboards on the rail as rows. The owner ruled it archival again on 2026-09-05 — leave it " +
      "unwired; the array is retained as a record, not as a catalogue",
  );
}
