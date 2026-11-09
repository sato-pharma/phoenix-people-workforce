import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The two desktop tables that answer "how are we doing against target?", pinned against the owner's
 * FITS-THE-SCREEN golden rule (AGENTS.md §4): never a horizontal scroll, fit by MERGING columns and
 * never by shrinking the type, and wrapping wins over an ellipsis.
 *
 *   • the Portal Targets grid  — TargetsWorkspace, /employee-portals/targets
 *   • the Sales vs Target table — HierarchyTable in VsTargetDashboard, /employee-portals/sales-vs-target
 *                                 and the admin /sales/vs-target
 *
 * Both were `table-fixed` with a colgroup and no min-width floor — the house pattern — and both still
 * spilled, because a percentage colgroup only fits if every column's share of the NARROWEST table is
 * at least as wide as the widest thing in it that cannot wrap. What binds in these tables:
 *
 *   - the "ACHIEVEMENT" header: one word, 10px black capitals with letter-spacing, ~101px — twice the
 *     widest achievement figure under it;
 *   - the growth pill (arrow + "+1569.9%"), an inline-flex box that is nowrap by construction;
 *   - a money figure's digits, and the longest single word in an area, product or person's name.
 *
 * MEASURED 2026-09-16 on the real pages (dev-auth headers, headless Chromium, classic 15px scrollbars),
 * before the fix, at a 1024px viewport with the display scale at 100%:
 *
 *   Portal Targets grid   a 572px table of seven columns. Achievement had 11% of it, 59px, and its
 *                         header needs 125px with the cell padding: the rows ran to 626px, so the grid
 *                         scrolled sideways. At 1280px it was still short — 87px of the 125px.
 *   Sales vs Target       a 619px table of six columns in the portal (660px in admin). Achievement had
 *                         87px for a header needing 133px, and the growth column 80px for a "+1569.9%"
 *                         pill needing 118px. Both spilled out of their cells.
 *
 * The narrowest table is at a 1024px viewport with the display scale at 100%. Below 1024 the portal
 * has no sidebar, so the content is wider; at 1024 the sidebar arrives and takes its width; and the
 * display-scale zoom (0.8 by default) only applies from 1024 up, where it WIDENS the table in CSS px.
 * The Targets grid shows from 768 (`md:block`), the Sales vs Target table from 1024 (`lg:block`), so
 * 1024 at 100% is the tightest state either of them is ever rendered in.
 *
 * THE FIX merged columns: Targets folded "Target units" into "Target value" (one Target cell carries
 * the value, its units and the unit price), and Sales vs Target folded the "No target" amount under
 * the Sales figure it is a part of. The freed width went to the columns holding unwrappable content.
 *
 * This test re-does that arithmetic from the SOURCE: it reads each table's colgroup and header cells,
 * works out each column's pixel width at the narrowest table, and requires it to hold its content.
 * Re-adding a column, or re-splitting the percentages, fails here instead of on a manager's screen.
 * Pinned on comment-stripped source, so this prose cannot satisfy it.
 */

const WORKSPACE = "src/components/sales/targets-workspace.tsx";
const DASHBOARD = "src/components/sales/vs-target/vs-target-dashboard.tsx";
const REP_TARGETS = "src/components/sales/rep-targets-view.tsx";
const VISUALS = "src/components/sales/target-visuals.tsx";

/** Rendered widths of the narrowest state each table appears in (portal, 1024px viewport, scale 100%). */
const TARGETS_NARROWEST_TABLE_PX = 572;
const VS_TARGET_NARROWEST_TABLE_PX = 619;
/**
 * The Medical Rep's own Targets table (RepTargetsView, /employee-portals/targets as a rep), published
 * month. It sits in a bordered section card straight in the 621px page — the same 619px as Sales vs
 * Target. Until 2026-09-25 the view also padded itself by 16px a side, which left the table 587px and
 * its Achievement column 117px for a header needing 138px (the audit that added this check); the
 * padding went with it, and the columns were re-split 30/17/17/16/20 -> 26/16/16/18/24.
 */
const REP_TARGETS_NARROWEST_TABLE_PX = 619;

type Need = { px: number; what: string; midWord?: true };

