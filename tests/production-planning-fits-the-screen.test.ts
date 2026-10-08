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
 * 🔴 THE WIDTH THAT MATTERS IS THE ONE AT 1024px, AND IT IS THE PORTAL'S, NOT THE ADMIN'S.
 * Measured in the browser on 2026-10-06, which corrected the figure this file was born with: `main`
 * carries `phx-zoom-surface`, whose `zoom: 0.8` makes the LAYOUT box wider than the visual one, so
 * at a 1024px viewport the admin box is **928 layout px** (742 visual) and not the 669 this comment
 * used to claim. The portal box is the tight one — **776 layout px**, because that shell pads more,
 * not because its sidebar overlays — and the planner's four cells measure 192/143/143/143 there at
 * zero overflow each. A fifth column is what takes the editable quantity field under its natural
 * width, and the fix is to merge into an existing column, which is how the "available" column came
 * to carry BOTH locations. The breakpoint stays `lg` and not `md`: the box narrows as the viewport
 * CROSSES 1024px, which is the same reason whatever the exact pixel count.
 *
 * 🔴 AND THIS MODULE IS DUAL-SURFACE, so there are TWO boxes, not one, and the narrower one is
 * the portal's. No existing fit test in this repo has had to measure a component in two shells;
 * that measurement is a browser's job (`scrollWidth > clientWidth` over `main` at 1024px, 1280px
 * and 375px, in both surfaces) and this file cannot do it. What it CAN do is pin the constructs
 * that let an overflow happen at all — across all four tables, and across every grid.
 *
 * 🔴 THAT BROWSER HALF NOW EXISTS: `scripts/measure-production-planning-fit.mjs`
 * (`pnpm run ui:measure-production-planning-fit -- --fixture <file>`). It renders these same
 * components inside each shell's own container chain and measures 375/768/1024/1280/1920 at BOTH
 * display scales, with three positive controls per row. Measured 2026-10-06 against the real
 * production payload: 20 rows, zero overflow, zero clipped cells, zero radii, the tab strip on two
 * rows at 375px and one above it. The tightest box in the whole sweep is the PORTAL's at 1024px and
 * display scale 1 - **636 layout px**, columns 196/146/146/146 - which is why the figures in the
 * paragraph above (928 admin / 776 portal) are not contradicted by it: those were read at the
 * owner's own 0.8 scale, where the same portal box is 795px. A rect is VISUAL px under `zoom` and
 * `clientWidth` is LAYOUT px; mixing the two is what made one box look 20% narrower than the
 * columns it had laid out.
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
    // 🔴 AND THE TEMPLATE-LITERAL ONES. PANEL, TABLE, CARD and NOTICE became backticked when the
    // module took the shared admin depth tokens (premium polish, 2026-10-09), which put them out
    // of reach of the `"…" + "…"` pattern above — so the four surfaces that carry most of this
    // file's classes would have stopped being scanned for an ellipsis, a nowrap, a radius or a
    // scroller at the exact moment they were rewritten. The `${…}` interpolations survive
    // tokenisation harmlessly: a forbidden class is a literal token beside them.
    ...[...source.matchAll(/^const [A-Z_]+ = `([^`]*)`;$/gm)].map((match) => match[1]),
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

  // 3b. The language toggle, which sits in the header's own row beside the title block. It wraps for
  //     the same reason the tab strip does — at 375px the title and two buttons do not share a line —
  //     and it says WHICH language is on, since two buttons with no state read as two links.
  const toggle = source.match(/className="([^"]*)" dir="ltr" role="group"/);
  assert.ok(toggle, `${WORKSPACE}: the language toggle's own row was not found. The owner chose the module's language with a toggle.`);
  const toggleTokens = toggle[1].split(/\s+/);
  assert.ok(
    toggleTokens.includes("flex-wrap"),
    `${WORKSPACE}: the toggle row is "${toggle[1]}" — it needs flex-wrap, because "shrink-0" beside ` +
      `a title block is what pushes a header past 375px.`,
  );
  assert.ok(
    source.includes("aria-pressed={lang === option.key}"),
    `${WORKSPACE}: the toggle does not say which language is on. aria-pressed is the state a screen ` +
      `reader and the styling both read.`,
  );
  // "English" is always the Latin word; the Arabic option reads in the language being read - the
  // Arabic script on the Arabic screen, the word "Arabic" on the English one (owner, 2026-10-08:
  // "every single Arabic word"). Its two values are pinned in production-planning-strings.test.ts.
  assert.ok(
    source.includes("label: S.t.languageArabic") && source.includes('label: "English"'),
    `${WORKSPACE}: the toggle's labels must be S.t.languageArabic and English.`,
  );

  // 4. Every table is fixed-layout, and every one is paired with a card list for a phone. The
  //    owner's standing rule: desktop gets the table, mobile never does.
  // 🔴 THE FIVE TABLES SHARE ONE CLASS CONSTANT since the premium-depth pass, so the layout tokens
  //    are resolved from `TABLE` and then collected, instead of five literals being read. Both
  //    spellings are covered — `className={TABLE}` and the one table that adds its own `mt-4` —
  //    and a sixth table written with a hand-made className is still collected and still counted,
  //    which is what keeps the count below a guard rather than a check on one string.
  const tableConstant = source.match(/^const TABLE = `([^`]*)`;$/m);
  assert.ok(
    tableConstant,
    `${WORKSPACE}: the shared TABLE class constant is gone. Five hand-written table classNames is ` +
      `exactly how one of them quietly loses "table-fixed" — put the layout tokens back in one place.`,
  );
  const tables = [
    ...source
      .replace(/className=\{`([^`]*)`\}/g, 'className="$1"')
      .replace(/className=\{TABLE\}/g, `className="${tableConstant[1]}"`)
      .replace(/\$\{TABLE\}/g, tableConstant[1])
      .matchAll(/<table className="([^"]*)"/g),
  ].map((match) => match[1]);
  assert.equal(
    tables.length,
    5,
    `${WORKSPACE}: found ${tables.length} tables, expected 5 (planner result, stock, cost, run ` +
      `entry, composition). A new table needs its own colgroup and its own card list, so this count ` +
      `is pinned. It went from 4 to 5 on 2026-10-09, when the Settings tab's formula list became a ` +
      `table with an editor under it — raised deliberately, with the colgroup and the card list in ` +
      `the same change, never to quiet a failure.`,
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
        `a "lg:hidden" card list beside it — the breakpoint is lg, not md, because the content box ` +
        `narrows as the viewport crosses 1024px, to 928 layout px in the admin shell and 776 in the ` +
        `portal.`,
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
        `4. At a 1024px viewport the tighter of the two boxes — the portal's — is 776 layout px, so a ` +
        `fifth column takes the editable quantity fields under their natural width. Merge into an ` +
        `existing column.`,
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

  // 6b. The composition table is the LAST one in the file, because SettingsTab is the last component
  //     in it, and its first column is wider still: it carries the wrapping name, the code AND the
  //     "also used by" line that has to be read before a retire.
  assert.deepEqual(
    colgroups[4],
    [37, 21, 21, 21],
    `${WORKSPACE}: the composition table's colgroup is ${JSON.stringify(colgroups[4])}, not ` +
      `[37,21,21,21]. Its material column holds the name, the code and the shared-product warning, ` +
      `and the two row actions are MERGED under the supplier rather than given a fifth column — a ` +
      `fifth takes the table under its natural width in the admin shell's 669px box.`,
  );

  // 7. One <col> per heading, in every table. They must agree, or every column after a mismatch is
  //    sized by the wrong <col>.
  // `t.`, not `PP.`: since the language toggle (2026-10-06) every string in this file comes from the
  // bundle in force (`const S = useProductionPlanningStrings(); const t = S.t;`), which is the same
  // catalogue reached through the chosen language instead of the Arabic one by name. A heading
  // written as a literal is still the defect this counts.
  const headingGroups = [...source.matchAll(/\{\[((?:t\.[A-Za-z]+(?:,\s*)?)+)\]\.map\(\(heading\) => \(/g)].map(
    (match) => [...match[1].matchAll(/t\.[A-Za-z]+/g)].length,
  );
  assert.equal(
    headingGroups.length,
    tables.length,
    `${WORKSPACE}: ${headingGroups.length} mapped heading rows against ${tables.length} tables. ` +
      `Every table's headings come from the string bundle so the screen and the workbook cannot drift.`,
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
  // The direction and the language come from the BUNDLE, not from a literal. The owner chose the
  // language with a toggle on 2026-10-06, so `dir="rtl"` written into the markup is now the defect
  // — it leaves the English half of the module facing the wrong way while every string is right,
  // which is what a hard-coded loading state did until it was caught by the browser harness.
  // `productionPlanningStrings("ar").dir` is where "rtl" lives, and the strings test pins it there.
  assert.ok(
    /dir=\{S\.dir\}/.test(code) && /lang=\{S\.lang\}/.test(code),
    `${WORKSPACE}: the root must carry dir={S.dir} and lang={S.lang} — Arabic is the DEFAULT, not ` +
      `the only language, and nothing in tokens.css or globals.css is RTL-aware either way.`,
  );
  assert.ok(
    !/dir="rtl"/.test(code) && !/lang="ar"/.test(code),
    `${WORKSPACE}: a hard-coded dir="rtl" or lang="ar" survives. Every one of them is a place the ` +
      `language toggle cannot reach, so the English screen renders right-to-left there.`,
  );

  // 11. The face stack comes from the bundle too: the Arabic faces in Arabic, and the app's own
  //     type in English, because an English page on an Arabic-first stack reads as a different app.
  assert.ok(
    /fontFamily: S\.fontStack/.test(code),
    `${WORKSPACE}: the face stack is not taken from the bundle. The app's default stack has no ` +
      `Arabic shaping face, so Arabic text falls back to whatever the reader's browser picks — and ` +
      `the Arabic stack in English is the same mistake the other way round.`,
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

  // 13. EVERY GRID STARTS AT ONE COLUMN. Measured on 2026-10-06, the morning after this module
  //     shipped: the four headline tiles were the one `grid-cols-2` in the file, and at 375px that
  //     gave each tile a 105px content box while `106,000` at `text-3xl` needs 124px — so the one
  //     figure this screen exists to produce was clipped by 19px in the admin shell, with 5px to
  //     spare in the portal, which a seven-digit total would have taken too. Nothing caught it,
  //     because every guard above is about TABLES and the tiles are a grid.
  //
  //     The rule is the golden rule's own: fit by MERGING columns, never by shrinking type. So a
  //     two-up grid at phone width is refused outright — a figure in a 130px cell either clips or
  //     gets smaller, and both are the defect. `sm:grid-cols-2` and up is where columns belong.
  const gridClasses = [...classTokens].filter((token) => /^grid-cols-\d+$/.test(token)).sort();
  assert.deepEqual(
    gridClasses,
    ["grid-cols-1"],
    `${WORKSPACE}: unprefixed grid columns ${JSON.stringify(gridClasses)}. Every grid in this file ` +
      `must start at "grid-cols-1" and add columns only behind a breakpoint ("sm:grid-cols-2", ` +
      `"lg:grid-cols-4"). A bare "grid-cols-2" is two columns AT 375px, where the admin shell gives ` +
      `each cell 105px and the planner's own total needs 124px — measured, not predicted.`,
  );

  // 14. Read-only is a real state, not a failed save. Two of the five named people are read-only.
  assert.ok(
    /canWrite/.test(code),
    `${WORKSPACE}: nothing reads canWrite. Mr. Ahmed Al Maraghi and Reham Elwiy are read-only — ` +
      `"read only, read only" — and a 403 they cannot act on is worse than a control never offered.`,
  );
}
