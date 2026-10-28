import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The candidates table on /admin/deductions, pinned against the owner's FITS-THE-SCREEN golden rule
 * (AGENTS.md §4): never a horizontal scroll, fit by MERGING columns and never by shrinking the type,
 * and wrapping wins over an ellipsis.
 *
 * Measured on production on 2026-10-19 in a 1024px window (August 2026, Fingerprint tab): the table
 * was 1,455px inside a card 893px wide, so Amount, Reason, Status and Action fell off the right edge
 * and the page grew a scrollbar. It was ten columns of `whitespace-nowrap` cells, and the Dates cell
 * listed up to a month of day numbers on one line.
 *
 * `CategoryTab` is the ONE component behind every candidate tab — CRM, Fingerprint, Half Day (CRM),
 * Unpaid Vacation, Insufficient Balance Vacation, Loan and Other — so this one table is the whole
 * fix. It is now `table-fixed` with a percentage colgroup, and the width came from merging: the hire
 * date sits under the employee, the day count over its dates, and Action rides in the Status cell.
 *
 * WHAT THIS TEST DOES. It re-does the width arithmetic from the SOURCE at the narrowest width the
 * table is ever drawn at, and it bars the constructs that bring the scroll back. It cannot prove the
 * page fits — only a browser can, by measuring `scrollWidth > clientWidth` over `main` — so it
 * proves the arithmetic that has to hold first and catches the edit that would break it.
 *
 * THE FLOOR. A 272px admin sidebar from 1024px up and 16px of page padding a side leave 720px for a
 * full-width card (the figure tests/activity-control-tables-fit-the-screen.test.ts uses), and the
 * table is hidden below `md`. The per-character costs are derived the same way that test derives
 * them: 11px bold capitals with tracking at 9.6px a character, a 14px tabular figure at 7.7px,
 * both rounded up.
 *
 * Pinned on comment-stripped source, so this prose can never satisfy it.
 */

const WORKSPACE = "src/components/admin/deductions-workspace.tsx";

const FLOOR_PX = 720;
const CAPS_11PX = 9.6;
const FIGURE_14PX = 7.7;
/** A 10px black capital in the status pill, with the pill's own 2 x 8px of padding. */
const STATUS_PILL_WORD_PX = 8 * 8 + 16;
/** The longest word of the red "Same day on another row" pill that sits in the Reason cell: "ANOTHER", measured at 69px. */
const SAME_DAY_PILL_WORD_PX = 72;

type Need = { px: number; what: string };

function caps(word: string): number {
  return Math.round(word.length * CAPS_11PX * 10) / 10;
}

/** The widest thing in each column that cannot wrap, in column order WITH the checkbox column. */
const CAN_DECIDE_NEEDS: Need[] = [
  { px: 14, what: "the 14px row checkbox" },
  { px: caps("EMPLOYEE"), what: 'the "Employee" header' },
  { px: caps("DEDUCTED"), what: 'the longest word of "Days and dates deducted"' },
  { px: caps("HOLIDAY"), what: 'the "Holiday" word of the Holiday bridge header' },
  { px: Math.round(9 * FIGURE_14PX * 10) / 10, what: 'a nine-character amount such as "12,345.67"' },
  { px: Math.max(caps("REASON"), SAME_DAY_PILL_WORD_PX), what: 'the word "ANOTHER" in the same-day pill, or the "Reason" header' },
  { px: STATUS_PILL_WORD_PX, what: 'the word "APPROVED" in the status pill' },
];

