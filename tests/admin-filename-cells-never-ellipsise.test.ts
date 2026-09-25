import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Two admin tables ellipsised an uploaded file's name and offered no way to read the rest of it.
 * Found 2026-09-05 by the admin half of the clip sweep, run after the portal fixes shipped.
 *
 * This is the owner's ellipsis ban (AGENTS.md §4, "never truncate text with an ellipsis"), and both
 * sites broke it on the one string a batch row exists to identify. Neither carried a `title`, so the
 * cut text was not recoverable by hover either — it was simply gone.
 *
 *   1. payroll/dashboard/payroll-history.tsx — the File column. `truncate` sat on the <td> itself.
 *      Measured on /payroll at 768/1024/1280: 121-133px of the name cut, e.g.
 *      "automated-payroll:2f1660e5-a6d8-4ccb-9492-0d589f25…". Every automated batch shares that
 *      prefix, so what the ellipsis ate was the ONLY part telling two rows apart.
 *   2. sales/sales-import-workspace.tsx — the File column of the distributor batch table. The cap
 *      was on the <td> and `truncate` on the inner <p>. Worse than the payroll one: 154px cut in a
 *      reproduction of its 10-column table, because more columns compete for the same 980px.
 *
 * Both fixed by wrapping instead — the answer the fits-the-screen golden rule names ("fit by MERGING
 * columns, never by shrinking type; WRAPPING is the permitted answer"). `break-words` is the load-
 * bearing token: a payroll filename is one unbroken token with no spaces to wrap at, so plain
 * `whitespace-normal` still overflows it. The sales cell also gained `min-w-[220px]`, because once
 * `nowrap` is gone the column's min-content width collapses and auto table layout squeezed it to
 * 149px / 4 lines; with the floor it settles at 193px / 3.
 *
 * Verified against a static harness of both real table shapes at 768px, each with a CONTROL row
 * still carrying `truncate`. The controls cut 87px and 154px with `text-overflow: ellipsis`; the
 * fixed rows reported the text fully visible with no ellipsis. An earlier run of that same harness
 * at 1280px was VOID — the control did not fire, because `max-w-[260px]` on a <td> is not a real
 * constraint and the column simply took 500px. The squeeze, not the max-width, is what cuts.
 *
 * Pinned by SHAPE. Comments are stripped first, so the prose above cannot satisfy the assertions —
 * a pinning test that matched its own explanation would pin the anti-pattern (AGENTS.md §2.1).
 */

const PAYROLL = "src/components/payroll/dashboard/payroll-history.tsx";
const SALES_IMPORT = "src/components/sales/sales-import-workspace.tsx";

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

export function runAdminFilenameCellsNeverEllipsiseTests() {
  // ── 1. the payroll batch File column ───────────────────────────────────────────────────────
  const payroll = stripComments(readFileSync(PAYROLL, "utf8"));
  const payrollCell = payroll.match(/<td className="([^"]*)">\s*\{batch\.fileName\}\s*<\/td>/);
  assert.ok(
    payrollCell,
    `${PAYROLL}: the File column no longer renders {batch.fileName} in a <td> with a literal ` +
      `className. Re-point this test at whatever prints the filename — do not drop it.`,
  );
  assert.ok(
    !tokens(payrollCell[1]).includes("truncate"),
    `${PAYROLL}: the File cell is "${payrollCell[1]}" — "truncate" is back. It cut 121-133px of ` +
      `every automated batch name, and the cell has no title, so the rest is unreadable. Automated ` +
      `names share a long prefix; the ellipsis eats the only part that identifies the row.`,
  );
  assert.ok(
    tokens(payrollCell[1]).includes("break-words"),
    `${PAYROLL}: the File cell is "${payrollCell[1]}" — "break-words" is gone. A payroll filename ` +
      `is one unbroken token, so without it the name overflows the column instead of wrapping.`,
  );

  // ── 2. the distributor import batch File column ────────────────────────────────────────────
  const salesImport = stripComments(readFileSync(SALES_IMPORT, "utf8"));
  const salesCell = salesImport.match(/<p className="([^"]*)">\{batch\.fileName\}<\/p>/);
  assert.ok(
    salesCell,
    `${SALES_IMPORT}: the batch table no longer renders {batch.fileName} in a <p> with a literal ` +
      `className. Re-point this test at whatever prints the filename — do not drop it.`,
  );
  assert.ok(
    !tokens(salesCell[1]).includes("truncate"),
    `${SALES_IMPORT}: the File cell is "${salesCell[1]}" — "truncate" is back. In its 10-column ` +
      `table this cut 154px of the uploaded sheet's name, with no title to recover it.`,
  );
  assert.ok(
    tokens(salesCell[1]).includes("break-words"),
    `${SALES_IMPORT}: the File cell is "${salesCell[1]}" — "break-words" is gone. A distributor ` +
      `sheet name has no spaces to wrap at, so without it the name overflows the column.`,
  );

  // The File column still may not be squeezed — but on 2026-09-24 the MECHANISM changed, so this
  // assertion follows it rather than pinning a crutch that has become the defect.
  //
  // The floor was a `min-w-[220px]` on the <td>, and it existed because the table used AUTO layout
  // over a `min-w-[980px]`: with nowrap gone, auto layout collapsed the column's min-content width
  // to 149px and stacked the name four lines deep. The sales fits-the-screen pass retired that
  // whole construct — the table is `table-fixed` now with a percentage <colgroup>, so the File
  // column takes 20% of the container at lg and 40% below it whatever the data says.
  //
  // Leaving the old floor in place would have turned it into the very thing it was hired to
  // prevent: a `min-w-[220px]` cell inside a fixed table forces the TABLE wider than its container,
  // which is the sideways scroll the golden rule forbids. What is pinned here is the invariant, not
  // the token — the column has a structural width the data cannot collapse.
  // Anchored BACKWARDS from the filename cell, not by the first <table> in the file. The workspace
  // holds two fixed tables, and a forward match silently pinned the Rows To Fix one instead — it
  // passed with `table-fixed` deliberately removed from the batch table, which is the whole thing
  // this is meant to catch. Verified by breaking it: the assertions below now fire.
  const fileCellIndex = salesImport.indexOf("{batch.fileName}");
  assert.ok(fileCellIndex > 0, `${SALES_IMPORT}: {batch.fileName} is no longer rendered at all.`);
  const beforeFileCell = salesImport.slice(0, fileCellIndex);
  const batchTable = beforeFileCell
    .slice(beforeFileCell.lastIndexOf("<table "))
    .match(/<table className="([^"]*)">\s*<colgroup>([\s\S]*?)<\/colgroup>/);
  assert.ok(
    batchTable,
    `${SALES_IMPORT}: the uploaded-sheets table no longer opens with a <colgroup>. The File ` +
      `column's width is then whatever auto layout gives it, which squeezed it to 149px before. ` +
      `Re-point this test at whatever makes that width structural — do not drop it.`,
  );
  assert.ok(
    tokens(batchTable[1]).includes("table-fixed"),
    `${SALES_IMPORT}: the uploaded-sheets table is "${batchTable[1]}" — "table-fixed" is gone, so ` +
      `the <colgroup> under it is advisory and the File column can be squeezed by its neighbours.`,
  );
  // The FIRST <col> in the group is the File column's. Matched as a whole tag, because a
  // `className`-anywhere search skips a widthless `<col />` and reads the next column's width as
  // though it were this one's — which passed a deliberately broken file. Verified by breaking it.
  const firstCol = batchTable[2].match(/<col\b[^>]*>/);
  assert.ok(
    firstCol && /w-\[\d+%\]/.test(firstCol[0]),
    `${SALES_IMPORT}: the File column's <col> is "${firstCol?.[0] ?? "(not found)"}" — it no ` +
      `longer sets a percentage share of the table, so the filename has no guaranteed room.`,
  );
}
