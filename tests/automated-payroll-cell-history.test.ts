import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  DRAFT_COLUMN_LABELS,
  actorLabel,
  cairoTimeLabel,
  columnLabel,
  describeChargeSource,
  isTypedByHand,
  reasonLabel,
  valueLabel,
} from "../src/lib/automated-payroll/cell-history-labels.ts";
import { chargeSourceKind, draftColumnForField } from "../src/lib/automated-payroll/module-drift.ts";

/**
 * EVERY CHANGE TO A FIGURE ON THE AUTOMATED PAYROLL SHEET IS RECORDED — WHO, WHY, FROM WHAT TO WHAT.
 *
 * Before this the sheet kept ONE `edited_by` per row, overwritten by every save and every confirm,
 * and `automated_payroll_audit` recorded a COUNT per click ("edited: 102"), never a value. On
 * 2026-10-07 the owner asked who typed two CRM deductions on the September run (1,200.00 and
 * 533.33) and nothing could answer. The drift report called them "entered by hand" — and the audit's
 * own confirm snapshot showed they were the Deductions module's figures, frozen by a step confirm.
 *
 * The history is a database trigger (so no write path can skip it), fed by two columns every writer
 * now sets. What this pins is the half a trigger cannot enforce for itself: that every writer SAYS
 * who and why, rather than letting the trigger read the previous write's name off the row.
 */
