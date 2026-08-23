import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `phx_import_approved_expenses_to_payroll` must ADD outstation expenses to a salary record, never
 * overwrite the column, and never touch a record that has no approved claim.
 *
 * WHY THIS IS ITS OWN GUARD, AND WHY IT IS WORTH THE FILE. `salary_records.expenses` has two
 * independent writers. The monthly payroll upload fills it from the sheet column
 * "Expenses" / "Expenses Prev Month" (src/lib/payroll/salary-import.ts), and this import adds the
 * outstation claims HR approved. Nothing in either code path says so, and the column name gives no
 * hint that it is shared.
 *
 * Before the 2026-08-24 migration this function drove its salary update off a LEFT JOIN across
 * *every* record in the batch and then did `set expenses = coalesce(at.approved_expense, 0)`. Every
 * employee without an approved claim therefore had their sheet-sourced expenses set to zero and
 * their `month_salary` cut by the same amount.
 *
 * Rehearsed on staging against a three-employee fixture: the old body zeroed EGP 5,000 from an
 * employee who had no outstation claim at all, and replaced another's EGP 1,000 sheet figure with
 * their EGP 300 claim — EGP 5,700 destroyed. The decisive detail, and the reason a test is the only
 * thing that can catch this: the function returned the *identical* JSON summary in both cases
 * ("imported 2 employees, EGP 1,000"). The damage is invisible to the caller, invisible to the API
 * response, and invisible in the logs. It shows up only as wrong pay.
 *
 * Production has never run this import (0 of 361 outstation rows carry a stamp), so no salary has
 * actually been harmed. That is luck — the batch-status gate blocks it — not design, and the gate is
 * about *when* the import may run, not *what* it does. This test guards the "what".
 *
 * CARRY FORWARD (owner decision, 2026-08-24) is guarded here too. An approved expense whose own
 * month has closed can never be paid from that month again — a closed batch is not reopened — so it
 * has to ride along with the next batch that is open. A filter pinned to the exact payout period
 * strands that money permanently, and silently: production had ~EGP 34,299 of approved, unimported
 * expenses sitting across 2026-02..2026-07 with no route to anyone's salary. Rehearsed on staging
 * across three periods plus a future one — the future claim was correctly left unpaid, and a second
 * run added nothing.
 *
 * The split in the return value is guarded for the same reason the amounts are: money carried in
 * from April must not appear in a single total that reads as July's spend, and money that still
 * could not be paid (a leaver in no later batch) must be named rather than silently skipped.
 *
 * Deliberately reads the newest migration that defines the function rather than pinning a byte
 * range: a later migration that legitimately rewrites the body still gets checked, and a whitespace
 * change never produces a false failure.
 */
