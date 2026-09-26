import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { columnPercents } from "@/lib/business-review/table-columns";
import { stripComments } from "./support/comment-strip.ts";

/**
 * BUSINESS REVIEW, PINNED AGAINST THE FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4): never a
 * horizontal scroll, always mobile AND desktop friendly, fit by MERGING columns and never by
 * shrinking type — `overflow-x-auto` over a `min-width` floor IS the bug rather than the fix.
 *
 * Written because the admin half was one of the worst unretired clusters in the repo: 22 tables
 * carrying a `min-w-[…]` floor (the widest 980px) inside five scrolling wrappers, plus three more
 * on the Coverage tab. None used `table-fixed` and none had a `<colgroup>`.
 *
 * 🔴 DELETING THE CLASS IS NOT THE FIX, WHICH IS WHY THIS FILE EXISTS. `app/globals.css` gives ANY
 * element in the admin shell with a direct `<table>` child `overflow-x: auto`, whatever its class
 * list says:
 *
 *     .admin-shell :has(> table) { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
 *
 * That rule is deliberate — thirteen admin components render a bare `<table>` — and it pairs with
 * `.admin-shell { overflow-x: clip }`, so a class-string check (including the repo-wide ratchet)
 * cannot see the scroll it grants. The only honest fix is to make the overflow IMPOSSIBLE BY
 * CONSTRUCTION: `table-fixed` plus a percentage `<colgroup>`, with the phone getting cards instead
 * of a table. This file asserts that construction, so the scroll cannot come back through the
 * stylesheet the next time somebody adds a column.
 *
 * THE WIDTH THAT MATTERS IS ~720px, NOT 1280 — the admin content box at a 1024px viewport
 * (1024 − 272 sidebar − 32 padding), per `tests/activity-control-tables-fit-the-screen.test.ts`.
 */

const DASHBOARD = "src/components/business-review/dashboard.client.tsx";
const COVERAGE = "src/components/business-review/coverage.client.tsx";
const ROLLUPS = "src/components/business-review/rollups.client.tsx";
const PORTAL = "src/components/business-review/portal-review.client.tsx";
const SURFACES = [DASHBOARD, COVERAGE, ROLLUPS, PORTAL];

/**
 * Every class a file actually APPLIES. Scoped deliberately, and read from comment-stripped source:
 * all four of these files explain in prose why `overflow-x-auto`, a `min-width` floor and a bare
 * `<table>` are gone, and a search over raw source reads that explanation as the defect it
 * describes. `stripComments` rather than a hand-rolled regex — see tests/support/comment-strip.ts.
 */
function appliedClassTokens(source: string): Set<string> {
  const values = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
    ...[...source.matchAll(/cn\(\s*"([^"]*)"/g)].map((m) => m[1]),
  ];
  return new Set(values.flatMap((value) => value.split(/\s+/)).filter(Boolean));
}

/** Each `<ReviewTable …>` opening tag, sliced at `items=` so the row bodies stay out of the way. */
function reviewTableHeads(source: string): string[] {
  return source
    .split("<ReviewTable")
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf("items=");
      assert.ok(end > 0, "a <ReviewTable> with no items= prop — has the helper been restructured?");
      return chunk.slice(0, end);
    });
}