/**
 * The widest thing in each column that cannot wrap, measured on the real pages at display scale 100%,
 * WITHOUT the cell's own padding (that is read from each header cell's className, so a padding change
 * is counted rather than silently absorbed). The headers are TABLE_HEAD_CLASS capitals; the figures
 * are the widest in Aug 2026 across every level of both pages, the Super Admin's company totals
 * included. A `midWord` need is a name's longest word: too narrow a column does not scroll there, it
 * breaks the word in two, which the columns were wide enough to avoid before the merge.
 */
const TARGETS_NEEDS: Record<string, Need> = {
  Area: { px: 84.6, what: 'the area name "Mohandseen"', midWord: true },
  Product: { px: 77.6, what: 'the product name "Dopaminect"', midWord: true },
  Actual: { px: 54.6, what: 'the "ACTUAL" header' },
  Target: { px: 53.3, what: 'the "TARGET" header' },
  Achievement: { px: 100.9, what: 'the "ACHIEVEMENT" header' },
};
const VS_TARGET_NEEDS: Record<string, Need> = {
  "{columnLabel}": { px: 85.2, what: 'the product name "Royafloxacin"', midWord: true },
  Sales: { px: 72.3, what: 'the company\'s sales "13,087,666"' },
  Target: { px: 66.4, what: 'the company\'s target "12,536,082"' },
  Achievement: { px: 101, what: 'the "ACHIEVEMENT" header' },
  "vs {priorLabel}": { px: 86.7, what: 'the growth pill "+1569.9%"' },
};
/**
 * A rep's figures are one territory's, so the company's eight-digit totals above never reach this table.
 * Its widest money is taken as a seven-digit figure, "9,999,999" — worked out from the measured
 * "13,087,666" (72.3px for eight digits and two commas, the same bold 14px tabular figures) rather than
 * measured on its own: seven digits and two commas are 64.3px. Wider than the "TARGET" header (53.3px),
 * so the figure is what binds Target and Sales. A figure can break at the space after "EGP", never inside.
 */
const REP_TARGETS_NEEDS: Record<string, Need> = {
  Product: { px: 77.6, what: 'the product name "Dopaminect"', midWord: true },
  Target: { px: 64.3, what: 'a seven-digit target "9,999,999"' },
  Sales: { px: 64.3, what: 'a seven-digit sales figure "9,999,999"' },
  Achievement: { px: 100.9, what: 'the "ACHIEVEMENT" header' },
};

/**
 * Room for the typeface. The stack has no webfont (tokens.css): these widths were measured in Segoe UI
 * Variable, what it renders on a PC without Office, and Aptos — a PC with Office — sets the same
 * capitals and digits a little wider. Content that cannot wrap must fit with this much to spare.
 */
const TYPEFACE_SPARE = 1.05;

const REM_PX = 16;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

type Column = { label: string; width: string; paddingPx: number };

/**
 * The top-level table whose header has an "Achievement" cell, with the wrapper markup just above it.
 * The first `</table>` after its opening tag is its own: both drill-downs render through components
 * (`<SourceBreakdown />`, `<BrickPanel />`), so no nested table sits inline inside it.
 */
function achievementTable(source: string, file: string): { block: string; wrapper: string } {
  const pattern = /<table[\s>]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const end = source.indexOf("</table>", match.index);
    const block = source.slice(match.index, end + "</table>".length);
    if (/<th className="[^"]*">\s*Achievement\s*<\/th>/.test(block)) {
      return { block, wrapper: source.slice(Math.max(0, match.index - 160), match.index) };
    }
    match = pattern.exec(source);
  }
  assert.fail(`${file}: no <table> with an "Achievement" header cell was found — has the desktop table moved? Re-point this test; do not drop it.`);
}

function horizontalPaddingPx(className: string): number {
  const px = tokens(className).find((token) => /^px-\d+(?:\.\d+)?$/.test(token));
  return px ? Number(px.slice(3)) * 4 * 2 : 0;
}

