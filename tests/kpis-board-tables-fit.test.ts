import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// THE FITS-THE-SCREEN GOLDEN RULE, pinned for the four tables of the KPIs board. /admin/kpis and
// /employee-portals/kpis render the same KpisBoardView, so one pin covers both shells.
//
// WHY THIS FILE EXISTS. On 2026-09-16 the owner measured the Coverage tab at a 1024px viewport,
// display scale 100%, and three heads were wider than their cells: PLANNED, COVERED and NOT
// REACHED, each in a 12% column. app/globals.css sets every `thead th` in both shells to 0.78rem
// black uppercase with letter-spacing, so a head is a word that cannot wrap, and at the portal's
// 619px table a 12% column is a 73px cell. Measured the same day on a harness built from the
// component's own class strings and both shells' real CSS (the cell's scrollWidth / clientWidth):
//
//     Coverage    Planned 81/73, Covered 78/73, Not reached 79/73
//     Frequency   Ungraded 94/73, Frequency 97/73. Its colgroup had SIX columns for five cells,
//                 copied from Coverage, so the last head sat in 12% beside a blank 26% strip
//     Call Rate   Pharmacy 94/92, Campaign 91/86, and `main` itself 624/621: a sideways scroll
//     Summary     no cell over, but the Frequency head ran 5px into its own padding
//
// THE WIDTH THAT MATTERS IS 619px. The portal's sidebar is 324px, so at a 1024px viewport its table
// is 619px wide: narrower than the admin shell's 703px, and narrower than anything from 768px to
// 1023px, where the sidebar is hidden and the table gets about 719px. The display-scale setting can
// only widen the table (80% is the default from 1024px), so 100% is the worst case.
//
// WHAT THIS TEST DOES. It does not compute a rendered width; that needs fonts and a layout engine,
// and a test that invented character widths would read as a measurement without being one. It
// pins the MEASUREMENT instead. For every column, MEASURED records the widest head or cell found at
// 619px on 2026-09-16, sort arrows showing, on the Phoenix and the legacy board, in the widest of
// Segoe UI, Segoe UI Variable and Aptos. A column's percentage may not fall below that need. (Arial,
// standing in for a Mac's Helvetica, is wider still: the six Coverage needs add up to 632px, which
// no split of 619px can hold, so there the Coverage heads use up to 3.6px of their 12px padding and
// the rep column 0.3px, and nothing spills out of a cell.) It also pins what the measurement stands
// on: one <col> per cell in the head row AND in the body row, widths summing to 100, every colSpan
// spanning them all, and the heads in the order they were measured.
//
// WHEN IT FIRES. Take the room from a column with slack, or merge two columns (AGENTS.md §4). Never
// shrink the type, never add a `min-w-*` floor or `overflow-x-auto`, never cut a head with an
// ellipsis. If a head's WORDS changed, its old need no longer describes it: measure the new head at
// 619px and record that here, rather than editing a number until this goes green.

const VIEW = "src/components/crm/kpis-board-view.tsx";
const VIEW_PATH = fileURLToPath(new URL(`../${VIEW}`, import.meta.url));

/** The portal's table at 1024px with the sidebar open and scale 100%: the narrowest on either shell. */
const NARROWEST_TABLE_PX = 619;

type TableName = "CoverageTable" | "FrequencyTable" | "CallRateTable" | "SummaryTable";

type MeasuredColumn = {
  /** The head as the source spells it. A head worded differently on a legacy board is listed by its
   * Phoenix wording; its need covers both. */
  head: string;
  /** The widest head or cell in the column, padding and sort arrow included, rounded up. */
  needPx: number;
};

const MEASURED: Record<TableName, MeasuredColumn[]> = {
  CoverageTable: [
    { head: "Medical rep", needPx: 139 },
    { head: "Planned", needPx: 97 },
    { head: "Covered", needPx: 94 },
    { head: "Not reached", needPx: 95 },
    { head: "Off plan", needPx: 66 },
    { head: "Coverage", needPx: 104 },
  ],
  FrequencyTable: [
    { head: "Medical rep", needPx: 139 },
    { head: "At norm", needPx: 74 },
    { head: "Below norm", needPx: 78 },
    { head: "Ungraded", needPx: 110 },
    { head: "Frequency", needPx: 113 },
  ],
  CallRateTable: [
    { head: "Medical rep", needPx: 139 },
    { head: "Days", needPx: 66 },
    { head: "AM", needPx: 59 },
    { head: "PM", needPx: 60 },
    { head: "Pharmacy", needPx: 111 },
    { head: "Campaign", needPx: 108 },
  ],
  SummaryTable: [
    { head: "Medical rep", needPx: 139 },
    { head: "Coverage", needPx: 104 },
    { head: "Frequency", needPx: 113 },
    { head: "AM", needPx: 67 },
    { head: "PM", needPx: 67 },
    // Added 2026-09-17 with the Overall column, and measured rather than chosen:
    // `node scripts/measure-kpis-table-heads.mjs`, a harness rebuilt from this component's own class
    // strings and both shells' real `thead th` CSS. The head governs by 26px (93px against a 67px
    // cell on Segoe UI), so this need is a head reading, which is the kind that harness reproduces
    // to the pixel: it re-measures Coverage at 105 against the recorded 104 and Frequency at 113
    // against 113 before it will report anything. 101px is the widest of the four families (Arial,
    // the no-stack fallback); 93px is Segoe UI, the family the 2026-09-16 needs are in. The wider
    // one is recorded deliberately — a need recorded too large only makes this pin stricter, and can
    // never hide an overflow.
    { head: "Overall", needPx: 101 },
  ],
};

