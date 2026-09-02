import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getNavigationSections, hubPageItemGroups } from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  getHubCardItems,
  getHubCardSections,
  mergeCatalogueSections,
} from "../src/lib/navigation/hub-card-sections.ts";

/**
 * The hub-card catalogue — every page that exists but is NOT in the rail.
 *
 * WHY IT EXISTS. Most admin modules were collapsed into a single hub button: the sidebar shows
 * "People Management" and the twelve pages behind it live as cards on that hub page. Anything built
 * from the SIDEBAR therefore sees the button and none of the pages. Cmd+K hit that first and solved
 * it locally; on 2026-09-02 the nav row's "+" hit the identical wall and the owner reported it in
 * those terms — "some pages are compacted and not appearing. I want all pages to appear. Any page I
 * have, appear in the add and I can add it."
 *
 * Two copies of the same fold is the defect shape this repo has shipped before (a union, a
 * constraint and a classifier agreeing while one local duplicate did not), so it is ONE function
 * with two callers, and the source pins at the bottom are what keep it that way.
 *
 * WHAT IS ACTUALLY AT RISK HERE. Not access — every item is filtered through the same
 * `navigationItemVisible` gate the hub page itself applies, and `assertPermission` in the route
 * handler is the boundary regardless. What is at risk is a picker that silently offers a page it
 * cannot render, or one that quietly starts widening the rail. Both are pinned.
 */
