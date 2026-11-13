import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * EVERY CHANGE TO AN EMPLOYEE AND TO A DEDUCTION DECISION IS KEPT, AND THE MONEY AND PEOPLE TABLES
 * ARE IN THE HOURLY UNDO LOG (enterprise audit 2026-11-13, REC-036 and REC-039).
 *
 * Three migrations, applied to staging and production on 13 Nov 2026 by scripts/apply-sql-file.mjs:
 *   - 20261113151738 — public.employee_change_log, written by a trigger on public.employees. An
 *     employee save is one upsert, so before this nothing recorded who moved a manager, a hire date
 *     or the payroll flag, or what it was before. Salary figures and personal identifiers are NAMED
 *     in masked_fields and never valued.
 *   - 20261113151739 — a trigger on public.deductions_decisions appends the decision before and after
 *     to the append-only public.deductions_audit. A decision is an upsert, so the old one was lost.
 *   - 20261113151741 — 43 more tables registered in recovery.protected_tables.
 *
 * What a live probe cannot see, and this test pins: that the masked list keeps every identifier,
 * that the log stays append-only against replica mode and TRUNCATE, that no browser role is handed
 * it, and that no LATER migration quietly drops a trigger or a registration.
 */

const MIGRATIONS = "supabase/migrations";
const EMPLOYEE_FILE = "20261113151738_employee_change_log.sql";
const DECISION_FILE = "20261113151739_deduction_decision_history.sql";
const RECOVERY_FILE = "20261113151741_recovery_protects_money_and_people_tables.sql";

const MASKED = [
  "base_salary", "basic_salary", "gross_salary", "net_salary",
  "fuel_allowance", "extra_cost_of_living", "medical_insurance",
  "social_insurance", "taxes", "social_insurance_wage",
  "bank_account", "national_id", "social_insurance_number", "medical_insurance_number",
  "health_card_number", "kaab_elamaal_number", "mobile_number", "personal_email",
  "residence_address", "birth_date",
];

const DECIDING = [
  "decision_status", "decision_reason", "hr_note",
  "applied_value", "applied_amount", "applied_dates", "decided_by",
];

const FEWER_VERSIONS = [
  "attendance_raw_punches",
  "deductions_candidates",
  "deductions_decisions",
  "outstation_expense_requests",
  "v2_vacation_requests",
];

// Left out on purpose (docs/security/recovery-snapshots.md): append-only trails have nothing to
// undo, and rebuilt tables are restored by restoring their source.
const NEVER_REGISTERED = [
  "automated_payroll_audit",
  "deductions_audit",
  "employee_salary_change_log",
  "employee_change_log",
  "expense_claims",
  "expense_claim_events",
];

function read(name: string): string {
  return readFileSync(path.join(MIGRATIONS, name), "utf8");
}

