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
// The code review of 14 Nov 2026, fixed forward: nine more masked columns, a placeholder decision is
// not a decision and a real one's delete is logged, the view resolves a login through app_auth_users,
// and a restore merges by key instead of emptying the table.
const FIX_FILE = "20261114020715_history_and_undo_log_review_fixes.sql";
// The same review: the log's refusal triggers call the one append-only refusal the payroll and
// deduction trails already use, and the copy 20261113151738 made of it is dropped.
const SHARED_REFUSAL_FILE = "20261114021603_employee_change_log_shares_the_audit_trail_refusal.sql";

const MASKED = [
  "base_salary", "basic_salary", "gross_salary", "net_salary",
  "fuel_allowance", "extra_cost_of_living", "medical_insurance",
  "social_insurance", "taxes", "social_insurance_wage",
  "bank_account", "national_id", "social_insurance_number", "medical_insurance_number",
  "health_card_number", "kaab_elamaal_number", "mobile_number", "personal_email",
  "residence_address", "birth_date",
  "residence_city", "residence_area", "birth_place",
  "kaab_elamaal_issuer", "kaab_elamaal_issue_date", "kaab_elamaal_refund",
  "cv_path", "cv_file_name", "photo_path",
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

/** The body a fresh database runs: the LAST migration that defines the function, cut at its end quote. */
function lastDefiner(files: string[], fn: string): { file: string; body: string } {
  const head = `create or replace function ${fn}(`;
  const definers = files.filter((name) => read(name).toLowerCase().includes(head));
  assert.ok(definers.length > 0, `no migration defines ${fn}`);
  const file = definers[definers.length - 1];
  const sql = read(file);
  const at = sql.toLowerCase().indexOf(head);
  const quote = sql.slice(at).match(/\bas (\$[a-z]*\$)/i);
  assert.ok(quote, `${file}: ${fn} has no dollar-quoted body`);
  const open = sql.indexOf(quote[1], at) + quote[1].length;
  return { file, body: sql.slice(at, sql.indexOf(quote[1], open)) };
}

export async function runEmployeeAndDeductionHistoryTests() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const name of [EMPLOYEE_FILE, DECISION_FILE, RECOVERY_FILE, FIX_FILE, SHARED_REFUSAL_FILE]) {
    assert.ok(files.includes(name), `the migration must still be here: ${name}`);
  }

  // ---- HEADLINE: the employee log never stores an identifier or a salary figure --------------------
  const employee = read(EMPLOYEE_FILE);
  const employeeWriter = lastDefiner(files, "public.phx_log_employee_change").body;
  const masked = quotedList(employeeWriter, "masked  constant text[]");
  assert.deepEqual(
    [...masked].sort(),
    [...MASKED].sort(),
    "the masked list is what keeps bank accounts, national ids and salary figures OUT of the log. A " +
      "column taken off it is stored in clear in every row from then on, and the log is append-only, " +
      "so it can never be cleaned",
  );
  assert.match(
    employeeWriter,
    /if col = any\(masked\) then\s+hidden := array_append\(hidden, col\);\s+else/,
    "a masked column must be named in masked_fields and given NO value",
  );
  assert.deepEqual(
    quotedList(employeeWriter, "ignored constant text[]"),
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
    employeeWriter,
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

  // ---- One append-only refusal, not two ------------------------------------------------------------
  for (const verb of ["update", "delete", "truncate"]) {
    const definers = files.filter((name) => read(name).includes(`trigger employee_change_log_no_${verb} `));
    const last = definers[definers.length - 1];
    assert.match(
      read(last),
      new RegExp(`trigger employee_change_log_no_${verb} before ${verb} on public\\.employee_change_log\\s+for each \\w+ execute function public\\.phx_refuse_audit_trail_change\\(\\);`),
      `${last}: the ${verb} refusal must call phx_refuse_audit_trail_change(), the one refusal every append-only ` +
        "trail shares — a second copy drifts from it",
    );
    assert.match(
      read(last),
      new RegExp(`alter table public\\.employee_change_log enable always trigger employee_change_log_no_${verb};`),
      `${last}: a replaced refusal trigger must be set ENABLE ALWAYS again`,
    );
  }
  const copyFiles = files.filter((name) => read(name).includes("phx_refuse_history_change"));
  assert.ok(
    read(copyFiles[copyFiles.length - 1]).includes("drop function if exists public.phx_refuse_history_change();"),
    "the copy of the append-only refusal must stay dropped",
  );

  // ---- No browser role reaches the log, its view or its functions ---------------------------------
  for (const target of [
    "revoke all on public.employee_change_log from public, anon, authenticated;",
    "revoke all on public.v_employee_change_log from public, anon, authenticated;",
    "revoke execute on function public.phx_log_employee_change() from public, anon, authenticated;",
  ]) {
    assert.ok(employee.includes(target), `missing: ${target}`);
  }
  assert.match(employee, /alter table public\.employee_change_log enable row level security;/);
  assert.match(
    employee,
    /create or replace view public\.v_employee_change_log\s+with \(security_invoker = true\)/,
    "the view must run as its caller, or it would read the log with its owner's rights",
  );

  // ---- The view names the person a login belongs to, never the login read as an hr id -------------
  const viewFiles = files.filter((name) => read(name).includes("create or replace view public.v_employee_change_log"));
  assert.match(
    read(viewFiles[viewFiles.length - 1]),
    /left join public\.app_auth_users u on l\.actor_hr_id is null and u\.login_id = l\.actor_login_id\s+left join public\.employees a on a\.hr_id = coalesce\(l\.actor_hr_id, u\.hr_id\)/,
    "a login id is not an hr id: the actor is resolved through app_auth_users",
  );

  // ---- Deduction decisions: before and after, on the deciding columns only ------------------------
  const decision = lastDefiner(files, "public.phx_log_deduction_decision_change").body;
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
  assert.match(
    decision,
    /case tg_op when 'INSERT' then 'decision_recorded'\s+when 'UPDATE' then 'decision_changed'\s+else 'decision_deleted' end/,
  );
  assert.match(
    decision,
    /if array_length\(fields, 1\) is null then\s+return null;/,
    "a re-save that changes no deciding column, and an untouched placeholder, record nothing",
  );
  assert.match(
    decision,
    /and \(r -> col\) not in \('""'::jsonb, '\[\]'::jsonb\)\s+and not \(col = 'decision_status' and r ->> col = 'Pending'\)/,
    "the Pending placeholder service.ts inserts for every candidate is not a decision; logging it would " +
      "hold every candidate by deductions_audit's RESTRICT key",
  );
  assert.match(
    read(DECISION_FILE),
    /create trigger phx_deductions_decisions_history\s+after insert or update on public\.deductions_decisions/,
  );
  assert.match(
    read(FIX_FILE),
    /create trigger phx_deductions_decisions_history_delete\s+after delete on public\.deductions_decisions/,
    "deleting a real decision must leave its trace",
  );
  assert.ok(
    read(FIX_FILE).includes(
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

  // ---- A restore merges by key: it never empties the table first -------------------------------------
  // A non-deferrable RESTRICT or NO ACTION key (deductions_audit, automated_payroll_audit, ...) refuses
  // the first statement of an empty-and-refill, so five of the 43 could never be restored; and
  // `select *` refuses every table with a generated column.
  const restore = lastDefiner(files, "recovery.restore_table");
  assert.ok(
    !/execute format\('delete from %I\.%I',/.test(restore.body),
    `${restore.file} empties the table before refilling it`,
  );
  assert.match(restore.body, /delete from %I\.%I t where not exists \(/, "only rows the snapshot lacks are deleted");
  assert.match(restore.body, /on conflict \(%s\) do update/, "every other row is put back in place by its key");
  assert.match(restore.body, /a\.attgenerated = ''/, "a generated column is never written");
  assert.ok(!/select \* from jsonb_populate_recordset/.test(restore.body), "the columns are named, never select *");

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
  for (const name of [EMPLOYEE_FILE, DECISION_FILE, RECOVERY_FILE, FIX_FILE, SHARED_REFUSAL_FILE]) {
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