function sliceOf(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${WORKSPACE}: "${start}" is gone. Re-point this test; do not drop it.`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `${WORKSPACE}: "${end}" is gone after "${start}". Re-point this test; do not drop it.`);
  return source.slice(from, to);
}

/** One top-level function, up to its closing brace in column 1. */
function functionBody(source: string, signature: string): string {
  const from = source.indexOf(signature);
  assert.notEqual(from, -1, `${WORKSPACE}: "${signature}" is gone. Re-point this test; do not drop it.`);
  const rest = source.slice(from);
  const close = /\r?\n\}\r?\n/.exec(rest);
  assert.ok(close, `${WORKSPACE}: could not find the end of "${signature}".`);
  return rest.slice(0, close.index + close[0].length);
}

function horizontalPaddingPx(className: string): number {
  const px = className.split(/\s+/).find((token) => /^px-\d+(?:\.\d+)?$/.test(token));
  return px ? Number(px.slice(3)) * 4 * 2 : 0;
}

export function runDeductionsCandidatesTableFitsTheScreenTests() {
  const source = stripComments(readFileSync(WORKSPACE, "utf8"));
  const tab = sliceOf(source, "function CategoryTab(", "function PublicationPanel(");
  const table = sliceOf(tab, "<table", "</table>");

  // 1. Nothing in the tab buys a sideways scroll or cuts text. The day editor has its own
  //    `min-w-[2.4rem]` calendar cells, which live in DeductionDaysEditor and not in this slice.
  for (const banned of [
    "overflow-x-auto",
    "overflow-x-scroll",
    "overflow-auto",
    "overflow-scroll",
    "truncate",
    "text-ellipsis",
    "line-clamp",
  ]) {
    assert.doesNotMatch(
      tab,
      new RegExp(`\\b${banned}\\b`),
      `${WORKSPACE}: "${banned}" is in the candidates tab. The golden rule names a sideways scroll as the bug and ` +
        `bars an ellipsis — buy the width by merging columns and let the text wrap.`,
    );
  }
  assert.doesNotMatch(
    tab,
    /\bmin-w-\[/,
    `${WORKSPACE}: a min-width floor is in the candidates tab. A floor under a table-fixed table is how the page ` +
      `starts scrolling sideways again.`,
  );

  // 2. A phone never gets the table, and the card list is there to take its place.
  assert.match(
    tab,
    /<div className="hidden md:block">\s*<table/,
    `${WORKSPACE}: the desktop table must sit in a "hidden md:block" wrapper — a phone never gets a table.`,
  );
  assert.match(tab, /<div className="[^"]*\bmd:hidden\b/, `${WORKSPACE}: the mobile card list (md:hidden) is gone.`);

  // 3. table-fixed, or the widest row decides the width again and the colgroup means nothing.
  const tableTag = /<table className="([^"]*)"/.exec(table);
  assert.ok(tableTag, `${WORKSPACE}: no <table className="…"> found in the candidates tab.`);
  assert.ok(
    tableTag[1].split(/\s+/).includes("table-fixed"),
    `${WORKSPACE}: the candidates table lost "table-fixed", so its widest cell decides its width again.`,
  );
  assert.ok(tableTag[1].split(/\s+/).includes("w-full"), `${WORKSPACE}: the candidates table lost "w-full".`);

  // 4. The colgroup: two column sets (with the checkbox and Action, and without), each totalling 100,
  //    each matching its header count.
  const colgroup = /<colgroup>([\s\S]*?)<\/colgroup>/.exec(table);
  assert.ok(colgroup, `${WORKSPACE}: the candidates table has no <colgroup>.`);
  const percents = [...colgroup[1].matchAll(/<col className="w-\[(\d+(?:\.\d+)?)%\]"\s*\/>/g)].map((match) => Number(match[1]));
  assert.equal(
    percents.length,
    13,
    `${WORKSPACE}: expected 13 <col> entries (7 when the viewer can decide, 6 when not), found ${percents.length}.`,
  );
  const canDecidePercents = percents.slice(0, 7);
  const readOnlyPercents = percents.slice(7);
  for (const [name, set] of [
    ["can decide", canDecidePercents],
    ["read only", readOnlyPercents],
  ] as const) {
    const total = Math.round(set.reduce((sum, value) => sum + value, 0) * 10) / 10;
    assert.equal(
      total,
      100,
      `${WORKSPACE}: the ${name} <colgroup> adds up to ${total}, not 100. A short total leaves a column unsized; an ` +
        `over-total is how a table-fixed table starts overflowing again.`,
    );
  }

  const head = /<thead>([\s\S]*?)<\/thead>/.exec(table);
  assert.ok(head, `${WORKSPACE}: the candidates table has no <thead>.`);
  const headerCells = [...head[1].matchAll(/<th className="([^"]*)">/g)].map((match) => match[1]);
  assert.equal(
    headerCells.length,
    7,
    `${WORKSPACE}: ${headerCells.length} header cells. The table is seven columns when the viewer can decide ` +
      `(checkbox, Employee, Days and dates, Holiday bridge, Amount, Reason, Status and action) and six without the ` +
      `checkbox — merge, do not add a column back.`,
  );
  assert.match(
    tab,
    /<TableRowDetail colSpan=\{canDecide \? 7 : 6\}/,
    `${WORKSPACE}: the day editor must be a TableRowDetail (tables-said-once-fit: no hand-written second row) spanning every column of the table (7 with the checkbox, 6 without).`,
  );

  // 5. HEADLINE — every column holds the widest thing in it that cannot wrap, at the 720px floor.
  const readOnlyNeeds = CAN_DECIDE_NEEDS.slice(1);
  for (const [name, percentSet, needs, cells] of [
    ["can decide", canDecidePercents, CAN_DECIDE_NEEDS, headerCells],
    ["read only", readOnlyPercents, readOnlyNeeds, headerCells.slice(1)],
  ] as const) {
    assert.equal(percentSet.length, cells.length, `${WORKSPACE}: the ${name} <col> set and header row disagree.`);
    percentSet.forEach((percent, index) => {
      const columnPx = (percent / 100) * FLOOR_PX;
      const available = Math.round((columnPx - horizontalPaddingPx(cells[index])) * 10) / 10;
      assert.ok(
        available >= needs[index].px,
        `${WORKSPACE}: column ${index + 1} (${name}) is ${percent}% of a ${FLOOR_PX}px table = ${columnPx.toFixed(1)}px, ` +
          `${horizontalPaddingPx(cells[index])}px of it padding, leaving ${available}px — but ${needs[index].what} needs ` +
          `${needs[index].px}px and cannot wrap. Merge a column to free the width; never shrink the type.`,
      );
    });
  }

  // 6. Every cell wraps. A `whitespace-nowrap` on a td or th is the exact construct that made the old
  //    table 1,455px wide; the only nowrap left in the table is the short Edit-days button.
  assert.doesNotMatch(
    table,
    /<t[dh] className="[^"]*\bwhitespace-nowrap\b/,
    `${WORKSPACE}: a table cell is whitespace-nowrap again. The dates, the holiday bridge, the reason and the status ` +
      `must wrap, or one long row pushes every column after it off the card.`,
  );
  for (const [name, signature] of [
    ["the dates list", "function DayList("],
    ["the holiday bridge cell", "function HolidayBridgeCell("],
    ["the status badge", "function StatusBadge("],
    ["the same-day badge", "function SameDayBadge("],
  ] as const) {
    assert.doesNotMatch(
      functionBody(source, signature),
      /\bwhitespace-nowrap\b/,
      `${WORKSPACE}: ${name} is whitespace-nowrap again. It sits in a fixed-width cell and in a 343px phone card, ` +
        `and neither has room for a month of dates or a long label on one line.`,
    );
  }

  // 7. The merged cells really carry what the removed columns carried.
  assert.match(table, /Hired \{hireDateLabel\(row\.hireDate\)\}/, `${WORKSPACE}: the hire date is no longer shown under the employee.`);
  assert.match(table, /<DayList row=\{row\} \/>/, `${WORKSPACE}: the dates are no longer shown in the table.`);
  assert.match(table, /<HolidayBridgeCell row=\{row\} \/>/, `${WORKSPACE}: the holiday bridge is no longer shown in the table.`);
  assert.match(table, /<PushControl /, `${WORKSPACE}: the push control left the Status and action cell.`);
  assert.match(table, /<CandidateDecideRow /, `${WORKSPACE}: the Decide control left the Status and action cell.`);

  // 8. The day editor's month calendar opens inside the phone card, so it has to fit a phone too. Its
  //    seven `1fr` tracks are narrower than the 2.4rem floor the cells used to carry (34px against 38px
  //    at 375px), which pushed the last column out of its own box and, at 320px, out of the card.
  const editor = functionBody(source, "function DeductionDaysEditor(");
  const calendar = /<div className="([^"]*)">\s*<div className="(grid grid-cols-7[^"]*)">/.exec(editor);
  assert.ok(calendar, `${WORKSPACE}: the day editor's calendar box and its seven-column grid are gone.`);
  const [, boxClasses, gridClasses] = calendar;
  const boxTokens = boxClasses.split(/\s+/);
  assert.ok(
    boxTokens.includes("block") && boxTokens.includes("w-full") && boxTokens.includes("sm:inline-block") && boxTokens.includes("sm:w-auto"),
    `${WORKSPACE}: the calendar box must take the full card width on a phone ("block w-full") and shrink to its content ` +
      `from "sm" up ("sm:inline-block sm:w-auto"). Got "${boxClasses}".`,
  );
  assert.ok(
    !boxTokens.includes("inline-block"),
    `${WORKSPACE}: the calendar box is a bare "inline-block" again, so on a phone it sizes to its cells and not to the card.`,
  );
  assert.doesNotMatch(
    editor,
    /(^|[\s"'`])min-w-\[/,
    `${WORKSPACE}: a cell in the day editor carries a bare min-width floor. Seven 1fr tracks are narrower than 2.4rem ` +
      `on a phone, so the floor belongs behind "sm:" only.`,
  );
  const sizedCells = editor.match(/min-w-0[^"]*sm:min-w-\[2\.4rem\]/g) ?? [];
  assert.equal(
    sizedCells.length,
    2,
    `${WORKSPACE}: both calendar cell kinds (the greyed day and the ticked day) must be "min-w-0 … sm:min-w-[2.4rem]"; found ${sizedCells.length}.`,
  );
  assert.match(
    editor,
    /"[^"]*\bflex-col\b[^"]*\bsm:flex-row\b[^"]*"/,
    `${WORKSPACE}: the ticked day must stack its tick box over the number below "sm" and sit side by side from "sm" up.`,
  );

  // The arithmetic, at the narrowest phone this is read on: 320px, 16px of page padding a side, the
  // phone card's px-4, the editor's own border and p-3, the calendar box's border and p-2, six gap-1
  // gutters. A stacked cell needs the wider of the tick box and two digits, plus its 2px border.
  const unitPx = (classes: string, prefix: string): number => {
    const lead = `${prefix}-`;
    const token = classes.split(" ").find((candidate) => candidate.startsWith(lead) && Number.isFinite(Number(candidate.slice(lead.length))) && candidate.length > lead.length);
    assert.ok(token, `${WORKSPACE}: no "${prefix}-N" class found in "${classes}".`);
    return Number(token.slice(lead.length)) * 4;
  };
  const editorRoot = /return \(\s*<div className="([^"]*border border-orange-200[^"]*)"/.exec(editor);
  assert.ok(editorRoot, `${WORKSPACE}: the day editor's root panel is gone.`);
  const PHONE_PX = 320;
  const pagePadding = 16 * 2;
  const cardPadding = 16 * 2;
  const editorSpace = 1 * 2 + unitPx(editorRoot[1], "p") * 2;
  const boxSpace = 1 * 2 + unitPx(boxClasses, "p") * 2;
  const gutters = unitPx(gridClasses, "gap") * 6;
  const trackPx = (PHONE_PX - pagePadding - cardPadding - editorSpace - boxSpace - gutters) / 7;
  const stackedCellNeeds = Math.max(12, Math.round(2 * FIGURE_14PX * (12 / 14) * 10) / 10) + 2;
  assert.ok(
    trackPx >= stackedCellNeeds,
    `${WORKSPACE}: at ${PHONE_PX}px a calendar column is ${trackPx.toFixed(1)}px but a stacked day cell needs ` +
      `${stackedCellNeeds}px. Take padding or gutter out of the editor, never shrink the type.`,
  );
}