/**
 * Source with block and line comments removed, so a pin can assert what the code DOES without
 * tripping over prose that explains what it used to do. Crude but sufficient: these files contain
 * no string literal carrying `//` or a comment opener.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function runNavigationHubCardCatalogTests() {
  // An empty lookup GRANTS (permissionAllowed returns true for an unknown key), so this stands in
  // for a viewer holding everything — which is what makes the "no page escapes the gate" check
  // below meaningful when it flips one key to false.
  const permissive: PermissionLookup = {};
  const adminRail = getSections(getNavigationSections("admin"), "admin", permissive, "Super Admin");

  // ── It answers the owner's ask at all ────────────────────────────────────────────────────────
  {
    const hubs = getHubCardSections("admin", permissive, "Super Admin", adminRail);
    const items = getHubCardItems("admin", permissive, "Super Admin", adminRail);

    assert.ok(
      hubs.length > 0,
      "the admin surface has collapsed hubs, so the catalogue must be non-empty — an empty one means the + is back to offering the rail alone",
    );
    // The whole point is that this is a LOT of pages. A catalogue that shrank to a handful would
    // pass every structural check below while quietly failing the ask.
    assert.ok(
      items.length > 50,
      `the hub cards are most of the admin surface; got ${items.length}, which is too few to be the real catalogue`,
    );
    assert.equal(
      items.length,
      hubs.reduce((count, section) => count + section.items.length, 0),
      "getHubCardItems must be exactly the flattened sections, or the picker and the resolver disagree about what exists",
    );
  }

  // ── It never repeats what the rail already shows ─────────────────────────────────────────────
  {
    const railHrefs = new Set(adminRail.flatMap((section) => section.items.map((item) => item.href)));
    const items = getHubCardItems("admin", permissive, "Super Admin", adminRail);
    const repeated = items.filter((item) => railHrefs.has(item.href));
    assert.deepEqual(
      repeated.map((item) => item.href),
      [],
      "a page with BOTH a rail row and a hub card must be offered once, as the rail knows it",
    );

    // And no page is offered twice within the catalogue itself. `hubPageItemGroups` lists some
    // pages under more than one hub, which would render two identical buttons in the picker.
    const seen = new Set<string>();
    const duplicates = items.filter((item) => {
      if (seen.has(item.href)) return true;
      seen.add(item.href);
      return false;
    });
    assert.deepEqual(duplicates.map((item) => item.href), [], "no page is offered twice");
  }

  // ── Section ids are unique — the picker keys on them ─────────────────────────────────────────
  // `hubPageItemGroups` names two groups "Leave Management" (the standard list and the finance
  // one). The panel renders `key={section.id}`, so two sections sharing an id is a React key
  // collision that drops one of them from the list — the missing-pages bug, reintroduced by the fix
  // for it. They are merged by label instead.
  //
  // MEASURED 2026-09-02: today the collision does not actually occur — keying the fold by group
  // INDEX instead of label was tried here and the suite stayed green, because the second "Leave
  // Management" group contributes nothing that survives the sidebar dedupe and the gate. So the
  // merge is a RATCHET on future config, not a repair of a live bug, and this block is honest about
  // that: the config-level assertion below is what keeps it from being a check of nothing.
  {
    assert.ok(
      new Set(hubPageItemGroups.map((group) => group.label)).size < hubPageItemGroups.length,
      "hubPageItemGroups no longer contains a duplicated label — if that is deliberate, this merge " +
        "and its assertions can go; while it DOES contain one, the picker must not key two sections alike",
    );
    const hubs = getHubCardSections("admin", permissive, "Super Admin", adminRail);
    const ids = hubs.map((section) => section.id);
    assert.equal(new Set(ids).size, ids.length, `hub section ids must be unique: ${ids.join(", ")}`);
    const labels = hubs.map((section) => section.label);
    assert.equal(
      new Set(labels).size,
      labels.length,
      "duplicate-labelled hub groups must be MERGED, not rendered as two headings with the same name",
    );
    assert.ok(
      hubs.every((section) => section.id.startsWith("hub:")),
      "a hub section's id must be distinguishable from a rail section's, so nothing keyed by id confuses the two",
    );
  }

  // ── Only admin has collapsed hubs ────────────────────────────────────────────────────────────
  {
    for (const mode of ["hr", "employee-portal"] as const) {
      assert.deepEqual(
        getHubCardSections(mode, permissive, "Super Admin", []),
        [],
        `${mode} builds its own navigation and has no hub catalogue — folding the admin one in would offer pages it never renders`,
      );
    }
  }

  // ── No page escapes the gate ─────────────────────────────────────────────────────────────────
  // The catalogue is wider than the rail, so this is the check that matters: widening findability
  // must not widen what a viewer is offered. Flip one resource off and every card gated on it must
  // leave — measured against the same run with it on, so the test fails if it proves nothing.
  {
    const denied: PermissionLookup = { "payroll:read": false };
    const withGrant = getHubCardItems("admin", permissive, "Super Admin", adminRail).map((i) => i.href);
    const withoutGrant = getHubCardItems("admin", denied, "Super Admin", adminRail).map((i) => i.href);
    const dropped = withGrant.filter((href) => !withoutGrant.includes(href));
    assert.ok(
      dropped.length > 0,
      "revoking payroll:read must remove payroll cards from the catalogue — if nothing moved, this test is checking nothing",
    );
    assert.ok(
      withoutGrant.every((href) => withGrant.includes(href)),
      "denying a grant must only ever REMOVE pages",
    );
  }

  // ── The excludedRoles gate survives the fold ─────────────────────────────────────────────────
  // Super Admin waives `roles`, never `excludedRoles`. A hub card the config says is "not for you"
  // must stay out of the picker for the role it excludes, or the + becomes a way around the one
  // gate that is never waived.
  {
    const financeManager = getHubCardItems("admin", permissive, "Finance Manager", adminRail);
    const superAdmin = getHubCardItems("admin", permissive, "Super Admin", adminRail);
    assert.ok(
      financeManager.length > 0 && superAdmin.length > 0,
      "both roles must see a catalogue at all, or the comparison below is vacuous",
    );
    assert.ok(
      financeManager.length !== superAdmin.length,
      "two roles with different config gates must not receive an identical catalogue — that would mean the gate is not being applied",
    );
  }

  // ── The panel shows ONE heading per module ───────────────────────────────────────────────────
  // MEASURED 2026-09-02, in the browser, on the first run of this change: concatenating the rail
  // sections and the hub sections put NINE duplicated headings in the "+" panel — "Master Data"
  // twice, "Leave Management" twice, "Weekly Sales" twice, and so on — because a hub group almost
  // always shares its name with the rail row that opens it. Two identical headings read as a bug,
  // not as depth, so they are merged.
  {
    const hubs = getHubCardSections("admin", permissive, "Super Admin", adminRail);
    const concatenated = [...adminRail, ...hubs].map((section) => section.label);
    assert.ok(
      new Set(concatenated).size < concatenated.length,
      "the rail and the hubs must genuinely SHARE names, or this merge is guarding nothing",
    );

    const merged = mergeCatalogueSections(adminRail, hubs);
    const labels = merged.map((section) => section.label);
    assert.equal(
      new Set(labels).size,
      labels.length,
      `the picker must show one heading per module: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(", ")}`,
    );

    // Nothing may be lost in the merge, and nothing invented.
    const before = [...adminRail, ...hubs].flatMap((section) => section.items.map((i) => i.href)).sort();
    const after = merged.flatMap((section) => section.items.map((i) => i.href)).sort();
    assert.deepEqual(after, before, "merging headings must not drop or duplicate a single page");

    // The rail's own item leads its section — it is the hub BUTTON, and the one carrying the badge.
    const masterData = merged.find((section) => section.label === "Master Data");
    const railMasterData = adminRail.find((section) => section.label === "Master Data");
    if (masterData && railMasterData && railMasterData.items.length > 0) {
      assert.equal(
        masterData.items[0]?.href,
        railMasterData.items[0]?.href,
        "a merged section keeps the rail's ordering first — the hub button, then the pages behind it",
      );
    }
  }

  // ── ONE fold, two callers ────────────────────────────────────────────────────────────────────
  // Source-pinned because both callers are JSX, which the runner's type stripping cannot import.
  // The rule worth keeping: a page findable by Cmd+K is a page addable to a row. Two hand-written
  // folds would agree on the day they were written and drift afterwards.
  //
  // REPOINTED at merge time, 2026-09-02. PR #2897 landed on `main` hours after this branch started
  // and moved the palette's item list out of the component into command-palette-items.ts — while
  // independently writing the same shared-`seen` dedupe this file's fold already had. That is the
  // duplicate-list defect arriving twice in one day, from two sessions. Resolved by keeping their
  // module (it is on main, with its own role sweep) and having it call the shared fold, so the pin
  // follows the code rather than the filename. This is the source-pinning failure mode AGENTS.md
  // names: an assertion about behaviour written against a byte pattern reads a MOVE as a removal.
  {
    const palette = readFileSync("src/lib/navigation/command-palette-items.ts", "utf8");
    assert.ok(
      /getHubCardSections\(/.test(palette),
      "Cmd+K must fold the hub cards in through the shared function, not its own copy",
    );
    // Comments STRIPPED before this one. The first version tested the raw source and went red on
    // the module's own doc comment, which explains the history by naming `hubPageItemGroups` in
    // prose — a source pin failing on the words that document it, which is the failure mode this
    // block is about. What must be gone is the USE, not the mention.
    assert.ok(
      !/hubPageItemGroups/.test(withoutComments(palette)),
      "the palette's own hand-rolled fold must stay gone — two sessions wrote it independently on 2026-09-02",
    );
    assert.ok(
      readFileSync("src/components/layout/command-palette.tsx", "utf8").includes(
        "buildCommandPaletteItems(",
      ),
      "and the component must still call the builder — either half alone passes while the palette is fed by nothing",
    );

    const rows = readFileSync("src/components/layout/horizontal-nav-rows.tsx", "utf8");
    assert.ok(
      /getHubCardSections\(/.test(rows),
      "the nav row's + must fold the hub cards in through the same function",
    );
    // The portal passes its own `sections` and has no hubs. Folding the admin catalogue into it
    // would offer pages that surface never renders.
    assert.ok(
      rows.includes("const hubSections = sections"),
      "a surface that builds its own navigation must be left out of the fold",
    );
  }
}
