import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  branchComparisonColumns,
  breakdownColumns,
  completenessColumns,
  excludedBranchColumns,
  excludedItemColumns,
  fieldForceLeagueColumns,
  fieldForceProductColumns,
  fileSelfCheckColumns,
  rankColumns,
  rowIssueColumns,
  uploadHistoryColumns,
  uploadSummaryColumns,
  uploadTrackerColumns,
  verifyColumns,
  weekComparisonColumns,
  zeroStockColumns,
} from "../src/components/sales/weekly/weekly-table-widths.ts";

// THE FITS-THE-SCREEN AND SQUARE-EDGE GOLDEN RULES (AGENTS.md §4), pinned for Weekly Sales: the
// managers' dashboard (its Distribution tab and its Field Force tab, which the portal and the admin
// shell render alike), the admin shell's own Weekly Sales Dashboard, and the admin shell's upload page.
//
// THE REST OF THE UPLOAD PAGE. Later on 2026-09-17 the rest of weekly-upload-workspace.tsx still broke
// both rules. The Recent weekly uploads table sat in an `overflow-x-auto` card, the file self-check and
// the two excluded-on-purpose tables in `overflow-x-auto` boxes, the row issues in a `max-h-56
// overflow-auto` box, the By product / branch / region summaries in `max-h-72 overflow-auto`, and the
// month tracker in `overflow-x-auto` with its marks over `min-w-[2.2rem]`. The shared `card` was
// `rounded-[6px]` and about fifty more `rounded*` classes sat on its chips, buttons, inputs and step
// dots. Every table is now fixed with declared widths and becomes cards (or, for the row issues, a list)
// below md; the uploads table merges Period with Week and Distributor with Status. The whole file is
// scanned, and all eight of its tables are pinned.
//
// THE UPLOAD PAGE'S VERIFICATION PANEL. Also on 2026-09-17 the panel a distributor file's column check
// opens (VerifyPanel in weekly-upload-workspace.tsx) still sat its six-column table in an
// `overflow-x-auto` box, and its status pill, "AI checked" chip and header-hint chips were `rounded`.
// File and Col are now one column, the table is fixed from md up and becomes cards below it, and nothing
// in the panel is rounded.
//
// THE ADMIN DASHBOARD. On 2026-09-17 the admin shell's dashboard (weekly-dashboard-view-impl.tsx) still
// broke both rules after the managers' version was fixed: the Week-by-week comparison sat in an
// `overflow-x-auto` box, the ranked tables and Branches comparison sat over `min-w-[620px]` and
// `min-w-[760px]`, the trend tooltip over `min-w-[200px]`, and the file carried 37 `rounded*` classes.
// Its chart labels were cut with "..." and two legend names with `truncate`. Its four tables now declare
// their widths the same way (sortable headers count as head cells), each becomes cards below md, and
// its chart labels wrap whole. Since the same day its Units and Stock columns appear only while their
// figures are one product's (unit-totals.ts), so each of those tables is held with and without them.
//
// WHY THIS FILE EXISTS. On 2026-09-16 the owner found both rules broken on this page. The dashboard's
// Breakdown table and upload completeness matrix sat in `hidden overflow-x-auto md:block` boxes, so a
// desktop narrower than the table scrolled sideways inside the card. The Field Force league put the rep,
// the area and the district manager in columns of their own over `min-w-[880px]`, and the product grid
// a rep row opens sat over `min-w-[620px]`, each in a scroll box. The dashboard carried 25 `rounded*`
// classes and the Field Force tab 21. The fix gives every table a fixed layout with each column's width
// declared (weekly-table-widths.ts). It fits by MERGING columns: the area and district manager now sit
// under the rep's name, and the matrix holds one column per MONTH with its four week marks in it. Long
// names wrap, and phones keep their cards.
//
// WHAT IT PINS.
//   1. No class string in the three dashboard files or in the upload page draws a round corner, a scroll
//      box, a width floor or an ellipsis, and no label is cut by appending "..." to it.
//   2. Every <table> is `w-full table-fixed` and opens with a <colgroup>. Its <col>s, its head row (which
//      a table pinned `headless` may lack) and a body row have the same shape: one entry per cell, under
//      the same conditions, with the same per-week or per-month lists. Every colSpan spans exactly that
//      shape, the widths come from the helper this test names, and the widths the shape draws total 100%
//      for every count of weeks or months the data allows and every optional column.
//
// WHEN IT FIRES. Take the room from a column with slack, or merge two columns. Never shrink the type,
// never add a min-width or overflow-x-auto, never cut text with an ellipsis (AGENTS.md §4).

