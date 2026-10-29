import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * THE EXPENSES REVIEW ROW, AND WHERE ITS HEIGHT ACTUALLY COMES FROM.
 *
 * 🔴 THE TRAP THIS FILE EXISTS TO CLOSE: the height is set by the **HR Decision** column, not by the
 * person column — and the person column is where everyone looks. Measured live on 2026-09-29 as
 * Super Admin against 489 real trips at 1440px:
 *
 *   • hiding the person cell's HR id line  →  78px to **78px**. Exactly nothing.
 *   • hiding the HR Decision reason input  →  78px to **58px**.
 *
 * That is why the 2026-09-26 change (#4474), which merged the workload chips and the Verify button
 * onto one line, bought only 14px and missed its own predicted ~62px by 16: it optimised the
 * SECOND-tallest cell. The person cell's HR id line is also a pure duplicate — every row carries a
 * dedicated "HR ID" column whose text is byte-identical (checked on 40 consecutive rows) — and
 * removing it still changes nothing, because it was never the constraint.
 *
 * WHAT MAY NOT BE DONE TO GET THE HEIGHT DOWN. The HR Decision cell is where a person approves
 * money. `HrDecisionControls` states the rule in full: the controls are moved, never reshaped — no
 * size reduction, no merged fields, no shortened labels, and the reason input keeps its full size
 * whether or not a reason is required. So the only lever left is the row's own whitespace, which is
 * what this test pins.
 *
 * Measured result of that lever: **78px to 70px** a row, with nothing hidden and no control resized.
 * The remaining 8px would have to come out of the approval controls, which is the owner's call.
 */
const REPORT = "src/components/outstation/expense-report.tsx";

export function runExpenseReviewRowHeightTests() {
  const source = stripComments(readFileSync(REPORT, "utf8"));

  // ── Every cell of a review row carries py-2 ───────────────────────────────
  // All five of them, because a table row is as tall as its tallest cell: leave one at py-3 and the
  // other four save nothing at all. That is the same class of mistake as optimising the wrong column.
  const reviewRowCells = [
    'className="min-w-0 break-words border-b border-slate-100 px-3 py-2 align-top group-hover:bg-phx-accent-soft"',
    '"min-w-0 break-words border-b border-slate-100 px-3 py-2 align-top text-xs group-hover:bg-phx-accent-soft"',
    '"min-w-0 border-b border-slate-100 px-3 py-2 align-top group-hover:bg-phx-accent-soft"',
  ];
  for (const cell of reviewRowCells) {
    assert.ok(
      source.includes(cell),
      `a review-row cell lost its py-2: ${cell.slice(0, 72)}… — a row is as tall as its TALLEST cell, ` +
        "so one cell back at py-3 undoes the whole change",
    );
  }
  assert.equal(
    (source.match(/px-3 py-2 align-top/g) ?? []).length,
    3,
    "exactly three review-row cells take px-3 py-2 — the Employee cell, the merged-fact cell and " +
      "the HR Decision cell",
  );

  // ── The review table fits the screen: merged cells, no sideways scroll ────
  assert.match(source, /<table className="w-full table-fixed text-left text-sm">/, "w-full table-fixed, no w-max");
  assert.match(source, /<colgroup>[\s\S]*columnPercentages\.map/, "a percentage colgroup");
  assert.doesNotMatch(
    source,
    /border-separate|overflow-x-auto|min-w-\[|whitespace-nowrap|sticky (left|right)-0/,
    "no border-separate, scroll wrapper, min-width, nowrap or sticky left/right column in the review table",
  );
  assert.ok(!/\bhrId\b[^\n]*font-mono/.test(source), "the HR id is not a cell of the review table");

  // ── The header keeps py-3, deliberately ────────────────────────────────────
  // A column heading is read once; a row is read 489 times. Shrinking the header buys one row's worth
  // of pixels and costs the heading its breathing room, so the two are deliberately different.
  assert.equal(
    (source.match(/bg-phx-paper px-3 py-3/g) ?? []).length,
    3,
    "the three review-table <th>s keep py-3 — only the body rows were tightened",
  );

  // ── The gap between the two HR Decision control rows ──────────────────────
  assert.match(
    source,
    /<fieldset className="m-0 flex min-w-0 flex-col gap-1\.5 border-0 p-0 disabled:opacity-60"/,
    "the HR Decision fieldset uses gap-1.5 (6px) between its two control rows — whitespace between " +
      "controls, which is allowed, as opposed to resizing a control, which is not",
  );

  // ── And the approval controls themselves are UNCHANGED ─────────────────────
  // This is the half that matters more than the pixels. The rule in HrDecisionControls is that the
  // controls are moved, never reshaped, because this is where money is approved. If a future attempt
  // to shorten the row reaches for the controls, these four assertions are what stop it.
  assert.match(
    source,
    /className="h-8 w-28 rounded-lg border border-border bg-white px-2 text-right font-mono text-xs/,
    "the approved-amount input keeps its h-8 w-28 — no size reduction on a money field",
  );
  assert.match(
    source,
    /className=\{cn\("h-8 text-xs", reasonMissing && "border-rose-400"\)\}/,
    "the reason input keeps h-8 AND its rose border when a reason is required",
  );
  assert.match(
    source,
    /placeholder=\{amountChanged \? "Reason for adjusted amount \(required\)" : "Reason \/ comment"\}/,
    "and both placeholders stay in full — no shortened labels",
  );
  // The reason field is rendered unconditionally. Hiding it when empty is the obvious way to reclaim
  // the last 20px, and it is refused here: a reviewer types the reason into it, so a field that
  // appears only after the amount changes is a field nobody can use to explain an unchanged amount.
  assert.doesNotMatch(
    source,
    /\{(amountChanged|reasonMissing|approval\.hrComment)[^}]{0,40}\?\s*<Input/,
    "the reason input must render unconditionally — making it appear only on an adjusted amount is " +
      "how you would reclaim the last 20px, and it takes a control away from the person approving",
  );
}