function columnsOf(block: string, file: string): Column[] {
  const colgroup = block.match(/<colgroup>\s*((?:<col style=\{\{ width: "[^"]+" \}\} \/>\s*)+)<\/colgroup>/);
  assert.ok(
    colgroup,
    `${file}: the desktop table has no <colgroup> of <col style={{ width: "…" }} /> entries. Without one, ` +
      `"table-fixed" splits the width evenly and the columns holding unwrappable content lose their room.`,
  );
  const widths = [...colgroup[1].matchAll(/width: "([^"]+)"/g)].map((m) => m[1]);

  const head = block.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
  assert.ok(head, `${file}: the desktop table has no <thead>.`);
  const cells = [...head[1].matchAll(/<th className="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/th>)/g)].map((m) => ({
    className: m[1],
    label: (m[2] ?? "").trim(),
  }));
  assert.equal(
    cells.length,
    widths.length,
    `${file}: ${cells.length} header cells against ${widths.length} <col> entries. They must agree, or every ` +
      `column after the mismatch is sized by the wrong <col>.`,
  );
  return cells.map((cell, index) => ({ label: cell.label, width: widths[index], paddingPx: horizontalPaddingPx(cell.className) }));
}

/**
 * Chrome's fixed table layout, as measured on these tables: a rem/px column gets its width, and the
 * percentage columns share what is left in proportion to their percentages.
 */
function pixelWidths(columns: Column[], tablePx: number): number[] {
  const fixed = columns.map((c) => (c.width.endsWith("rem") ? parseFloat(c.width) * REM_PX : c.width.endsWith("px") ? parseFloat(c.width) : 0));
  const percent = columns.map((c) => (c.width.endsWith("%") ? parseFloat(c.width) : 0));
  const fixedTotal = fixed.reduce((sum, w) => sum + w, 0);
  const percentTotal = percent.reduce((sum, p) => sum + p, 0);
  return columns.map((_, index) => fixed[index] || (percent[index] / percentTotal) * (tablePx - fixedTotal));
}

function checkTable({
  file,
  tablePx,
  needs,
  expectColumns,
  expectedColSpan,
}: {
  file: string;
  tablePx: number;
  needs: Record<string, Need>;
  expectColumns: number;
  /** The drill-down row's colSpan. Omitted for a table that has no drill-down row. */
  expectedColSpan?: RegExp;
}) {
  const source = stripComments(read(file));
  const { block, wrapper } = achievementTable(source, file);
  const classTokens = new Set(
    [...`${wrapper}${block}`.matchAll(/className="([^"]*)"/g)].flatMap((m) => tokens(m[1])),
  );

  // 1. No sideways scroll, no floor, no ellipsis — anywhere in the table or on its wrapper.
  for (const banned of ["overflow-x-auto", "overflow-x-scroll", "truncate", "text-ellipsis"]) {
    assert.ok(
      !classTokens.has(banned),
      `${file}: "${banned}" is on the desktop table or its wrapper. The golden rule names a sideways ` +
        `scroll as the bug, and text is never cut with an ellipsis — fit by merging columns and let text wrap.`,
    );
  }
  const floors = [...classTokens].filter((token) => /^min-w-\[/.test(token));
  assert.deepEqual(floors, [], `${file}: min-width floors ${JSON.stringify(floors)} on the desktop table. A floor is how a table-fixed table starts scrolling sideways again.`);

  const table = block.match(/^<table className="([^"]*)"/);
  assert.ok(table && tokens(table[1]).includes("table-fixed"), `${file}: the desktop table lost "table-fixed", so its widest row decides its width again.`);

  // 2. HEADLINE — every column holds the widest thing in it that cannot wrap, at the narrowest table.
  //    A renamed column is reported after the widths, so a too-narrow column is what fails first.
  const columns = columnsOf(block, file);
  const px = pixelWidths(columns, tablePx);
  const missing: string[] = [];
  for (const [label, need] of Object.entries(needs)) {
    const index = columns.findIndex((column) => column.label === label);
    if (index < 0) {
      missing.push(label);
      continue;
    }
    const content = need.midWord ? need.px : need.px * TYPEFACE_SPARE;
    const required = Math.round((content + columns[index].paddingPx) * 10) / 10;
    assert.ok(
      px[index] >= required,
      `${file}: the "${label}" column is ${px[index].toFixed(1)}px wide in a ${tablePx}px table (${columns[index].width} ` +
        `of it) — the portal at a 1024px viewport — but ${need.what} needs ${need.px}px` +
        `${need.midWord ? "" : ` (${content.toFixed(1)}px with the typeface spare)`} plus ${columns[index].paddingPx}px of cell ` +
        `padding = ${required}px. ` +
        (need.midWord
          ? `Narrower, the word breaks in two. `
          : `It cannot wrap: it spills out of its cell and the table scrolls sideways. `) +
        `Merge a column to free the width; never shrink the type.`,
    );
  }
  assert.deepEqual(missing, [], `${file}: no ${missing.map((label) => `"${label}"`).join(", ")} column — has the header changed? Re-point this test; do not drop it.`);

  // 3. The colgroup is whole, and stays merged.
  const percentTotal = columns.filter((c) => c.width.endsWith("%")).reduce((sum, c) => sum + parseFloat(c.width), 0);
  assert.equal(percentTotal, 100, `${file}: the colgroup percentages total ${percentTotal}%, not 100%.`);
  assert.equal(
    columns.length,
    expectColumns,
    `${file}: the desktop table has ${columns.length} columns, expected ${expectColumns}. The columns were MERGED ` +
      `to make it fit at a 1024px viewport — a new figure belongs inside an existing cell, not in a column of its own.`,
  );

  // 4. The expanded drill-down row spans exactly the table. A stale colSpan adds a phantom column.
  if (expectedColSpan) {
    assert.match(
      block,
      expectedColSpan,
      `${file}: the drill-down row's colSpan no longer equals the ${expectColumns} columns. A colSpan wider than the ` +
        `table creates an implicit extra column that takes width from the real ones.`,
    );
  }
  return { source, block };
}

export function runSalesTargetTablesFitTheScreenTests() {
  // ── The measurements only hold while the things measured still look the way they did ───────────
  const visuals = stripComments(read(VISUALS));
  const head = visuals.match(/export const TABLE_HEAD_CLASS =\s*"([^"]*)"/);
  assert.ok(head, `${VISUALS}: TABLE_HEAD_CLASS is no longer a literal string.`);
  for (const token of ["text-phx-2xs", "font-black", "uppercase", "tracking-[0.12em]"]) {
    assert.ok(
      tokens(head[1]).includes(token),
      `${VISUALS}: TABLE_HEAD_CLASS lost "${token}". The "ACHIEVEMENT" header width in this test was measured with ` +
        `it — re-measure the header on the real pages and update TARGETS_NEEDS and VS_TARGET_NEEDS.`,
    );
  }
  const pill = visuals.match(/export function GrowthPill[\s\S]*?"(inline-flex [^"]*)"/);
  assert.ok(pill, `${VISUALS}: GrowthPill no longer builds its box from a literal className.`);
  for (const token of ["px-1.5", "gap-1", "text-xs", "font-bold"]) {
    assert.ok(
      tokens(pill[1]).includes(token),
      `${VISUALS}: GrowthPill lost "${token}". Its width in this test was measured with it — re-measure and update VS_TARGET_NEEDS.`,
    );
  }

  // ── Portal Targets grid ─────────────────────────────────────────────────────────────────────────
  const targets = checkTable({
    file: WORKSPACE,
    tablePx: TARGETS_NARROWEST_TABLE_PX,
    expectColumns: 6,
    expectedColSpan: /colSpan=\{6\}/,
    needs: TARGETS_NEEDS,
  });
  // The merge itself: one Target cell carries the value, the units and the unit price.
  const targetCell = targets.block.match(/<td className="[^"]*">(?:(?!<td )[\s\S])*?row\.targetValue(?:(?!<td )[\s\S])*?<\/td>/);
  assert.ok(targetCell, `${WORKSPACE}: no desktop cell renders row.targetValue.`);
  for (const part of ["row.targetUnits", "row.unitPrice"]) {
    assert.ok(
      targetCell[0].includes(part),
      `${WORKSPACE}: the Target cell no longer renders ${part}. Units and unit price ride in the Target cell — ` +
        `that merge is what gives Achievement the width to fit at 1024px.`,
    );
  }

  // ── Sales vs Target table ───────────────────────────────────────────────────────────────────────
  const vsTarget = checkTable({
    file: DASHBOARD,
    tablePx: VS_TARGET_NARROWEST_TABLE_PX,
    expectColumns: 5,
    expectedColSpan: /colSpan=\{5\}/,
    needs: VS_TARGET_NEEDS,
  });
  // The merge itself: the untargeted part of the sales rides under the Sales figure, and nothing
  // else in the row prints it.
  const salesCell = vsTarget.block.match(/<td className="[^"]*">(?:(?!<td )[\s\S])*?node\.current\.actualValue(?:(?!<td )[\s\S])*?<\/td>/);
  assert.ok(salesCell, `${DASHBOARD}: no desktop cell renders node.current.actualValue.`);
  assert.ok(
    salesCell[0].includes("node.current.uncoveredActualValue"),
    `${DASHBOARD}: the Sales cell no longer carries the "no target" amount. It was folded in there to take the ` +
      `table from six columns to five; a column of its own does not fit the 1024px portal.`,
  );
  assert.equal(
    (vsTarget.block.match(/node\.current\.uncoveredActualValue/g) ?? []).length,
    salesCell[0].match(/node\.current\.uncoveredActualValue/g)?.length ?? 0,
    `${DASHBOARD}: the "no target" amount is printed outside the Sales cell too — once is the merge, twice is a ` +
      `column coming back.`,
  );

  // ── A Medical Rep's own Targets table, published month ──────────────────────────────────────────
  // No drill-down row. Its merge: each money cell carries its units beneath it, so there is no units
  // column — and the view must not pad the table back into the 587px it had.
  const repTargets = checkTable({
    file: REP_TARGETS,
    tablePx: REP_TARGETS_NARROWEST_TABLE_PX,
    expectColumns: 5,
    needs: REP_TARGETS_NEEDS,
  });
  const repTargetCell = repTargets.block.match(/<td className="[^"]*">(?:(?!<td )[\s\S])*?product\.targetValue(?:(?!<td )[\s\S])*?<\/td>/);
  assert.ok(repTargetCell, `${REP_TARGETS}: no desktop cell renders product.targetValue.`);
  assert.ok(
    repTargetCell[0].includes("product.targetUnits"),
    `${REP_TARGETS}: the Target cell no longer carries its units. Units ride under the value — a units column of ` +
      `its own does not fit the 1024px portal.`,
  );
  const repRoot = repTargets.source.match(/<div className=\{cn\("([^"]*)", isPending/);
  assert.ok(repRoot, `${REP_TARGETS}: the view's root no longer builds its class from cn("…", isPending …). Re-point this check.`);
  for (const token of tokens(repRoot[1])) {
    assert.ok(
      !/^(?:[a-z0-9]+:)?p[xy]?-/.test(token),
      `${REP_TARGETS}: the view's root carries "${token}". Padding there narrows the table below the ${REP_TARGETS_NARROWEST_TABLE_PX}px ` +
        `this test measures — at 587px the Achievement header ran out of its cell.`,
    );
  }

  // ── Nothing on a Sales screen is drawn below 11px ────────────────────────────────────────────────
  // "raise the sales screens' fonts too" (owner, 2026-11-09). Every .tsx under src/components/sales is read, so
  // a new screen is held to it as well. The four target screens this test MEASURED keep their 10px heads and
  // labels: the widths above were taken with them, and moving one means re-measuring on the real pages.
  const measured = new Set([VISUALS, REP_TARGETS, "src/components/sales/targets-workspace.tsx", "src/components/sales/vs-target/vs-target-dashboard.tsx"]);
  let salesScreens = 0;
  for (const entry of readdirSync("src/components/sales", { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".tsx")) continue;
    const file = `src/components/sales/${entry.replace(/\\/g, "/")}`;
    salesScreens++;
    if (measured.has(file)) continue;
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b|text-\[(?:[1-9]|10)px\]/.test(stripComments(read(file))), `${file}: no text below 11px on a Sales screen`);
  }
  assert.ok(salesScreens >= 80, `the floor read every Sales screen (${salesScreens})`);
}
