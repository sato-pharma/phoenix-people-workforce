import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `phx_import_approved_expenses_to_payroll` must refuse any month the Automated Payroll wizard
 * already paid.
 *
 * WHY THIS GUARD EXISTS. The import pays an approved outstation trip and then stamps it
 * (`imported_payroll_batch_id` / `imported_to_payroll_at`). That stamp is the only thing that stops
 * a trip being paid twice, and the wizard -- the live payroll path since July 2026 -- never writes
 * one. It READS the stamp (recommend.ts skips a stamped row) but does not set it, so no row in
 * production carries an `imported_payroll_batch_id` at all: of 374 rows, 340 satisfy the import's own
 * payroll-grade predicate, worth EGP 138,453 across payout periods 2026-02 .. 2026-10, measured
 * 2026-09-10. That set includes the trips behind the expense figures the wizard actually paid in the
 * July and August batches.
 *
 * The batch-status gate is not protection. It admits `part1_paid`, `adjustments_open`,
 * `part2_ready`, `under_review` and `rejected`; the wizard finalises to `approved`, which is outside
 * that set purely by accident. The old Payroll Management workflow can still move an automated batch
 * to `under_review` or `rejected`, and at that moment one click pays those trips a second time.
 *
 * WHY IT IS A GUARD AND NOT THE STAMP. Having the wizard stamp the trips it paid is the real repair,
 * and it cannot be written from the data as it stands: the wizard's expense figures are typed, not
 * derived. All fifteen non-zero values in the August run were written in one save, every
 * `expenses_note` is empty, and the figures do not reconcile to the trips -- Saad Mohamed Saad
 * Salama was paid EGP 4,203 in August holding zero trips in August's payout period. Nothing records
 * which trips that settled. This guard closes the exposure without needing to know.
 *
 * TWO GUARDS, ONE DEFINITION. Guard 1 refuses outright when the TARGET batch is a wizard batch.
 * Guard 2 excludes wizard-paid periods from `importable`, which is the half that matters most: the
 * import sweeps every period at or before the target, so a legacy batch opened for a later month
 * would otherwise drag July and August in behind it. Both call one helper so the two readings cannot
 * drift apart.
 *
 * Reads the newest migration that defines each function rather than pinning a byte range, so a later
 * migration that legitimately rewrites the body still gets checked and whitespace never false-fails.
 */