export function runOutstationImportIsAdditiveTests() {
  const migrationsDir = "supabase/migrations";
  const FN = "phx_import_approved_expenses_to_payroll";

  // The newest migration that actually (re)defines the function is the one in force.
  const defining = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}`, "i").test(readFileSync(join(migrationsDir, f), "utf8")));

  assert.ok(defining.length > 0, `no migration defines ${FN} — has it been renamed?`);

  const newest = defining[defining.length - 1];
  const sql = readFileSync(join(migrationsDir, newest), "utf8");

  // Body = from the CREATE to the dollar-quoted terminator that closes it.
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}`, "i"));
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `could not find the closing $$; of ${FN} in ${newest}`);
  const body = sql.slice(start, end);

  // Strip SQL line comments before asserting on structure. Without this the prose above a statement
  // could satisfy — or trip — a check that is supposed to be reading executable SQL.
  const code = body
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

  // ---- HEADLINE: the expense write must be additive, not an overwrite. --------------------------
  assert.ok(
    /expenses\s*=\s*coalesce\(\s*sr\.expenses\s*,\s*0\s*\)\s*\+/i.test(code),
    `${newest}: the expenses write is not additive — it must read \`expenses = coalesce(sr.expenses, 0) + <amount>\`, ` +
      "otherwise it replaces the figure the payroll sheet put there and cuts that employee's salary by the difference",
  );

  // The exact destructive form that shipped before, named so a revert is recognised on sight.
  assert.ok(
    !/expenses\s*=\s*coalesce\(\s*at\.approved_expense\s*,\s*0\s*\)/i.test(code),
    `${newest}: the destructive overwrite \`expenses = coalesce(at.approved_expense, 0)\` is back — ` +
      "this zeroes the sheet-sourced expenses of every employee with no approved outstation claim",
  );

  // ---- SCOPE: no LEFT JOIN. -------------------------------------------------------------------
  // A LEFT JOIN is precisely what let records with no matching claim reach the UPDATE. An inner
  // join cannot produce that row at all, so this is the structural form of "hr_id-scoped".
  assert.ok(
    !/left\s+join/i.test(code),
    `${newest}: this function must contain no LEFT JOIN — a left join over the batch is what allowed ` +
      "employees with no approved claim to be written to at all",
  );

  // ---- IDEMPOTENCE: only never-imported rows may be summed. -------------------------------------
  // This is what makes an additive write safe to re-run. Without it a second call pays every
  // approved expense a second time.
  //
  // Scoped to the `importable` CTE ON PURPOSE, and this is not pedantry. The same predicate can also
  // appear in `marked_expenses`, where it stops an earlier import's stamp being overwritten —
  // useful, but it does nothing to prevent double payment. Only the copy in `importable` decides
  // what gets SUMMED into salaries. An earlier version of this test searched the whole function body
  // and passed happily with that filter deleted, because it found the phrase elsewhere.
  const importableStart = code.search(/importable\s+as\s*\(/i);
  const approvedTotalsStart = code.search(/approved_totals\s+as\s*\(/i);
  assert.ok(
    importableStart >= 0 && approvedTotalsStart > importableStart,
    `${newest}: could not locate the importable CTE ahead of approved_totals — the shape has drifted`,
  );
  const importable = code.slice(importableStart, approvedTotalsStart);

  assert.ok(
    /imported_to_payroll_at\s+is\s+null/i.test(importable) && /imported_payroll_batch_id\s+is\s+null/i.test(importable),
    `${newest}: the importable CTE must exclude rows already stamped as imported ` +
      "(`imported_to_payroll_at is null` and `imported_payroll_batch_id is null`), or re-running pays the same expense twice. " +
      "The identical filter in marked_expenses does NOT satisfy this — it guards lineage, not double payment",
  );

  // ---- CARRY FORWARD: earlier unpaid periods must be reachable. ---------------------------------
  // Owner decision 2026-08-24. An approved expense whose own month has closed can never be paid
  // from that month again — the batch cannot be reopened — so it has to ride along with the next
  // open batch. A filter pinned to the exact period strands that money permanently and silently.
  assert.ok(
    /<=\s*v_target_period/i.test(importable),
    `${newest}: the importable CTE must accept periods at or before the target ` +
      "(`<= v_target_period`), otherwise approved expenses from closed months can never be paid at all",
  );

  assert.ok(
    !/payout_month\s*=\s*p_month/i.test(importable),
    `${newest}: the importable CTE pins to the exact payout month again — that is the bug carry-forward ` +
      "exists to fix, because a closed month's batch can never be reopened to pay it",
  );

  // The split must survive into the return value. Folding carried-forward money into one unlabelled
  // total is how an older month's expense silently shows up as if it were this month's.
  for (const key of ["current_period_total", "carried_forward_total", "stranded_total"]) {
    assert.ok(
      new RegExp(`'${key}'`).test(code),
      `${newest}: the return value must report '${key}' — without the split nobody can tell ` +
        "this month's expenses from money carried in from an earlier one, or see what still could not be paid",
    );
  }

  // ---- CALLER CONTRACT: the gate message keeps the substring the app matches on. ----------------
  // src/lib/outstation/expenses.ts turns this into a PayrollConflictError by substring test. If the
  // wording loses that phrase the same refusal surfaces as an unhandled 500 instead of a clear
  // message, which is a worse failure than the one it is reporting.
  const caller = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  assert.ok(
    caller.includes("cannot import expenses"),
    "src/lib/outstation/expenses.ts no longer matches on \"cannot import expenses\" — update this test with it",
  );
  assert.ok(
    /cannot import expenses/i.test(body),
    `${newest}: the batch-status exception must keep the phrase "cannot import expenses" — ` +
      "src/lib/outstation/expenses.ts matches on it to raise PayrollConflictError instead of a 500",
  );
}