/**
 * The components that ARE one cell. A tag missing from these is reported rather than skipped: a
 * skipped cell would make the <col> count add up while the table had one more column than the
 * colgroup, which is the defect this file was written for. So a new cell component belongs here —
 * `OverallCell` (2026-09-17) wraps a MeasureCell the way RepCell wraps a name.
 */
const HEAD_CELLS = new Set(["th", "KpiSortableTh", "RepNameTh"]);
const BODY_CELLS = new Set(["td", "RepCell", "MeasureCell", "OverallCell"]);

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsx(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagOf(node: JsxNode): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
}

function attributeOf(node: JsxNode, name: string): ts.JsxAttribute | undefined {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function firstTag(root: ts.Node, tag: string): ts.JsxElement | undefined {
  let found: ts.JsxElement | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(node) && tagOf(node) === tag) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
}

/** A head's words: the `label` of a sortable head, the text of a plain <th>. */
function headLabel(cell: JsxNode): string {
  const tag = tagOf(cell);
  if (tag === "RepNameTh") return "Medical rep";
  if (tag === "KpiSortableTh") {
    const initializer = attributeOf(cell, "label")?.initializer;
    if (initializer && ts.isStringLiteral(initializer)) return initializer.text;
    if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
      const expression = unwrap(initializer.expression);
      return ts.isStringLiteral(expression) ? expression.text : expression.getText();
    }
    return "(no label)";
  }
  const text = ts.isJsxElement(cell) ? cell.children.find((child) => ts.isJsxText(child) && child.text.trim()) : undefined;
  return text && ts.isJsxText(text) ? text.text.replace(/\s+/g, " ").trim() : "(no text)";
}

/**
 * The cells of one row, each as the labels it can show. A `{cond ? <A /> : <B />}` child is ONE
 * cell whichever branch renders: the Frequency heads switch wording under the Phoenix rules that
 * way, and counting both branches is how a sixth <col> could look right.
 */
function rowCells(row: ts.JsxElement, allowed: Set<string>, where: string, problems: string[]): string[][] {
  const cells: string[][] = [];
  const cellOf = (node: ts.Node): JsxNode | undefined =>
    isJsx(node) && allowed.has(tagOf(node)) ? node : undefined;
  for (const child of row.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim()) problems.push(`${where}: loose text "${child.text.trim()}" inside the row.`);
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue; // a {/* comment */}
      const expression = unwrap(child.expression);
      if (ts.isConditionalExpression(expression)) {
        const whenTrue = cellOf(unwrap(expression.whenTrue));
        const whenFalse = cellOf(unwrap(expression.whenFalse));
        if (whenTrue && whenFalse) {
          cells.push([headLabel(whenTrue), headLabel(whenFalse)]);
          continue;
        }
      }
      problems.push(
        `${where}: cannot count the cells of {${child.expression.getText().replace(/\s+/g, " ").slice(0, 60)}}. This test counts ` +
          `elements and two-branch conditionals of ${[...allowed].join(", ")}; anything else would make ` +
          `the <col> count unverifiable.`,
      );
      continue;
    }
    const cell = cellOf(child);
    if (cell) {
      cells.push(allowed === HEAD_CELLS ? [headLabel(cell)] : []);
      continue;
    }
    problems.push(`${where}: <${isJsx(child) ? tagOf(child) : child.getText().slice(0, 30)}> is not a cell this test knows.`);
  }
  return cells;
}

function colWidth(col: JsxNode): number | null {
  const initializer = attributeOf(col, "style")?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return null;
  const style = unwrap(initializer.expression);
  if (!ts.isObjectLiteralExpression(style)) return null;
  for (const property of style.properties) {
    if (!ts.isPropertyAssignment(property) || property.name.getText() !== "width") continue;
    const value = unwrap(property.initializer);
    const percent = ts.isStringLiteral(value) ? /^(\d+(?:\.\d+)?)%$/.exec(value.text) : null;
    return percent ? Number(percent[1]) : null;
  }
  return null;
}