export function runOutstationImportRefusesWizardMonthsTests() {
  const migrationsDir = "supabase/migrations";
  const IMPORT_FN = "phx_import_approved_expenses_to_payroll";
  const HELPER_FN = "phx_period_paid_by_automated_payroll";

  /** The body of the newest migration that (re)defines `fn`, with SQL line comments stripped. */
  function newestBody(fn: string): { body: string; file: string } {
    const defining = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}`, "i").test(
          readFileSync(join(migrationsDir, f), "utf8"),
        ),
      );
    assert.ok(defining.length > 0, `no migration defines ${fn} — has it been renamed or removed?`);

    const file = defining[defining.length - 1];
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}`, "i"));
    const end = sql.indexOf("$$;", start);
    assert.ok(end > start, `could not find the closing $$; of ${fn} in ${file}`);

    // Strip line comments: the prose above a statement must never satisfy a check that is supposed
    // to be reading executable SQL. This is the trap the additive-import guard already documents.
    const body = sql
      .slice(start, end)
      .split("\n")
      .map((line) => {
        const at = line.indexOf("--");
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");

    return { body, file };
  }

  // ---- The helper must exist and read BOTH signals. --------------------------------------------
  // Each covers the other's weakness: renaming a batch defeats the file-name marker, deleting a run
  // row defeats the link. A helper reading only one is a guard with a single point of failure.
  const helper = newestBody(HELPER_FN);

  assert.match(
    helper.body,
    /automated-payroll:%/,
    `${helper.file}: ${HELPER_FN} must recognise the \`automated-payroll:<runId>\` batch file_name that publishToPayslips writes`,
  );

  assert.match(
    helper.body,
    /published_batch_id/,
    `${helper.file}: ${HELPER_FN} must also recognise a run linked by \`automated_payroll_runs.published_batch_id\` — ` +
      "the file_name marker alone is defeated by renaming the batch",
  );

  // ---- HEADLINE 1: the import refuses a wizard-produced target batch. --------------------------
  const imp = newestBody(IMPORT_FN);

  const refusal =
    imp.body.search(new RegExp(`if\\s+public\\.${HELPER_FN}\\s*\\(`, "i"));
  assert.ok(
    refusal >= 0,
    `${imp.file}: ${IMPORT_FN} must call ${HELPER_FN} on the target batch and refuse — ` +
      "without it, a wizard batch that the old workflow moves to under_review or rejected can be " +
      "imported into, paying every unstamped trip a second time",
  );

  // A refusal, not a quiet empty result. Importing nothing reads as "nothing was outstanding",
  // which is the opposite of what is true.
  const afterRefusal = imp.body.slice(refusal, refusal + 600);
  assert.match(
    afterRefusal,
    /raise\s+exception/i,
    `${imp.file}: the wizard-batch guard must \`raise exception\`, not return an empty result — ` +
      "a silent zero reads as 'there was nothing to import'",
  );

  // ---- HEADLINE 2: wizard-paid periods are excluded from `importable`. -------------------------
  // Scoped to the CTE deliberately. The same call appearing in the refusal above does NOT protect
  // carry-forward: only the copy inside `importable` decides which trips get SUMMED into salaries.
  // This is the exact lesson the additive-import guard learned about its own idempotence filter.
  const importableStart = imp.body.search(/importable\s+as\s*\(/i);
  const approvedTotalsStart = imp.body.search(/approved_totals\s+as\s*\(/i);
  assert.ok(
    importableStart >= 0 && approvedTotalsStart > importableStart,
    `${imp.file}: could not locate the importable CTE ahead of approved_totals — the shape has drifted`,
  );
  const importable = imp.body.slice(importableStart, approvedTotalsStart);

  assert.match(
    importable,
    new RegExp(`not\\s+public\\.${HELPER_FN}\\s*\\(\\s*oe\\.payout_year\\s*,\\s*oe\\.payout_month\\s*\\)`, "i"),
    `${imp.file}: the importable CTE must exclude trips whose own payout period was paid by ` +
      `Automated Payroll (\`and not public.${HELPER_FN}(oe.payout_year, oe.payout_month)\`). ` +
      "The refusal on the target batch does NOT cover this: the import carries forward every period " +
      "at or before the target, so a legacy batch opened for a later month drags the wizard-paid " +
      "months in behind it — the whole EGP 140,302 exposure",
  );

  // ---- Everything the 2026-08-24 migrations established must survive this rewrite. -------------
  // A `create or replace` that drops one of these silently reintroduces a defect that has already
  // cost real money once.
  assert.match(
    imp.body,
    /expenses\s*=\s*coalesce\(\s*sr\.expenses\s*,\s*0\s*\)\s*\+/i,
    `${imp.file}: the expenses write must stay additive — replacing it zeroes the sheet-sourced ` +
      "expenses of every employee with no approved outstation claim",
  );

  assert.ok(
    !/left\s+join/i.test(imp.body),
    `${imp.file}: no LEFT JOIN — a left join over the batch is what let employees with no approved ` +
      "claim be written to at all",
  );

  assert.ok(
    /imported_to_payroll_at\s+is\s+null/i.test(importable) &&
      /imported_payroll_batch_id\s+is\s+null/i.test(importable),
    `${imp.file}: the importable CTE must still exclude already-stamped rows, or re-running pays ` +
      "the same expense twice",
  );

  assert.match(
    importable,
    /<=\s*v_target_period/i,
    `${imp.file}: the importable CTE must still accept periods at or before the target, otherwise ` +
      "approved expenses from closed months can never be paid at all",
  );
}
