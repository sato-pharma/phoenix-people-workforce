// Reading the result of the pgTAP access tests (supabase/tests/database/access.test.sql).
// Kept apart from scripts/db-access-tests.mjs so tests/db-access-tests.test.ts can test the verdict
// without a database. Account: docs/security/schema-restore-check.md, "The access tests".

export const ACCESS_TEST_FILE = "supabase/tests/database/access.test.sql";

/**
 * Reads pgTAP's output (psql -At, one result per line) into a verdict. It passes only when the plan line
 * is there, says at least one test, every planned test printed `ok`, and none printed `not ok`.
 * A run that stopped half way prints no plan total from finish() and fewer `ok` lines than the plan, so it
 * can never read as a pass, and nor can a run that printed nothing at all.
 */
export function readTap(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim());
  let planned = null;
  const passed = [];
  const failed = [];
  for (const line of lines) {
    const plan = /^1\.\.(\d+)$/.exec(line);
    if (plan && planned === null) planned = Number(plan[1]);
    else if (/^not ok \d+/.test(line)) failed.push(line);
    else if (/^ok \d+/.test(line)) passed.push(line);
  }
  const ran = passed.length + failed.length;
  const reasons = [];
  if (planned === null) reasons.push("no plan line was printed, so the file never started its tests");
  else if (planned === 0) reasons.push("the plan says zero tests");
  if (failed.length > 0) reasons.push(`${failed.length} test(s) failed`);
  if (planned !== null && ran !== planned) reasons.push(`${ran} of ${planned} planned test(s) ran`);
  return { planned, passed: passed.length, failed, ran, ok: reasons.length === 0, reasons };
}
