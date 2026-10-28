import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripComments, stripCssComments } from "./support/comment-strip.ts";

// A row's opened panel is part of its row (docs/tables-said-once-fit.md rule 2, owner 2026-10-28:
// "Fold in, joined panel"). Two guards:
//
//  1. CSS. RULE 2 in app/globals.css draws a 1px orange border on every cell with `!important`;
//     `tr[data-row-detail] > td` is its ONE exception (top edge `hidden`), once per shell. Nothing else
//     may weaken a cell border — tests/admin-shell-palette-scope.test.ts §7 pins the look itself.
//  2. A RATCHET on the hand-written second row — `<tr><td colSpan …>` written outside `TableRowDetail`.
//     It reads as a new row, with a hairline above it. The count may fall (a screen moves to
//     `TableRowDetail`) and may never rise. Empty-state rows ("No rows") are the same shape and are
//     counted too; they are retired by moving the message into the header or a caption.

/**
 * `<tr><td colSpan>` sites outside table-row-detail.tsx, comments stripped, over app/ and src/components/.
 * Counted on codex/tables-said-once-fit when this test was written. Lower it as the builders retire
 * sites; never raise it.
 */
const BASELINE = 86;

const ROOTS = ["app", "src/components"];
const TR_THEN_COLSPAN_TD = /<tr\b[^>]*>\s*<td\b[^>]*\bcolSpan\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function runTableRowDetailJoinedTests() {
  // ── 1. the CSS exception is exactly its two selectors ──────────────────────────────────────────
  const css = stripCssComments(readFileSync("app/globals.css", "utf8"));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    body: match[2].replace(/\s+/g, " ").trim(),
    selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
  }));
  const joined = rules.flatMap((rule) => rule.selectors.filter((selector) => /\[data-row-detail\]/.test(selector)).map((selector) => ({ body: rule.body, selector })));
  const exceptions = joined.filter((rule) => /> td$/.test(rule.selector));
  assert.deepEqual(
    exceptions.map((rule) => rule.selector).sort(),
    [".admin-shell tr[data-row-detail] > td", ".employee-portal-shell tr[data-row-detail] > td"],
    "the joined-panel border exception is exactly these two selectors — one per shell",
  );
  for (const rule of exceptions) {
    assert.equal(rule.body.replace(/;$/, ""), "border-top-style: hidden !important", `${rule.selector}: the exception hides the top edge and changes nothing else`);
  }
  // The other `[data-row-detail]` rules only tint (hover); none may touch a border.
  for (const rule of joined.filter((entry) => !/> td$/.test(entry.selector))) {
    assert.ok(!/border|outline/.test(rule.body), `${rule.selector} must only tint the row and its panel, never change a border`);
  }
  // Detector control: a rule aimed at a cell that hides a border and is not the exception must be seen.
  const sample = stripCssComments(".admin-shell td.x { border-top: none; } .admin-shell tr[data-row-detail] > td { border-top-style: hidden !important; }");
  assert.equal([...sample.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\[data-row-detail\]/.test(m[1])).length, 1, "the selector scan must tell the exception from another cell rule");

  // ── 2. the ratchet on a second row written by hand ────────────────────────────────────────────
  const countIn = (snippet: string) => [...stripComments(snippet).matchAll(TR_THEN_COLSPAN_TD)].length;
  assert.equal(countIn("<tr><td colSpan={6}>x</td></tr>"), 1, "a hand-written panel row must count");
  assert.equal(countIn('<tr key={id}>\n  <td className="p-3" colSpan={cols}>x</td>\n</tr>'), 1, "a multi-line hand-written panel row must count");
  assert.equal(countIn('<TableRowDetail colSpan={6}><p>x</p></TableRowDetail>'), 0, "TableRowDetail is the way and must not count");
  assert.equal(countIn("// <tr><td colSpan={6}>x</td></tr>"), 0, "a comment is prose, not a site");
  assert.equal(countIn("<tr><td>a</td><td colSpan={2}>b</td></tr>"), 0, "a spanning cell that is not the row's first is a data cell, not a panel");

  const files = ROOTS.flatMap((root) => walk(root)).filter((file) => !file.replace(/\\/g, "/").endsWith("components/ui/table-row-detail.tsx"));
  assert.ok(files.length > 800, `only ${files.length} .tsx files were scanned — the walk is not reaching the tree`);
  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(TR_THEN_COLSPAN_TD)) {
      sites.push(`${file.replace(/\\/g, "/")}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  const count = sites.length;
  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new hand-written panel row(s): <tr><td colSpan> outside TableRowDetail — the count went ${BASELINE} -> ${count}.\n` +
      `A panel a row opens is part of that row: write it with TableRowDetail from "@/components/ui/table-row-detail" ` +
      `and put {...rowDetailToggleProps(id, open)} on the opening row. A line shown under EVERY row moves into the row's own cells.\n` +
      `Latest sites:\n  ${sites.slice(-12).join("\n  ")}`,
  );
  if (count < BASELINE) {
    console.warn(`Good news: hand-written panel rows dropped ${BASELINE} -> ${count}. Lower BASELINE in tests/table-row-detail-joined.test.ts to ${count}.`);
  }
}