const DASHBOARD = "src/components/sales/weekly/portal-weekly-dashboard-impl.tsx";
const FIELD_FORCE = "src/components/sales/weekly/portal-weekly-field-force-view.tsx";
const ADMIN_DASHBOARD = "src/components/sales/weekly/weekly-dashboard-view-impl.tsx";
const UPLOAD_WORKSPACE = "src/components/sales/weekly/weekly-upload-workspace.tsx";

/** What is read of each file: all of it, or only the named functions. */
const SCANS: { file: string; functions: string[] | null; minTokens: number }[] = [
  { file: DASHBOARD, functions: null, minTokens: 200 },
  { file: FIELD_FORCE, functions: null, minTokens: 200 },
  { file: ADMIN_DASHBOARD, functions: null, minTokens: 200 },
  { file: UPLOAD_WORKSPACE, functions: null, minTokens: 200 },
];

/** `weekly_sales_rows_week_number_chk`: a week number is 1 to 4, so no view has more than four weeks. */
const MAX_WEEKS = 4;
/** CompletenessTracker shows the three most recent months. */
const MAX_MONTHS = 3;

// ── 1. class strings ────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN: { rule: string; matches: (utility: string) => boolean }[] = [
  { rule: "a round corner (the square-edge golden rule)", matches: (utility) => /^rounded(-|$)/.test(utility) },
  {
    rule: "a scroll box (the fits-the-screen golden rule)",
    matches: (utility) => /^overflow-(x-)?(auto|scroll)$/.test(utility),
  },
  {
    rule: "a width floor that outgrows the screen",
    matches: (utility) => /^min-w-(\[|\(|max$|fit$|screen$)/.test(utility),
  },
  {
    rule: "an ellipsis (text wraps instead)",
    matches: (utility) => /^(truncate$|text-ellipsis$|line-clamp-)/.test(utility),
  },
];

function parse(rel: string): ts.SourceFile {
  const text = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** Every string a class can be spelled in: string literals, template text, JSX attribute strings. */
function classStringProblems(source: ts.SourceFile, roots: ts.Node[], minTokens: number): string[] {
  const problems: string[] = [];
  let tokens = 0;
  const visit = (node: ts.Node): void => {
    const text =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : null;
    // `${name.slice(0, 17)}...`: text that continues a substitution with an ellipsis is a label cut short.
    if ((ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /^(\.\.\.|…)/.test(node.text)) {
      problems.push(`${source.fileName}:${lineOf(source, node)} cuts a label with "${node.text}"; let it wrap instead.`);
    }
    if (text !== null) {
      for (const token of text.split(/\s+/)) {
        if (!token) continue;
        tokens += 1;
        // `md:rounded-lg`, `!rounded`, `rounded!`: the utility is what follows the last variant.
        const utility = (token.split(":").pop() ?? "").replace(/^!|!$/g, "");
        const hit = FORBIDDEN.find((rule) => rule.matches(utility));
        if (hit) problems.push(`${source.fileName}:${lineOf(source, node)} "${token}" is ${hit.rule}.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  // Positive control: a file this test failed to read as TSX would otherwise pass with nothing found.
  if (tokens < minTokens) {
    problems.push(`${source.fileName}: only ${tokens} class tokens were read; the scan is not seeing the file.`);
  }
  return problems;
}

// ── 2. tables ───────────────────────────────────────────────────────────────────────────────────────

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

/** One entry of a colgroup or a row: a single cell (maybe under a condition), or one cell per item. */
type Slot = { kind: "one"; guard: string | null; key: string | null } | { kind: "each"; over: string; key: string | null };

type Env = Record<string, number | boolean>;

type TableSpec = {
  name: string;
  file: string;
  /** The function whose JSX holds the <table>. */
  owner: string;
  /** The function whose first <tr> is a body row (the owner, unless rows render through a component). */
  bodyRowOwner: string;
  /** How the owner must obtain its widths, verbatim. */
  widthsCall: string;
  /** The table has no head row (a list of messages), so only its <col>s and body row are compared. */
  headless?: boolean;
  /** Every input the page can give the helper: `env` answers the shape's conditions and list lengths. */
  cases: { env: Env; widths: Record<string, number> }[];
};

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

const TABLES: TableSpec[] = [
  {
    name: "Field Force league",
    file: FIELD_FORCE,
    owner: "PortalWeeklyFieldForceView",
    bodyRowOwner: "RepRow",
    widthsCall: "fieldForceLeagueColumns(weeks.length)",
    cases: range(0, MAX_WEEKS).map((weeks) => ({ env: { weeks }, widths: fieldForceLeagueColumns(weeks) })),
  },
  {
    name: "Field Force product grid",
    file: FIELD_FORCE,
    owner: "ProductGrid",
    bodyRowOwner: "ProductGrid",
    widthsCall: "fieldForceProductColumns(weeks.length)",
    cases: range(0, MAX_WEEKS).map((weeks) => ({ env: { weeks }, widths: fieldForceProductColumns(weeks) })),
  },
  {
    name: "Distribution breakdown",
    file: DASHBOARD,
    owner: "WeeklyDetailSection",
    bodyRowOwner: "WeeklyDetailSection",
    widthsCall: "breakdownColumns(showUnits, showDelta)",
    cases: [true, false].flatMap((showUnits) =>
      [true, false].map((showDelta) => ({
        env: { showUnits, showDelta },
        widths: breakdownColumns(showUnits, showDelta),
      })),
    ),
  },
  {
    name: "Upload completeness matrix",
    file: DASHBOARD,
    owner: "CompletenessTracker",
    bodyRowOwner: "CompletenessTracker",
    widthsCall: "completenessColumns(months.length)",
    cases: range(1, MAX_MONTHS).map((months) => ({ env: { months }, widths: completenessColumns(months) })),
  },
  {
    name: "Admin ranked table (By region, By product, By distributor)",
    file: ADMIN_DASHBOARD,
    owner: "RankTable",
    bodyRowOwner: "RankTable",
    widthsCall: "rankColumns(showUnits)",
    cases: [true, false].map((showUnits) => ({ env: { showUnits }, widths: rankColumns(showUnits) })),
  },
  {
    name: "Admin Branches comparison",
    file: ADMIN_DASHBOARD,
    owner: "BranchComparisonTable",
    bodyRowOwner: "BranchComparisonTable",
    widthsCall: "branchComparisonColumns(showUnits)",
    cases: [true, false].map((showUnits) => ({ env: { showUnits }, widths: branchComparisonColumns(showUnits) })),
  },
  {
    name: "Admin Week-by-week comparison",
    file: ADMIN_DASHBOARD,
    owner: "WeekComparisonTable",
    bodyRowOwner: "WeekComparisonTable",
    widthsCall: "weekComparisonColumns(showUnits)",
    cases: [true, false].map((showUnits) => ({ env: { showUnits }, widths: weekComparisonColumns(showUnits) })),
  },
  {
    name: "Admin Stock on hand watchlist",
    file: ADMIN_DASHBOARD,
    owner: "ZeroStockTable",
    bodyRowOwner: "ZeroStockTable",
    widthsCall: "zeroStockColumns(showStock)",
    cases: [true, false].map((showStock) => ({ env: { showStock }, widths: zeroStockColumns(showStock) })),
  },
  {
    name: "Upload verification panel",
    file: UPLOAD_WORKSPACE,
    owner: "VerifyPanel",
    bodyRowOwner: "VerifyPanel",
    widthsCall: "verifyColumns()",
    cases: [{ env: {}, widths: verifyColumns() }],
  },
  {
    name: "Upload page Recent weekly uploads",
    file: UPLOAD_WORKSPACE,
    owner: "WeeklyUploadWorkspace",
    bodyRowOwner: "WeeklyUploadWorkspace",
    widthsCall: "uploadHistoryColumns()",
    cases: [{ env: {}, widths: uploadHistoryColumns() }],
  },
  {
    name: "Upload page items excluded on purpose",
    file: UPLOAD_WORKSPACE,
    owner: "ExcludedItemsPanel",
    bodyRowOwner: "ExcludedItemsPanel",
    widthsCall: "excludedItemColumns()",
    cases: [{ env: {}, widths: excludedItemColumns() }],
  },
  {
    name: "Upload page branches excluded on purpose",
    file: UPLOAD_WORKSPACE,
    owner: "ExcludedBranchesPanel",
    bodyRowOwner: "ExcludedBranchesPanel",
    widthsCall: "excludedBranchColumns()",
    cases: [{ env: {}, widths: excludedBranchColumns() }],
  },
  {
    name: "Upload page file self-check",
    file: UPLOAD_WORKSPACE,
    owner: "FileSelfCheckPanel",
    bodyRowOwner: "FileSelfCheckPanel",
    widthsCall: "fileSelfCheckColumns()",
    cases: [{ env: {}, widths: fileSelfCheckColumns() }],
  },
  {
    name: "Upload page row issues",
    file: UPLOAD_WORKSPACE,
    owner: "ValidationResultPanel",
    bodyRowOwner: "ValidationResultPanel",
    widthsCall: "rowIssueColumns()",
    headless: true,
    cases: [{ env: {}, widths: rowIssueColumns() }],
  },
  {
    name: "Upload page By product / branch / region summary",
    file: UPLOAD_WORKSPACE,
    owner: "SummaryTable",
    bodyRowOwner: "SummaryTable",
    widthsCall: "uploadSummaryColumns()",
    cases: [{ env: {}, widths: uploadSummaryColumns() }],
  },
  {
    name: "Upload page month tracker",
    file: UPLOAD_WORKSPACE,
    owner: "MonthCompletenessTracker",
    bodyRowOwner: "MonthCompletenessTracker",
    widthsCall: "uploadTrackerColumns(weeks.length)",
    cases: range(1, MAX_WEEKS).map((weeks) => ({ env: { weeks }, widths: uploadTrackerColumns(weeks) })),
  },
];

/** The elements that render one cell of each kind. A `SortableTh` is a <th> holding a sort button. */
const CELL_TAGS: Record<string, string[]> = { col: ["col"], th: ["th", "SortableTh"], td: ["td"] };

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

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ? unwrap(expression.expression) : expression;
}

function allTags(root: ts.Node, tag: string): JsxNode[] {
  const found: JsxNode[] = [];
  const visit = (node: ts.Node): void => {
    if (isJsx(node) && tagOf(node) === tag) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function firstElement(root: ts.Node, tag: string): ts.JsxElement | undefined {
  return allTags(root, tag).find((node): node is ts.JsxElement => ts.isJsxElement(node));
}

function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return source.statements.find(
    (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

/** The initializers of the module-level consts that the given nodes read by name. */
function moduleConstsReadBy(source: ts.SourceFile, nodes: ts.Node[]): ts.Node[] {
  const read = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) read.add(node.text);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
  const initializers: ts.Node[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && read.has(declaration.name.text) && declaration.initializer) {
        initializers.push(declaration.initializer);
      }
    }
  }
  return initializers;
}

/** The first `const <name> = …` under a node, as its source text on one line. */
function initializerText(root: ts.Node, name: string): string | null {
  if (ts.isVariableDeclaration(root) && root.name.getText() === name && root.initializer) {
    return root.initializer.getText().replace(/\s+/g, " ");
  }
  return ts.forEachChild(root, (child) => initializerText(child, name) ?? undefined) ?? null;
}

/** The `columns.<key>` a <col> takes its width from: `style={{ width: `${columns.key}%` }}`, exactly. */
function colKey(col: JsxNode): string | null {
  const initializer = attributeOf(col, "style")?.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return null;
  const style = unwrap(initializer.expression);
  if (!ts.isObjectLiteralExpression(style) || style.properties.length !== 1) return null;
  const [property] = style.properties;
  if (!ts.isPropertyAssignment(property) || property.name.getText() !== "width") return null;
  const value = unwrap(property.initializer);
  if (!ts.isTemplateExpression(value) || value.head.text !== "" || value.templateSpans.length !== 1) return null;
  const [span] = value.templateSpans;
  const read = unwrap(span.expression);
  if (span.literal.text !== "%" || !ts.isPropertyAccessExpression(read) || read.expression.getText() !== "columns") {
    return null;
  }
  return read.name.text;
}

/** The single cell a `.map` callback returns, whether its body is an expression or a block. */
function returnedCell(callback: ts.Expression | undefined, isCell: (node: ts.Node) => node is JsxNode): JsxNode | null {
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return null;
  if (!ts.isBlock(callback.body)) {
    const body = unwrap(callback.body);
    return isCell(body) ? body : null;
  }
  const returns = callback.body.statements.filter(ts.isReturnStatement);
  const last = returns.at(-1)?.expression;
  return returns.length === 1 && last && isCell(unwrap(last)) ? (unwrap(last) as JsxNode) : null;
}

function slotsOf(container: ts.JsxElement, cellTag: string, where: string, problems: string[]): Slot[] {
  const isCell = (node: ts.Node): node is JsxNode => isJsx(node) && (CELL_TAGS[cellTag] ?? [cellTag]).includes(tagOf(node));
  const keyOf = (cell: JsxNode): string | null => {
    if (cellTag !== "col") return null;
    const key = colKey(cell);
    if (key === null) problems.push(`${where}: a <col> must read style={{ width: \`\${columns.<key>}%\` }}.`);
    return key;
  };
  const slots: Slot[] = [];
  for (const child of container.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim()) problems.push(`${where}: loose text "${child.text.trim()}".`);
      continue;
    }
    if (ts.isJsxExpression(child)) {
      if (!child.expression) continue; // a {/* comment */}
      const expression = unwrap(child.expression);
      if (ts.isConditionalExpression(expression)) {
        const whenTrue = unwrap(expression.whenTrue);
        const whenFalse = unwrap(expression.whenFalse);
        if (isCell(whenTrue) && whenFalse.kind === ts.SyntaxKind.NullKeyword) {
          slots.push({ kind: "one", guard: expression.condition.getText(), key: keyOf(whenTrue) });
          continue;
        }
      }
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "map"
      ) {
        const cell = returnedCell(expression.arguments[0], isCell);
        if (cell) {
          slots.push({ kind: "each", over: expression.expression.expression.getText(), key: keyOf(cell) });
          continue;
        }
      }
      problems.push(
        `${where}: cannot count the cells of {${child.expression.getText().replace(/\s+/g, " ").slice(0, 70)}}. ` +
          `This test counts <${cellTag}> elements, {condition ? <${cellTag}> : null} and a .map returning one <${cellTag}>.`,
      );
      continue;
    }
    if (isCell(child)) {
      slots.push({ kind: "one", guard: null, key: keyOf(child) });
      continue;
    }
    problems.push(`${where}: <${isJsx(child) ? tagOf(child) : child.getText().slice(0, 30)}> is not a <${cellTag}>.`);
  }
  return slots;
}

function shapeOf(slots: Slot[]): string {
  return slots.map((slot) => (slot.kind === "each" ? `each ${slot.over}` : slot.guard ? `if ${slot.guard}` : "one")).join(" | ");
}

/**
 * The colSpan that spans a shape, as the source must spell it; null when the shape has no single spelling.
 * The cells every row has come first, then each condition's cells in the order the condition first appears:
 * `3 + (showUnits ? 2 : 0)` spans three columns plus the two that come and go with `showUnits`.
 */
function spanOf(slots: Slot[]): string | null {
  const lists = slots.filter((slot): slot is Extract<Slot, { kind: "each" }> => slot.kind === "each");
  if (lists.length > 1) return null;
  let ones = 0;
  const guarded = new Map<string, number>();
  for (const slot of slots) {
    if (slot.kind !== "one") continue;
    if (slot.guard) guarded.set(slot.guard, (guarded.get(slot.guard) ?? 0) + 1);
    else ones += 1;
  }
  const base = lists.length === 1 ? `${lists[0].over}.length + ${ones}` : String(ones);
  return [base, ...[...guarded].map(([guard, count]) => `(${guard} ? ${count} : 0)`)].join(" + ");
}

function tableProblems(sources: Map<string, ts.SourceFile>, roots: Map<string, ts.Node[]>): string[] {
  const problems: string[] = [];

  for (const file of sources.keys()) {
    const pinned = TABLES.filter((table) => table.file === file).length;
    const tables = (roots.get(file) ?? []).reduce((count, root) => count + allTags(root, "table").length, 0);
    if (tables !== pinned) {
      problems.push(`${file}: ${tables} <table> elements, but this test pins ${pinned}. Add the new table to TABLES.`);
    }
  }

  for (const spec of TABLES) {
    const source = sources.get(spec.file);
    if (!source) {
      problems.push(`${spec.name}: ${spec.file} was not read.`);
      continue;
    }
    const owner = functionNamed(source, spec.owner);
    const bodyOwner = functionNamed(source, spec.bodyRowOwner);
    const table = owner ? firstElement(owner, "table") : undefined;
    if (!owner || !bodyOwner || !table) {
      problems.push(`${spec.name}: ${spec.owner} with a <table>, or ${spec.bodyRowOwner}, is gone from ${spec.file}.`);
      continue;
    }

    const className = attributeOf(table, "className")?.initializer;
    const classes = className && ts.isStringLiteral(className) ? className.text.split(/\s+/) : [];
    for (const required of ["w-full", "table-fixed"]) {
      if (!classes.includes(required)) {
        problems.push(`${spec.name}: the <table> lost "${required}". Without it the widest row sets the width again.`);
      }
    }

    const firstChild = table.children.find((child) => isJsx(child));
    const colgroup = firstChild && ts.isJsxElement(firstChild) && tagOf(firstChild) === "colgroup" ? firstChild : undefined;
    if (!colgroup) {
      problems.push(`${spec.name}: the <table> must open with a <colgroup> declaring every column's width.`);
      continue;
    }

    const widthsCall = initializerText(owner, "columns");
    if (widthsCall !== spec.widthsCall) {
      problems.push(`${spec.name}: ${spec.owner} must take its widths from ${spec.widthsCall}; found ${widthsCall ?? "nothing"}.`);
    }

    const cols = slotsOf(colgroup, "col", `${spec.name} <colgroup>`, problems);
    const thead = firstElement(table, "thead");
    const headRow = thead ? firstElement(thead, "tr") : undefined;
    const tbody = spec.owner === spec.bodyRowOwner ? firstElement(table, "tbody") : bodyOwner;
    const bodyRow = tbody ? firstElement(tbody, "tr") : undefined;
    if ((!headRow && !spec.headless) || !bodyRow) {
      problems.push(`${spec.name}: could not find the head row and a body row.`);
      continue;
    }
    // A headless table's head row, should it gain one, is held like any other.
    const heads = headRow ? slotsOf(headRow, "th", `${spec.name} head row`, problems) : null;
    const cells = slotsOf(bodyRow, "td", `${spec.name} body row`, problems);
    if ((heads !== null && shapeOf(heads) !== shapeOf(cols)) || shapeOf(cells) !== shapeOf(cols)) {
      problems.push(
        `${spec.name}: the columns are [${shapeOf(cols)}], the head row [${heads === null ? "none" : shapeOf(heads)}] and the body row ` +
          `[${shapeOf(cells)}]. They must agree, or every column after the mismatch is sized by the wrong <col>.`,
      );
    }

    // The league's band rows live in its owner and the opened row in RepRow, which holds the product
    // grid as a component, so the grid's own cells are never counted here. A `TableNoResults` is the
    // empty-search row, one cell spanning the table.
    const span = spanOf(cols);
    for (const root of new Set([owner, bodyOwner])) {
      for (const cell of [...allTags(root, "td"), ...allTags(root, "th"), ...allTags(root, "TableNoResults"), ...allTags(root, "TableRowDetail")]) {
        const attribute = attributeOf(cell, "colSpan");
        if (!attribute) continue;
        const value = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
        const text = value ? value.getText().replace(/\s+/g, " ") : "(none)";
        if (span === null || text !== span) {
          problems.push(
            `${spec.name}: line ${lineOf(source, cell)} has colSpan={${text}}; the columns are ` +
              `[${shapeOf(cols)}], so it must be ${span === null ? "a shape with one spelling" : `{${span}}`}.`,
          );
        }
      }
    }

    for (const { env, widths } of spec.cases) {
      const drawn: number[] = [];
      for (const col of cols) {
        const width = col.key === null ? Number.NaN : widths[col.key];
        if (col.kind === "each") {
          const count = env[col.over];
          if (typeof count !== "number") {
            problems.push(`${spec.name}: the cases do not say how many ${col.over} there are.`);
            continue;
          }
          for (let index = 0; index < count; index += 1) drawn.push(width);
        } else if (col.guard !== null && typeof env[col.guard] !== "boolean") {
          problems.push(`${spec.name}: the cases do not answer the condition ${col.guard}.`);
        } else if (col.guard === null || env[col.guard] === true) {
          drawn.push(width);
        }
      }
      const total = drawn.reduce((sum, width) => sum + width, 0);
      if (drawn.some((width) => !(width > 0)) || Math.abs(total - 100) > 1e-9) {
        problems.push(
          `${spec.name}: with ${JSON.stringify(env)} the columns draw ${JSON.stringify(drawn)}, totalling ${total}%. ` +
            `Every column needs a width above 0 and together they must total 100%.`,
        );
      }
    }
  }
  return problems;
}

export function runWeeklySalesFitsTheScreenTests() {
  const sources = new Map<string, ts.SourceFile>();
  const roots = new Map<string, ts.Node[]>();
  const classProblems: string[] = [];
  for (const scan of SCANS) {
    const source = parse(scan.file);
    sources.set(scan.file, source);
    const scanned: ts.Node[] = [];
    for (const name of scan.functions ?? []) {
      const found = functionNamed(source, name);
      if (found) scanned.push(found);
      else classProblems.push(`${scan.file}: ${name} is gone, so this test cannot hold it.`);
    }
    // A class string the functions borrow from a module-level const (`${card}`) is theirs too: the
    // panel's own box was rounded that way.
    scanned.push(...moduleConstsReadBy(source, scanned));
    roots.set(scan.file, scan.functions === null ? [source] : scanned);
    classProblems.push(...classStringProblems(source, roots.get(scan.file) ?? [], scan.minTokens));
  }
  assert.deepEqual(
    classProblems,
    [],
    `Weekly Sales draws what the golden rules forbid:\n\n${classProblems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      `Square corners only; fit by merging columns, never by a scroll box or a width floor; wrap, never truncate (AGENTS.md §4).`,
  );

  const problems = tableProblems(sources, roots);
  assert.deepEqual(
    problems,
    [],
    `Weekly Sales' tables no longer fit by construction:\n\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      `Take the room from a column with slack or merge two columns. Never shrink the type, never add ` +
      `min-width or overflow-x-auto, never truncate (AGENTS.md §4).`,
  );
}