function quotedList(body: string, name: string): string[] {
  const at = body.indexOf(`${name}`);
  assert.ok(at >= 0, `the ${name} list must still be declared`);
  const open = body.indexOf("array[", at);
  const close = body.indexOf("]", open);
  return [...body.slice(open, close).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
}

export async function runEmployeeAndDeductionHistoryTests() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const name of [EMPLOYEE_FILE, DECISION_FILE, RECOVERY_FILE]) {
    assert.ok(files.includes(name), `the migration must still be here: ${name}`);
  }

  // ---- HEADLINE: the employee log never stores an identifier or a salary figure --------------------
  const employee = read(EMPLOYEE_FILE);
  const masked = quotedList(employee, "masked  constant text[]");
  assert.deepEqual(
    [...masked].sort(),
    [...MASKED].sort(),
    "the masked list is what keeps bank accounts, national ids and salary figures OUT of the log. A " +
      "column taken off it is stored in clear in every row from then on, and the log is append-only, " +
      "so it can never be cleaned",
  );
  assert.match(
    employee,
    /if col = any\(masked\) then\s+hidden := array_append\(hidden, col\);\s+else/,
    "a masked column must be named in masked_fields and given NO value",
  );
  assert.deepEqual(
    quotedList(employee, "ignored constant text[]"),
    ["updated_at", "total_experience_years", "total_experience_as_of"],
    "only the columns the row's own triggers stamp on every save are ignored — ignoring more hides a " +
      "real change",
  );
  assert.match(
    employee,
    /create trigger phx_employees_change_log\s+after insert or update or delete on public\.employees\s+for each row/,
    "the history is a trigger on all three verbs, so no code path can skip it",
  );
  assert.match(
    employee,
    /create or replace function public\.phx_log_employee_change\(\)[\s\S]*?security definer\s+set search_path = public, pg_temp/,
    "the writer runs as definer with a fixed search_path, so the row is written whoever saves",
  );
  assert.match(
    employee,
    /case when v_login is not null or v_hr is not null then 'app' else 'unattributed' end/,
    "a write with no actor header is recorded as unattributed, never dropped",
  );

  // ---- Append-only, against UPDATE, DELETE, TRUNCATE and replica mode -----------------------------
  for (const verb of ["update", "delete", "truncate"]) {
    assert.match(
      employee,
      new RegExp(`create trigger employee_change_log_no_${verb} before ${verb} on public\\.employee_change_log\\s+for each ${verb === "truncate" ? "statement" : "row"}`),
      `${verb.toUpperCase()} on the log must be refused by trigger (a REVOKE never binds the owner)`,
    );
    assert.match(
      employee,
      new RegExp(`alter table public\\.employee_change_log enable always trigger employee_change_log_no_${verb};`),
      `the ${verb} refusal must be ENABLE ALWAYS, or session_replication_role = replica walks past it`,
    );
  }

  // ---- No browser role reaches the log, its view or its functions ---------------------------------
  for (const target of [
    "revoke all on public.employee_change_log from public, anon, authenticated;",
    "revoke all on public.v_employee_change_log from public, anon, authenticated;",
    "revoke execute on function public.phx_log_employee_change() from public, anon, authenticated;",
    "revoke execute on function public.phx_refuse_history_change() from public, anon, authenticated;",
  ]) {
    assert.ok(employee.includes(target), `missing: ${target}`);
  }
  assert.match(employee, /alter table public\.employee_change_log enable row level security;/);
  assert.match(
    employee,
    /create or replace view public\.v_employee_change_log\s+with \(security_invoker = true\)/,
    "the view must run as its caller, or it would read the log with its owner's rights",
  );

  // ---- Deduction decisions: before and after, on the deciding columns only ------------------------
  const decision = read(DECISION_FILE);
  assert.deepEqual(
    quotedList(decision, "deciding constant text[]"),
    DECIDING,
    "the deciding columns are what makes a change a change. A column dropped from this list is a " +
      "change to what payroll charges that leaves no trace",
  );
  assert.match(
    decision,
    /insert into public\.deductions_audit \(candidate_id, actor_hr_id, action, detail\)/,
    "the history goes into the existing append-only deductions_audit, not a new unguarded table",
  );
  assert.match(decision, /'decision_recorded' else 'decision_changed'/);
  assert.match(
    decision,
    /if tg_op = 'UPDATE' and array_length\(fields, 1\) is null then\s+return null;/,
    "a re-save that changes no deciding column records nothing",
  );
  assert.match(
    decision,
    /create trigger phx_deductions_decisions_history\s+after insert or update on public\.deductions_decisions/,
  );
  assert.ok(
    decision.includes(
      "revoke execute on function public.phx_log_deduction_decision_change() from public, anon, authenticated;",
    ),
  );

  // ---- The undo log: 43 tables, the five large ones capped at 24 versions -------------------------
  const recovery = read(RECOVERY_FILE);
  const rows = [
    ...recovery.matchAll(/\('public', '([a-z_0-9]+)',\s*array\[[^\]]+\],\s*'REC-036 [^']*', (\d+)\)/g),
  ].map((m) => ({ table: m[1], maxVersions: Number(m[2]) }));
  assert.equal(rows.length, 43, "43 money and people tables are registered — none may fall off the list");
  assert.equal(new Set(rows.map((r) => r.table)).size, 43, "no table is registered twice");
  assert.deepEqual(
    rows.filter((r) => r.maxVersions === 24).map((r) => r.table).sort(),
    FEWER_VERSIONS,
    "the five largest keep 24 versions so they cannot drive the store to its 512 MB ceiling and evict " +
      "every other table's history",
  );
  for (const row of rows) {
    assert.ok(
      row.maxVersions === 24 || row.maxVersions === 72,
      `${row.table} keeps ${row.maxVersions} versions; only 24 and 72 were measured`,
    );
  }
  for (const table of NEVER_REGISTERED) {
    assert.ok(
      !rows.some((r) => r.table === table),
      `${table} is append-only or rebuilt; registering it only spends the store`,
    );
  }
  assert.match(
    recovery,
    /where i\.indrelid = format\('%I\.%I', r\.source_schema, r\.source_table\)::regclass\s+and i\.indisprimary;/,
    "the migration must refuse a registered key that is not the table's real primary key",
  );

  // ---- Nothing LATER takes any of it back ------------------------------------------------------------
  const guarded = [
    "phx_employees_change_log",
    "employee_change_log_no_update",
    "employee_change_log_no_delete",
    "employee_change_log_no_truncate",
    "phx_deductions_decisions_history",
  ];
  for (const name of files.filter((file) => file > RECOVERY_FILE)) {
    const body = readFileSync(path.join(MIGRATIONS, name), "utf8").toLowerCase();
    for (const trigger of guarded) {
      assert.ok(
        !new RegExp(`drop trigger (if exists )?${trigger}\\b`).test(body) &&
          !new RegExp(`disable trigger ${trigger}\\b`).test(body),
        `${name} drops or disables ${trigger}. Turning a history off is a deliberate act the owner is ` +
          `told about first, never a line inside another migration`,
      );
    }
    assert.ok(
      !/delete from recovery\.protected_tables/.test(body) &&
        !/set enabled = false[^;]*rec-036/.test(body),
      `${name} takes a REC-036 table out of the undo log`,
    );
    assert.ok(
      !/grant[^;]*employee_change_log[^;]*(anon|authenticated)/.test(body),
      `${name} hands the employee change log to a browser role`,
    );
  }

  // ---- No ledger row, so each needs its evidenced exception ---------------------------------------
  const inventory = readFileSync("scripts/lib/migration-inventory.ts", "utf8");
  for (const name of [EMPLOYEE_FILE, DECISION_FILE, RECOVERY_FILE]) {
    assert.ok(
      inventory.includes(`"${name}",`),
      `${name} was applied by apply-sql-file.mjs, which writes no ledger row: it needs its evidenced ` +
        `ACKNOWLEDGED_EXCEPTIONS entry`,
    );
  }

  // ---- The application never edits the history it does not write ---------------------------------
  // The trigger is the only writer; the database refuses an update or delete, so code that tries
  // would be a 500 on every employee save.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(full, "utf8").includes(`from("employee_change_log")`)) {
        offenders.push(full);
      }
    }
  };
  walk("src");
  walk("app");
  assert.deepEqual(
    offenders,
    [],
    "only the trigger writes employee_change_log; application code reads v_employee_change_log",
  );
}
