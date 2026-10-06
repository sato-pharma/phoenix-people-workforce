import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — the fits-the-screen golden rule, pinned AT BIRTH.
 *
 * AGENTS.md §4: "never a horizontal scroll, always mobile AND desktop friendly … fit by MERGING
 * columns, never shrinking type — `overflow-x-auto` over a `min-width` IS the bug". This file exists
 * before the first defect rather than after one, because this screen is the exact shape of object
 * that has broken the rule twice in this repo: a wide table of per-row figures with an editable
 * control in its last column.
 *
 * 🔴 THE WIDTH THAT MATTERS IS 669px, NOT 1280. The admin shell's sidebar is `hidden lg:flex` at
 * 292px, so the content box NARROWS as the viewport crosses 1024px — 991px at 1023, 669px at 1024.
 * Four columns at 669px give the planner's delivery input ~154px, which is about what a decimal
 * quantity field needs. A fifth column takes it under, and the fix is to merge into an existing
 * column, which is how the planner's "available" column came to carry BOTH locations.
 *
 * 🔴 AND THIS MODULE IS DUAL-SURFACE, so there are TWO boxes, not one. The portal shell's sidebar
 * is an overlay rather than a column, so the same component renders at near-full width there. No
 * existing fit test in this repo has had to measure a component in two shells; that measurement is
 * a browser's job (`scrollWidth > clientWidth` over `main` at 1024px, 1280px and 375px, in both
 * surfaces) and this file cannot do it. What it CAN do is pin the construct that lets the overflow
 * happen at all, across every one of the four tables at once.
 *
 * 🔴 THE TAB STRIP IS THE RTL-SPECIFIC HAZARD. `inline-flex min-w-max` under a scroller is the
 * usual way a five-tab strip is written, and on a right-to-left page a horizontal scroller opens at
 * the LEFT — which is the END of every line, so the first tab is the one off screen. `flex
 * flex-wrap` is the whole fix and it is asserted below.
 */

const WORKSPACE = "src/components/production-planning/production-planning-workspace.tsx";

