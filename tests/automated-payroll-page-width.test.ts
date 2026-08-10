import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Automated Payroll surfaces are full-width admin pages. The Finance panel's outer shell was
 * copied from the wizard's and kept every class EXCEPT the width — it shipped with `max-w-3xl`
 * (768px) while the wizard uses 1600px, so /admin/automated-payroll/finance rendered as a narrow
 * centre column with roughly a thousand pixels of dead gutter on a normal desktop.
 *
 * Nothing caught it because `max-w-3xl` is a perfectly valid class and the page looks deliberate in
 * isolation — you only see the bug next to its sibling.
 *
 * Owner rule this protects: the admin shell shows full-width dashboards on desktop.
 */

const PANELS = [
  "src/components/automated-payroll/finance-download-panel.tsx",
  "src/components/automated-payroll/automated-payroll-wizard.tsx",
] as const;

const PAGE_WIDTH = "max-w-[1600px]";

export function runAutomatedPayrollPageWidthTests() {
  for (const path of PANELS) {
    const source = readFileSync(path, "utf8");

    // The outer page shell is the first `mx-auto flex max-w-… flex-col` in the file.
    const shell = source.match(/mx-auto flex (max-w-\[?[\w.\-]+\]?) flex-col/);
    assert.ok(shell, `${path}: could not find the outer page shell — has the layout been restructured?`);
    assert.equal(
      shell[1],
      PAGE_WIDTH,
      `${path} renders its page at ${shell[1]} instead of ${PAGE_WIDTH}. Automated Payroll is a ` +
        `full-width admin surface; a narrower cap leaves the page as a column floating in dead space.`,
    );
  }
}