export function runAutomatedPayrollCellHistoryTests() {
  const draftStore = readFileSync("src/lib/automated-payroll/draft-store.ts", "utf8");
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");

  // ---- Every writer says who and why ------------------------------------------------------------
  const toDb = draftStore.slice(
    draftStore.indexOf("function draftPatchToDb("),
    draftStore.indexOf("function isMissingColumnError("),
  );
  for (const line of [
    "db.edited_by = patch.editedBy ?? null;",
    'db.write_reason = patch.writeReason ?? "unspecified";',
    "db.write_step_key = patch.writeStepKey ?? null;",
  ]) {
    assert.ok(
      toDb.includes(line),
      `draftPatchToDb must ALWAYS write ${line.split(" =")[0]} — a write that leaves it out is recorded under the previous write's name`,
    );
  }
  assert.doesNotMatch(
    toDb,
    /if \(patch\.editedBy !== undefined\)/,
    "edited_by may not be conditional again: an omitted editor would inherit the last one",
  );

  const clearColumns = draftStore.slice(draftStore.indexOf("export async function clearDraftColumns("));
  assert.match(
    clearColumns.slice(0, clearColumns.indexOf("\n}\n")),
    /SYSTEM_WRITE\("deduction_resync"\)/,
    "a Deductions resync is recorded as the system, never as the row's last editor",
  );
  const clearExpenses = draftStore.slice(draftStore.indexOf("export async function clearDraftExpenses("));
  assert.match(
    clearExpenses.slice(0, clearExpenses.indexOf("\n}\n")),
    /SYSTEM_WRITE\("expense_resync"\)/,
    "an expense resync is recorded as the system, never as the row's last editor",
  );

  // Every call to upsertDraftRows in the run service names its reason. Five writers, five reasons.
  // Reopen Part 1 writes through phx_reopen_automated_payroll_part1 (payroll audit 2026-11-14), which
  // names its reason and its person in the SQL itself.
  const upsertCalls = runService.match(/upsertDraftRows\(/g)?.length ?? 0;
  const reasons = [
    'patch.writeReason = "step_saved"',
    'patch.writeReason = "step_confirmed"',
    'writeReason: "part1_confirmed"',
    'writeReason: "employee_excluded"',
    'writeReason: "employee_included"',
  ];
  const reopenSql = readFileSync(
    new URL("../supabase/migrations/20261114170804_automated_payroll_reopen_part1_atomically.sql", import.meta.url),
    "utf8",
  );
  assert.ok(
    reopenSql.includes("write_reason = 'part1_reopened'") && reopenSql.includes("edited_by = p_actor_hr_id"),
    "Reopen Part 1 records each cleared cell as part1_reopened, under the person who reopened it",
  );
  for (const reason of reasons) {
    assert.ok(runService.includes(reason), `run-service must set ${reason}`);
  }
  assert.equal(
    upsertCalls,
    reasons.length,
    "a NEW upsertDraftRows writer appeared — give it a writeReason and add it to this list",
  );
  assert.match(
    runService,
    /patch\.writeReason = "step_saved";\s*patch\.writeStepKey = stepKey;/,
    "a save names the step it was typed on",
  );

  // ---- The trigger ------------------------------------------------------------------------------
  const migrationName = readdirSync("supabase/migrations").find((name) =>
    name.endsWith("_automated_payroll_draft_cell_history.sql"),
  );
  assert.ok(migrationName, "the cell-history migration exists");
  const migration = readFileSync(`supabase/migrations/${migrationName}`, "utf8");
  assert.match(
    migration,
    /after insert or update on public\.automated_payroll_draft_rows/,
    "AFTER, never BEFORE: an upsert fires BEFORE INSERT even when it updates, which would record every cell as new",
  );
  assert.match(migration, /before update or delete on public\.automated_payroll_draft_cell_history/, "append-only: no edit or delete");
  assert.match(migration, /before truncate on public\.automated_payroll_draft_cell_history/, "append-only: TRUNCATE fires no row trigger");
  assert.match(migration, /revoke all on table public\.automated_payroll_draft_cell_history from anon, authenticated/);
  assert.match(migration, /enable row level security/);

  // ---- Every figure the sheet can write has a human label ----------------------------------------
  const written = new Set<string>();
  for (const match of toDb.matchAll(/num\("\w+", "(\w+)"\)/g)) written.add(match[1]!);
  for (const match of toDb.matchAll(/db\.(\w+) =/g)) written.add(match[1]!);
  const bookkeeping = new Set(["edited_by", "source", "write_reason", "write_step_key"]);
  for (const column of written) {
    if (bookkeeping.has(column)) {
      assert.ok(
        migration.includes(`'${column}'`),
        `${column} is bookkeeping, so the trigger must skip it rather than record it as a cell`,
      );
      continue;
    }
    assert.ok(DRAFT_COLUMN_LABELS[column], `${column} reaches the history with no label — add it to DRAFT_COLUMN_LABELS`);
  }
  assert.ok(written.has("crm") && written.has("first_part_frozen"), "the column scan actually read draftPatchToDb");
  assert.equal(columnLabel("crm"), "CRM deduction");
  assert.equal(columnLabel("not_a_column"), "not_a_column", "an unknown column shows its name, never a blank");

  // ---- Wording ----------------------------------------------------------------------------------
  assert.equal(
    reasonLabel({ writeReason: "step_confirmed", stepKey: "p2_crm", inputMode: "inline" }),
    "Step confirmed: CRM (no activity)",
  );
  assert.equal(
    reasonLabel({ writeReason: "step_saved", stepKey: "p2_additions", inputMode: "xlsx" }),
    "Saved on the step: Additions (uploaded sheet)",
  );
  assert.equal(reasonLabel({ writeReason: "unspecified", stepKey: null, inputMode: "inline" }), "Reason not recorded");
  assert.equal(isTypedByHand({ writeReason: "step_saved" }), true);
  assert.equal(isTypedByHand({ writeReason: "step_confirmed" }), false, "a confirm carries the module's figure, nobody typed it");

  assert.equal(actorLabel({ changedBy: "system", changedByName: null }), "Phoenix (automatic)");
  assert.equal(actorLabel({ changedBy: "B-10", changedByName: "Test Person" }), "Test Person");
  assert.equal(
    actorLabel({ changedBy: "B-10", changedByName: null }),
    "A user not on the employee list",
    "never an HR id on screen",
  );

  assert.equal(valueLabel(null), "empty");
  assert.equal(valueLabel("1200.00"), "1,200");
  assert.equal(valueLabel("533.33"), "533.33");
  assert.equal(valueLabel("true"), "Yes");
  assert.equal(valueLabel("Resigned 30 Sep"), "Resigned 30 Sep");

  // The September confirm that froze the two figures: 00:09 UTC is 03:09 in Cairo (UTC+3 that day).
  assert.equal(cairoTimeLabel("2026-10-07T00:09:08.962Z"), "7 Oct 2026, 03:09");

  // ---- The drift warning says "typed" ONLY when the history says a person saved it ----------------
  // The 2026-10-07 case: Aisha's 1,200.00 was written by the Part 2 CRM step's CONFIRM, and the
  // warning called it "someone entered by hand". From the history it now reads as what it was.
  const confirmWrote = describeChargeSource({
    kind: "step",
    name: null,
    stepKey: "p2_crm",
    at: "2026-10-07T00:11:38.083Z",
  });
  assert.equal(
    confirmWrote,
    "which the CRM (no activity) step wrote when it was confirmed on 7 Oct 2026, 03:11; nobody typed it, and it still stands",
  );
  assert.doesNotMatch(confirmWrote, /by hand|(someone|somebody|which \w+) typed/, "a confirm is never described as a person's figure");
  assert.match(
    describeChargeSource({ kind: "typed", name: "Test Person", stepKey: "p2_crm", at: "2026-10-07T07:00:00Z" }),
    /^which Test Person typed on CRM \(no activity\) on 7 Oct 2026, 10:00; it still stands$/,
  );
  assert.match(describeChargeSource({ kind: "system", name: null, stepKey: null, at: null }), /Phoenix set automatically/);
  const unrecorded = describeChargeSource({ kind: "unknown", name: null, stepKey: null, at: null });
  assert.match(unrecorded, /who set it is not recorded/, "a figure older than the history is never guessed at");
  assert.doesNotMatch(unrecorded, /typed|by hand/);
  assert.equal(describeChargeSource(undefined), unrecorded, "no lookup reads as unrecorded, never as typed");

  assert.equal(chargeSourceKind("step_saved"), "typed");
  assert.equal(chargeSourceKind("step_confirmed"), "step");
  assert.equal(chargeSourceKind("part1_confirmed"), "step");
  assert.equal(chargeSourceKind("deduction_resync"), "system");
  assert.equal(chargeSourceKind(null), "unknown");
  assert.equal(chargeSourceKind("unspecified"), "step", "a write that named no reason is not claimed as typed");

  // A step field's key IS its draft column in camelCase — the lookup depends on the mapping.
  assert.equal(draftColumnForField("crm"), "crm");
  assert.equal(draftColumnForField("unpaidVacations"), "unpaid_vacations");
  assert.equal(draftColumnForField("p1odCrmValue"), "p1od_crm_value");
  assert.equal(draftColumnForField("fingerprintValue"), "fingerprint_value");

  const wizard = readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8");
  assert.doesNotMatch(wizard, /someone entered by hand|somebody entered by hand/, "the banner never asserts a hand edit on its own");
  assert.match(wizard, /describeChargeSource\(row\.chargeSource, cairoTimeLabel\)/, "the banner's wording comes from the history");
}