/** Every way the four tables can fail the measurement, as sentences. Empty means they fit. */
export function kpisBoardTableFitProblems(source: string): string[] {
  const parsed = ts.createSourceFile(VIEW, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const problems: string[] = [];

  for (const [name, measured] of Object.entries(MEASURED) as [TableName, MeasuredColumn[]][]) {
    const fn = parsed.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    const table = fn ? firstTag(fn, "table") : undefined;
    if (!fn || !table) {
      problems.push(`${name}: no such function with a <table> in ${VIEW}. Renamed? Update MEASURED to follow it.`);
      continue;
    }

    const className = attributeOf(table, "className")?.initializer;
    const classes = className && ts.isStringLiteral(className) ? className.text.split(/\s+/) : [];
    for (const required of ["w-full", "table-fixed"]) {
      if (!classes.includes(required)) {
        problems.push(`${name}: the <table> lost "${required}". Without it the widest row sets the width again.`);
      }
    }

    const colgroup = firstTag(table, "colgroup");
    const cols = colgroup ? colgroup.children.filter(isJsx).filter((child) => tagOf(child) === "col") : [];
    const widths = cols.map(colWidth);
    if (cols.length === 0 || widths.some((width) => width === null)) {
      problems.push(`${name}: every <col> needs style={{ width: "N%" }}; found ${JSON.stringify(widths)}.`);
      continue;
    }
    const percents = widths as number[];
    const total = percents.reduce((sum, width) => sum + width, 0);
    if (Math.abs(total - 100) > 1e-9) {
      problems.push(`${name}: the colgroup ${JSON.stringify(percents)} totals ${total}%, not 100%.`);
    }

    const headRow = firstTag(firstTag(table, "thead") ?? table, "tr");
    const bodyRow = firstTag(firstTag(table, "tbody") ?? table, "tr");
    if (!headRow || !bodyRow) {
      problems.push(`${name}: could not find the <thead> row and the first <tbody> row.`);
      continue;
    }
    const heads = rowCells(headRow, HEAD_CELLS, `${name} head row`, problems);
    const bodyCells = rowCells(bodyRow, BODY_CELLS, `${name} body row`, problems);
    if (heads.length !== cols.length || bodyCells.length !== cols.length) {
      problems.push(
        `${name}: ${cols.length} <col> entries for ${heads.length} head cells and ${bodyCells.length} body ` +
          `cells. They must agree, or every column after the mismatch is sized by the wrong <col>.`,
      );
    }

    const spans: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === "colSpan") {
        const initializer = node.initializer;
        const value = initializer && ts.isJsxExpression(initializer) && initializer.expression;
        spans.push(value && ts.isNumericLiteral(value) ? Number(value.text) : Number.NaN);
      }
      ts.forEachChild(node, visit);
    };
    visit(table);
    for (const span of spans) {
      if (span !== cols.length) {
        problems.push(`${name}: a cell has colSpan={${span}} in a ${cols.length}-column table.`);
      }
    }

    if (heads.length !== measured.length || cols.length !== measured.length) {
      problems.push(
        `${name}: ${heads.length} heads and ${cols.length} columns, but ${measured.length} were measured. ` +
          `Measure the new layout at ${NARROWEST_TABLE_PX}px and record it in MEASURED.`,
      );
      continue;
    }
    measured.forEach((column, index) => {
      if (!heads[index].includes(column.head)) {
        problems.push(
          `${name}: column ${index + 1} was measured as "${column.head}" and now reads ` +
            `${heads[index].map((label) => `"${label}"`).join(" / ")}. Measure it at ${NARROWEST_TABLE_PX}px ` +
            `and record the new head and need in MEASURED.`,
        );
        return;
      }
      const floor = Math.ceil((column.needPx / NARROWEST_TABLE_PX) * 100);
      if (percents[index] < floor) {
        const px = Math.floor((percents[index] / 100) * NARROWEST_TABLE_PX);
        problems.push(
          `${name}: "${column.head}" is ${percents[index]}%, about ${px}px of the ${NARROWEST_TABLE_PX}px ` +
            `table, and it needs ${column.needPx}px. It must stay at ${floor}% or more.`,
        );
      }
    });
  }
  return problems;
}

export function runKpisBoardTablesFitTests() {
  const problems = kpisBoardTableFitProblems(readFileSync(VIEW_PATH, "utf8"));
  assert.deepEqual(
    problems,
    [],
    `${VIEW}: the KPIs board's tables no longer fit the portal's ${NARROWEST_TABLE_PX}px table at 1024px:\n\n` +
      `${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      `Take the room from a column with slack or merge two columns. Never shrink the type, never add ` +
      `min-width or overflow-x-auto, never truncate a head (AGENTS.md §4).`,
  );

  // The opened doctors panel is the row's own: TableRowDetail, never a hand-written second <tr><td colSpan>.
  const view = readFileSync(VIEW_PATH, "utf8");
  assert.equal(
    (view.match(/<TableRowDetail\b/g) ?? []).length,
    2,
    `${VIEW}: the Coverage and Frequency tables open their doctors list with TableRowDetail.`,
  );
  assert.ok(!/<td[^>]*colSpan/.test(view), `${VIEW}: a hand-written <td colSpan> second row came back; use TableRowDetail.`);
}