export function runBusinessReviewFitsTheScreenTests() {
  const sources = new Map(SURFACES.map((file) => [file, stripComments(readFileSync(file, "utf8"))]));

  // ── 1. The two forbidden classes, on every surface in the module ────────────────────────────
  for (const [file, source] of sources) {
    const tokens = appliedClassTokens(source);
    assert.ok(
      !tokens.has("overflow-x-auto"),
      `${file}: "overflow-x-auto" is applied. The golden rule names that class over a min-width ` +
        `floor as the bug itself — a scrolling wrapper absorbs the overflow, so a page-level ` +
        `scrollWidth check reads clean while the table hangs off the side. Fit by MERGING columns.`,
    );
    const floors = [...tokens].filter((token) => token.startsWith("min-w-[")).sort();
    assert.deepEqual(
      floors,
      [],
      `${file}: found min-width floors ${JSON.stringify(floors)}. A floor is what made these ` +
        `tables 860–980px wide inside a ~720px admin content box. "min-w-0" is the opposite ` +
        `thing and is allowed — only a bracketed floor is the defect.`,
    );
  }

  // ── 2. No bare <table> survives on either admin surface ─────────────────────────────────────
  // A bare <table> is what triggers the admin shell's own `:has(> table)` overflow rule, so this
  // is not a style preference: it is the difference between "cannot scroll" and "does not today".
  for (const file of [DASHBOARD, COVERAGE]) {
    const bare = [...(sources.get(file) ?? "").matchAll(/<table[\s>]/g)];
    assert.equal(
      bare.length,
      0,
      `${file}: ${bare.length} bare <table> element(s). Every table here goes through ` +
        `PortalDesktopTable, which is table-fixed inside a real "hidden md:block" wrapper — a ` +
        `bare <table> hands its parent overflow-x:auto from app/globals.css whatever its classes say.`,
    );
  }

  // ── 3. A phone gets cards, not a table ──────────────────────────────────────────────────────
  for (const [file, source] of sources) {
    if (!source.includes("PortalDesktopTable")) continue;
    const desktop = (source.match(/<PortalDesktopTable[\s>]/g) ?? []).length;
    const responsive = (source.match(/<PortalResponsiveDataList[\s>]/g) ?? []).length;
    assert.ok(
      responsive >= desktop && responsive > 0,
      `${file}: ${desktop} PortalDesktopTable(s) but ${responsive} PortalResponsiveDataList(s). ` +
        `The desktop table is "hidden md:block", so one without its card list is INVISIBLE on a ` +
        `phone — the rule is mobile AND desktop friendly, not desktop only.`,
    );
  }

  // ── 4. Every dashboard table is sized by a <Cols> group ─────────────────────────────────────
  const dashboard = sources.get(DASHBOARD) ?? "";
  const heads = reviewTableHeads(dashboard);
  assert.ok(
    heads.length >= 15,
    `${DASHBOARD}: only ${heads.length} <ReviewTable> usages found. This page carries 22 tables; ` +
      `a sharp drop means one has been rewritten as something the golden rule no longer guards.`,
  );
  for (const head of heads) {
    const cols = head.match(/cols=\{<Cols\s+([^/]*)\/>\}/);
    assert.ok(
      cols,
      `${DASHBOARD}: a <ReviewTable> with no cols={<Cols …/>}. Without a colgroup "table-fixed" ` +
        `divides the width evenly, so a district name column gets the same room as a percentage.`,
    );
    const fixed = cols[1].match(/fixed=\{\[([^\]]*)\]\}/);
    assert.ok(fixed, `${DASHBOARD}: a <Cols> with no fixed={[…]} widths: ${cols[1]}`);
    const widths = fixed[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((width) => Number.isFinite(width));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const fills = /fill=\{/.test(cols[1]);
    const thCount = (head.match(/<th[\s>]/g) ?? []).length;

    if (fills) {
      // Month and product columns are counted by the data, so only the leading columns are fixed.
      assert.ok(
        total < 100,
        `${DASHBOARD}: a <Cols> with a fill claims ${total}% up front, leaving nothing for the ` +
          `generated columns: ${cols[1]}`,
      );
      assert.ok(
        thCount >= widths.length,
        `${DASHBOARD}: a filled <Cols> declares ${widths.length} fixed columns but its head ` +
          `holds only ${thCount} <th>.`,
      );
    } else {
      assert.equal(
        total,
        100,
        `${DASHBOARD}: colgroup widths ${JSON.stringify(widths)} total ${total}%, not 100%. Over ` +
          `100 the table overflows its container — which in the admin shell means a sideways ` +
          `scroll the golden rule forbids; under it, the last column is short of what it needs.`,
      );
      assert.equal(
        thCount,
        widths.length,
        `${DASHBOARD}: a colgroup declares ${widths.length} columns but its head holds ${thCount} ` +
          `<th>. A table-fixed table silently mis-aligns when the two disagree.`,
      );
    }
  }

  // ── 5. The Coverage tab's literal colgroups ─────────────────────────────────────────────────
  const coverage = sources.get(COVERAGE) ?? "";
  const literalGroups = [
    ...coverage.matchAll(/<colgroup>\s*((?:<col className="w-\[[\d.]+%\]" \/>\s*)+)<\/colgroup>/g),
  ];
  assert.ok(
    literalGroups.length >= 3,
    `${COVERAGE}: found ${literalGroups.length} percentage colgroups, expected at least 3 (the ` +
      `sources table, the gradeability table and the "reached no unit" table).`,
  );
  for (const group of literalGroups) {
    const widths = [...group[1].matchAll(/w-\[([\d.]+)%\]/g)].map((m) => Number(m[1]));
    assert.equal(
      widths.reduce((sum, width) => sum + width, 0),
      100,
      `${COVERAGE}: colgroup widths ${JSON.stringify(widths)} do not total 100%.`,
    );
  }

  // ── 6. Free text wraps rather than widening the table ───────────────────────────────────────
  for (const file of [DASHBOARD, COVERAGE]) {
    assert.ok(
      appliedClassTokens(sources.get(file) ?? "").has("break-words"),
      `${file}: no "break-words" anywhere. A district or area name has no natural break point, ` +
        `so without it a long one is what pushes a fixed-layout cell past its share.`,
    );
  }

  // ── 7. The arithmetic behind every generated colgroup ───────────────────────────────────────
  assert.deepEqual(columnPercents([40, 30, 30]), [40, 30, 30], "a fixed-only group passes through");
  assert.throws(
    () => columnPercents([40, 30]),
    /totals 70%/,
    "a fixed-only group that does not total 100 must throw rather than render short",
  );
  assert.throws(() => columnPercents([80, 40], 2), /claims 120%/, "over-claiming must throw");

  for (const fill of [1, 2, 3, 6, 7, 12, 13]) {
    for (const fixed of [[26], [24], [20, 16], [5, 23, 15]]) {
      const widths = columnPercents(fixed, fill);
      assert.equal(
        widths.length,
        fixed.length + fill,
        `columnPercents(${JSON.stringify(fixed)}, ${fill}) returned ${widths.length} columns`,
      );
      const total = Math.round(widths.reduce((sum, width) => sum + width, 0) * 100) / 100;
      assert.equal(
        total,
        100,
        `columnPercents(${JSON.stringify(fixed)}, ${fill}) totals ${total}%, not 100%. Seven ` +
          `months divide unevenly, and a group that rounds to 100.03% is a table three pixels ` +
          `wider than the box it sits in — which the admin shell turns into a sideways scroll.`,
      );
    }
  }
}
