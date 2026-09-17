import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  breakdownColumns,
  completenessColumns,
  fieldForceLeagueColumns,
  fieldForceProductColumns,
} from "../src/components/sales/weekly/weekly-table-widths.ts";

// THE FITS-THE-SCREEN AND SQUARE-EDGE GOLDEN RULES (AGENTS.md §4), pinned for the managers' Weekly
// Sales: the dashboard's Distribution tab and its Field Force tab, which the portal and the admin shell
// render alike.
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
//   1. No class string in either file draws a round corner, a scroll box, a width floor or an ellipsis.
//   2. Every <table> is `w-full table-fixed` and opens with a <colgroup>. Its <col>s, its head row and a
//      body row have the same shape: one entry per cell, under the same conditions, with the same
//      per-week or per-month lists. Every colSpan spans exactly that shape, the widths come from the
//      helper this test names, and the widths the shape draws total 100% for every count of weeks or
//      months the data allows and every optional column.
//
// WHEN IT FIRES. Take the room from a column with slack, or merge two columns. Never shrink the type,
// never add a min-width or overflow-x-auto, never cut text with an ellipsis (AGENTS.md §4).

const DASHBOARD = "src/components/sales/weekly/portal-weekly-dashboard-impl.tsx";
const FIELD_FORCE = "src/components/sales/weekly/portal-weekly-field-force-view.tsx";

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
function classStringProblems(source: ts.SourceFile): string[] {
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
  visit(source);
  // Positive control: a file this test failed to read as TSX would otherwise pass with nothing found.
  if (tokens < 200) problems.push(`${source.fileName}: only ${tokens} class tokens were read; the scan is not seeing the file.`);
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
];

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
  const isCell = (node: ts.Node): node is JsxNode => isJsx(node) && tagOf(node) === cellTag;
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

/** The colSpan that spans a shape, as the source must spell it; null when the shape has no single spelling. */
function spanOf(slots: Slot[]): string | null {
  if (slots.some((slot) => slot.kind === "one" && slot.guard)) return null;
  const lists = slots.filter((slot): slot is Extract<Slot, { kind: "each" }> => slot.kind === "each");
  const ones = slots.length - lists.length;
  if (lists.length === 0) return String(ones);
  if (lists.length === 1) return `${lists[0].over}.length + ${ones}`;
  return null;
}

function tableProblems(sources: Map<string, ts.SourceFile>): string[] {
  const problems: string[] = [];

  for (const [file, source] of sources) {
    const pinned = TABLES.filter((table) => table.file === file).length;
    const tables = allTags(source, "table").length;
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
    if (!headRow || !bodyRow) {
      problems.push(`${spec.name}: could not find the head row and a body row.`);
      continue;
    }
    const heads = slotsOf(headRow, "th", `${spec.name} head row`, problems);
    const cells = slotsOf(bodyRow, "td", `${spec.name} body row`, problems);
    if (shapeOf(heads) !== shapeOf(cols) || shapeOf(cells) !== shapeOf(cols)) {
      problems.push(
        `${spec.name}: the columns are [${shapeOf(cols)}], the head row [${shapeOf(heads)}] and the body row ` +
          `[${shapeOf(cells)}]. They must agree, or every column after the mismatch is sized by the wrong <col>.`,
      );
    }

    // The league's band rows live in its owner and the opened row in RepRow, which holds the product
    // grid as a component, so the grid's own cells are never counted here.
    const span = spanOf(cols);
    for (const root of new Set([owner, bodyOwner])) {
      for (const cell of [...allTags(root, "td"), ...allTags(root, "th")]) {
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
  const sources = new Map([DASHBOARD, FIELD_FORCE].map((file) => [file, parse(file)] as const));

  const classProblems = [...sources.values()].flatMap(classStringProblems);
  assert.deepEqual(
    classProblems,
    [],
    `Weekly Sales draws what the golden rules forbid:\n\n${classProblems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      `Square corners only; fit by merging columns, never by a scroll box or a width floor; wrap, never truncate (AGENTS.md §4).`,
  );

  const problems = tableProblems(sources);
  assert.deepEqual(
    problems,
    [],
    `Weekly Sales' tables no longer fit by construction:\n\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
      `Take the room from a column with slack or merge two columns. Never shrink the type, never add ` +
      `min-width or overflow-x-auto, never truncate (AGENTS.md §4).`,
  );
}