export function runProductionPlanningFitsTheScreenTests() {
  const source = readFileSync(WORKSPACE, "utf8");
  // The "must not appear" guards below read the STRIPPED source. The component's own header
  // comment quotes every construct it explains the absence of — `overflow-x-auto`, `ar-EG`,
  // `style: "currency"` — so a guard reading raw source fails on its own documentation, which is
  // exactly what it did on the first run of this file. `stripComments` is the shared stripper
  // rather than a one-line regex, because a naive one treats the `*` in a route pattern as a
  // comment opener and deletes real code.
  const code = stripComments(source);

  // Only classes this file APPLIES. The header comment above the component names `overflow-x-auto`
  // and `min-w-[…]` while explaining why they are absent, and a plain substring search over the
  // source reads that prose as the defect — the mistake that cost the no-ellipsis ratchet a full CI
  // round (#2571). So the tokens come from className values and from the string constants the file
  // builds its classes out of, and from nowhere else.
  const classValues = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1]),
    ...[...source.matchAll(/^const [A-Z_]+ =\s*((?:\s*"[^"]*"\s*\+?)+);/gm)].map((match) => match[1]),
    ...[...source.matchAll(/^\s{2}[a-z]+: "([a-z0-9:\-[\]().,%\s]+)",$/gm)].map((match) => match[1]),
  ];
  const classTokens = new Set(
    classValues.flatMap((value) => value.replace(/["+]/g, " ").split(/\s+/)).filter(Boolean),
  );

  // 1. Nothing in this file may scroll sideways, in any of the four spellings the ratchet counts.
  for (const forbidden of ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll"]) {
    assert.ok(
      !classTokens.has(forbidden),
      `${WORKSPACE}: "${forbidden}" is applied. The golden rule names that class over a min-width ` +
        `floor as the bug itself — a scrolling wrapper absorbs the overflow, so a page-level check ` +
        `reads clean while the table hangs off the side. Fit by MERGING columns.`,
    );
  }

  // 2. ...and nothing may set a min-width floor. `min-w-0` is the opposite thing and is required in
  //    several places here; only a bracketed floor is the defect.
  const minWidths = [...classTokens].filter((token) => token.startsWith("min-w-[")).sort();
  assert.deepEqual(
    minWidths,
    [],
    `${WORKSPACE}: found min-width floors ${JSON.stringify(minWidths)}. A fixed floor inside a ` +
      `table-fixed cell is exactly how the horizontal scroll comes back; use "w-full min-w-0".`,
  );

  // 3. The tab strip wraps. On an RTL page a scroller opens at the line's END, so the FIRST tab is
  //    the one hidden — the opposite of the failure a left-to-right page would have.
  const tablist = source.match(/className="([^"]*)" role="tablist"/);
  assert.ok(tablist, `${WORKSPACE}: could not find the tab strip's className beside role="tablist".`);
  const tablistTokens = tablist[1].split(/\s+/);
  assert.ok(
    tablistTokens.includes("flex") && tablistTokens.includes("flex-wrap"),
    `${WORKSPACE}: the tab strip is "${tablist[1]}" — it must be "flex flex-wrap". The five Arabic ` +
      `labels do not fit one line at 375px, and "inline-flex min-w-max" under a scroller hides the ` +
      `FIRST tab on a right-to-left page.`,
  );
  assert.ok(
    !tablistTokens.includes("min-w-max") && !tablistTokens.includes("inline-flex"),
    `${WORKSPACE}: the tab strip carries "${tablist[1]}", which pins it wider than its box.`,
  );

  // 4. Every table is fixed-layout, and every one is paired with a card list for a phone. The
  //    owner's standing rule: desktop gets the table, mobile never does.
  const tables = [...source.matchAll(/<table className="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(
    tables.length,
    4,
    `${WORKSPACE}: found ${tables.length} tables, expected 4 (planner result, stock, cost, run ` +
      `entry). A new table needs its own colgroup and its own card list, so this count is pinned.`,
  );
  for (const [index, table] of tables.entries()) {
    const tokens = table.split(/\s+/);
    assert.ok(
      tokens.includes("table-fixed"),
      `${WORKSPACE}: table ${index + 1} is "${table}" and is missing "table-fixed". Without it the ` +
        `columns size to their content and the widest row decides the table's width again.`,
    );
    assert.ok(
      tokens.includes("hidden") && tokens.includes("lg:table"),
      `${WORKSPACE}: table ${index + 1} is "${table}". Each table must be "hidden … lg:table" with ` +
        `a "lg:hidden" card list beside it — the breakpoint is lg, not md, because the admin box ` +
        `narrows to 669px as the viewport crosses 1024px.`,
    );
  }

  // 5. Four columns per table, each totalling exactly 100%. The opening tag must be followed by
  //    <col> entries and nothing else: a lazy /<colgroup>[\s\S]*?<\/colgroup>/ would match from a
  //    backticked `<colgroup>` in a comment all the way to the first real closing tag.
  const colgroups = [
    ...source.matchAll(/<colgroup>\s*((?:<col className="[^"]*" \/>\s*)+)<\/colgroup>/g),
  ].map((match) => [...match[1].matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((inner) => Number(inner[1])));

  assert.equal(
    colgroups.length,
    tables.length,
    `${WORKSPACE}: ${tables.length} tables against ${colgroups.length} colgroups. Without a ` +
      `colgroup, "table-fixed" divides the width evenly and the material column loses the room an ` +
      `Arabic name beside a Latin code needs.`,
  );
  for (const [index, widths] of colgroups.entries()) {
    assert.equal(
      widths.length,
      4,
      `${WORKSPACE}: colgroup ${index + 1} declares ${widths.length} percentage columns, expected ` +
        `4. At a 1024px viewport the admin content box is 669px, so a fifth column takes the ` +
        `editable quantity fields under their natural width. Merge into an existing column.`,
    );
    assert.equal(
      widths.reduce((sum, width) => sum + width, 0),
      100,
      `${WORKSPACE}: colgroup ${index + 1} widths ${JSON.stringify(widths)} do not total 100%. ` +
        `Over 100% the table overflows its wrapper; under it, the last column is short.`,
    );
  }

  // 6. The planner's own table is the one with the widest first column, because that column carries
  //    a wrapping Arabic material name, a Latin code and up to two chips.
  assert.deepEqual(
    colgroups[0],
    [31, 23, 23, 23],
    `${WORKSPACE}: the planner table's colgroup is ${JSON.stringify(colgroups[0])}, not ` +
      `[31,23,23,23]. The material column needs the largest share — it holds a wrapping Arabic ` +
      `name, the code and the owner chip — and the other three each hold stacked figures.`,
  );

  // 7. One <col> per heading, in every table. They must agree, or every column after a mismatch is
  //    sized by the wrong <col>.
  const headingGroups = [...source.matchAll(/\{\[((?:PP\.[A-Za-z]+(?:,\s*)?)+)\]\.map\(\(heading\) => \(/g)].map(
    (match) => [...match[1].matchAll(/PP\.[A-Za-z]+/g)].length,
  );
  assert.equal(
    headingGroups.length,
    tables.length,
    `${WORKSPACE}: ${headingGroups.length} mapped heading rows against ${tables.length} tables. ` +
      `Every table's headings come from the PP catalogue so the screen and the workbook cannot drift.`,
  );
  for (const [index, count] of headingGroups.entries()) {
    assert.equal(
      count,
      4,
      `${WORKSPACE}: heading row ${index + 1} has ${count} headings against 4 <col> entries.`,
    );
  }

  // 8. Nothing truncates with an ellipsis, and nothing is pinned nowrap. The owner's standing rule
  //    is that where wrapping collides with the no-horizontal-scroll rule, WRAPPING WINS.
  assert.ok(
    !classTokens.has("truncate") && !classTokens.has("text-ellipsis"),
    `${WORKSPACE}: an ellipsis class is applied. The owner's rule is never to truncate text; an ` +
      `Arabic material name is exactly the value that would be cut.`,
  );
  const nowrap = [...classTokens].filter((token) => token.endsWith("whitespace-nowrap")).sort();
  assert.deepEqual(
    nowrap,
    [],
    `${WORKSPACE}: "whitespace-nowrap" is applied ${JSON.stringify(nowrap)}. Nine nowrap columns ` +
      `under a fixed layout is how the Mailbox Revocation register measured 1840px inside a 909px ` +
      `box while the page-level check read false.`,
  );

  // 9. Square edges (AGENTS.md §4). Nothing here may hand-roll a radius.
  const rounded = [...classTokens].filter((token) => /(^|:)rounded(-|$)/.test(token)).sort();
  assert.deepEqual(
    rounded,
    [],
    `${WORKSPACE}: found ${JSON.stringify(rounded)}. The square-edge golden rule admits no round ` +
      `or semi-round corners anywhere, and a new surface must not reintroduce one.`,
  );

  // 10. Every figure is isolated. `Num` is the only way a number reaches this page, because bidi
  //     reorders a digit group beside Arabic text and the defect lives in the layout engine — the
  //     string is right, the HTML is right, and only the rendered line is wrong. No test here can
  //     see that, so what is pinned is that the component HAS the isolation primitive and uses it.
  assert.ok(
    /function Num\(/.test(code),
    `${WORKSPACE}: the Num isolation primitive is gone. Every number, unit and date on an RTL page ` +
      `needs dir="ltr" per VALUE; without it a quantity reads back reordered while the string is ` +
      `perfectly correct.`,
  );
  assert.ok(
    /dir="ltr"/.test(code),
    `${WORKSPACE}: no dir="ltr" anywhere. See the note on Num above.`,
  );
  assert.ok(
    /dir="rtl"/.test(code) && /lang="ar"/.test(code),
    `${WORKSPACE}: the root must carry dir="rtl" and lang="ar" — the owner asked for this module in ` +
      `Egyptian Arabic, and nothing in tokens.css or globals.css is RTL-aware.`,
  );

  // 11. The module's own face stack, not the app's Latin one.
  assert.ok(
    code.includes("PRODUCTION_PLANNING_FONT_STACK"),
    `${WORKSPACE}: the Arabic face stack is not applied. The app's default stack has no Arabic ` +
      `shaping face, so the text falls back to whatever the reader's browser picks.`,
  );

  // 12. Latin digits: the formatter is the only path, and the ar-EG locale never appears.
  assert.ok(
    code.includes("formatNumberLatin"),
    `${WORKSPACE}: numbers are not going through formatNumberLatin, which is what keeps them Latin.`,
  );
  assert.ok(
    !code.includes('"ar-EG"'),
    `${WORKSPACE}: the ar-EG locale emits Arabic-Indic digits (٠١٢٣) and ج.م., and the owner chose ` +
      `Latin digits.`,
  );
  assert.ok(
    !/style:\s*"currency"/.test(code),
    `${WORKSPACE}: Intl currency formatting inserts a space whose character depends on the ` +
      `reader's ICU build, which is a measured React #418 hydration failure in this app. Money is a ` +
      `plain two-place string beside a separate currency label.`,
  );

  // 13. Read-only is a real state, not a failed save. Two of the five named people are read-only.
  assert.ok(
    /canWrite/.test(code),
    `${WORKSPACE}: nothing reads canWrite. Mr. Ahmed Al Maraghi and Reham Elwiy are read-only — ` +
      `"read only, read only" — and a 403 they cannot act on is worse than a control never offered.`,
  );
}
