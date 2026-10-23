import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal Expense dashboard re-draws its text in the browser, so the server's HTML and the
 * phone's first render must be byte-identical. System Audit APP-CDB55BF6: 7 hydration mismatches,
 * 5 people (District Managers and a Training Manager), 8 Aug – 15 Oct 2026, several browsers, no
 * page translation involved. Two things on the page were the reader's, not the server's:
 *
 *   - Numbers. `toLocaleString()` with no locale writes the PHONE's number style. The server writes
 *     "1,234 km"; a phone set to Arabic writes "١٬٢٣٤ km", one set to German "1.234 km".
 *   - "last decision 5 days ago", worked out from the clock, which the server and the phone read at
 *     different moments.
 *
 * Each check is a function returning what is wrong, so the test also hands it a broken copy and
 * requires it to fire.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD = "src/components/employee-portal/personal-expense-workload-dashboard.tsx";

export function expenseDashboardNumberProblems(source: string): string[] {
  const bare = source.match(/\.toLocale(?:String|DateString|TimeString)\(\s*\)/g) ?? [];
  return bare.length
    ? [`${bare.length} number/date call(s) with no locale — they write the reader's own style, never the server's`]
    : [];
}

export function expenseDashboardClockProblems(source: string): string[] {
  return /const hydrated = useHydrated\(\);\s*const lastDecisionLabel = hydrated && lastDecisionAt \? relativeDaysFrom\(lastDecisionAt\) : "";/.test(source)
    ? []
    : ['"last decision … ago" must be drawn only after hydration (useHydrated), never in the server HTML'];
}

export function runExpenseDashboardHydrationTests() {
  const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, DASHBOARD), "utf8")).replace(/\r\n/g, "\n");

  // The defect itself, so the pin below is about something real: the same number, two readers.
  assert.equal((1234).toLocaleString("en-US"), "1,234", "en-US is what the server writes");
  assert.notEqual((1234).toLocaleString("ar-EG"), (1234).toLocaleString("en-US"), "a phone set to Arabic writes the same number differently");

  assert.deepEqual(expenseDashboardNumberProblems(source), [], "every number on the Expense dashboard is written en-US");
  assert.deepEqual(expenseDashboardClockProblems(source), [], "the clock-based label waits for hydration");

  const brokenNumbers = source.replace('.toLocaleString("en-US")', ".toLocaleString()");
  assert.notEqual(brokenNumbers, source, "the broken copy must actually differ");
  assert.ok(expenseDashboardNumberProblems(brokenNumbers).length > 0, "the number pin fires when one call goes back to the reader's style");

  const brokenClock = source.replace("hydrated && lastDecisionAt ?", "lastDecisionAt ?");
  assert.notEqual(brokenClock, source, "the broken copy must actually differ");
  assert.ok(expenseDashboardClockProblems(brokenClock).length > 0, "the clock pin fires when the label is drawn in the server HTML again");
}
