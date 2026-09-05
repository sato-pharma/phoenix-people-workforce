import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/** Drop block comments and whole-line `//` comments. Kept deliberately simple: see the note in
 * tests/portal-chrome-never-clips-text.test.ts about a brace-aware variant eating a whole component. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

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

  // The min-width floor keeps that column readable once nowrap is gone; without it auto table
  // layout collapses it to 149px and the name stacks four lines deep.
  const salesFileTd = salesImport.match(/<td className="([^"]*)">\s*<p className="[^"]*">\{batch\.fileName\}/);
  assert.ok(
    salesFileTd && /min-w-\[\d+px\]/.test(salesFileTd[1]),
    `${SALES_IMPORT}: the File <td> is "${salesFileTd?.[1] ?? "(not found)"}" — its min-width floor ` +
      `is gone. Without it the wrapped filename is squeezed to ~149px and four lines deep.`,
  );
}
