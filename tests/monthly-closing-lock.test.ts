import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE LOCK HAS TO LIVE IN THE DATABASE, NOT IN REACT.
//
// The owner asked for a Lock button so a finished month cannot change afterwards. What he is
// actually afraid of is not a user editing a published month through the screen — it is the month
// moving underneath him: a re-import, a migration, an ad-hoc SQL repair. Every one of those goes
// nowhere near this application.
//
// That is not hypothetical. In one night a Pharma Overseas re-import silently reverted 24
// customers' area rulings (1,425 units) and put a 212-unit double count back into CNS. Neither
// touched a screen. A lock implemented as a disabled button would have stopped neither.
//
// So these tests pin the properties that make the lock real, and they read the MIGRATION, because
// the migration is the enforcement. If someone later "simplifies" this into an application-level
// check, these fail.

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

/** SQL with `-- comments` removed. Needed for the absence checks below: the migration's own prose
 *  explains why FOR EACH ROW was rejected, and a naive search finds that sentence and "proves" the
 *  opposite of what it says. */
function sqlCode(text: string): string {
  return text.replace(/--[^\n]*/g, "");
}

export function runMonthlyClosingLockTests() {
  const migration = source("supabase/migrations/20260810140000_monthly_closing_lock.sql");
  const migrationCode = sqlCode(migration);

  // ── 1. Triggers exist on all three tables a closing is built from ──────────
  // Missing any one of them leaves a door open: the matrix is built from fact_rollup, the details
  // panel from the directory rollup, and both are rebuilt from import_rows.
  for (const table of [
    "source_of_sales_import_rows",
    "source_of_sales_fact_rollup",
    "source_of_sales_customer_directory_rollup",
  ]) {
    for (const op of ["insert", "update", "delete"]) {
      assert.match(
        migration,
        new RegExp(`create trigger trg_lock_guard_${op.slice(0, 3)} after ${op} on public\\.${table}`),
        `${table} must reject ${op.toUpperCase()} on a locked month — a table left unguarded is the whole hole`,
      );
    }
  }

  // ── 2. UPDATE and DELETE check the OLD rows, not only the NEW ones ─────────
  // Checking NEW alone would block writing INTO a locked month but happily allow moving a row OUT
  // of it — `update ... set invoice_period = <an open month>` would empty a locked closing.
  // Assert this PER UPDATE TRIGGER, not once over the whole file. A file-wide search for
  // "old table as old_rows" passes on the DELETE triggers alone — so it kept passing when the OLD
  // table was stripped from every UPDATE trigger, which is precisely the hole. Caught by breaking
  // the migration on purpose and watching this test stay green.
  for (const table of [
    "source_of_sales_import_rows",
    "source_of_sales_fact_rollup",
    "source_of_sales_customer_directory_rollup",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `create trigger trg_lock_guard_upd after update on public\\.${table}\\s+referencing new table as new_rows old table as old_rows`,
      ),
      `${table}'s UPDATE trigger must declare BOTH transition tables — with only NEW, a row can be moved OUT of a locked month and the closing quietly empties`,
    );
  }
  assert.match(
    migration,
    /if tg_op in \('UPDATE', 'DELETE'\) then[\s\S]*?from old_rows r/,
    "the guard must actually query old_rows for UPDATE and DELETE",
  );

  // ── 3. Statement-level, not row-level ─────────────────────────────────────
  // A July import writes ~42,000 rows in one statement. FOR EACH ROW would run 42,000 lookups and
  // make every import slower forever, which is how a safety feature gets ripped out again.
  assert.match(
    migration,
    /for each statement/,
    "the guard must be statement-level — row-level would cost one lookup per row on a 42,000-row import",
  );
  assert.ok(
    !/for each row/i.test(migrationCode),
    "no row-level trigger: transition tables give the same answer once per statement",
  );

  // ── 4. Only ONE active lock per (line, period) ────────────────────────────
  assert.match(
    migration,
    /create unique index if not exists monthly_closing_locks_one_active[\s\S]*?where unlocked_at is null/,
    "a second active lock for the same month would make 'is it locked?' ambiguous",
  );

  // ── 5. Unlock is FREE, by the owner's decision ────────────────────────────
  // He asked for a switch he can flip both ways without ceremony. An unlock that demands a typed
  // reason is a lock people stop using — and a lock nobody applies protects nothing.
  assert.match(
    migration,
    /p_reason text default null/,
    "unlock must not demand a reason — the owner asked for one click each way",
  );
  assert.ok(
    !/requires a written reason/.test(migrationCode),
    "the mandatory-reason guard was removed on the owner's instruction; do not reinstate it",
  );

  // ── 6. Unlock keeps history ───────────────────────────────────────────────
  // Releasing a month must stamp the existing row, never delete it: who froze it and who released
  // it is the only record of what a published number was allowed to be.
  assert.match(
    migration,
    /update public\.monthly_closing_locks\s+set unlocked_at = now\(\)/,
    "unlock must stamp the lock row",
  );
  assert.ok(
    !/delete from public\.monthly_closing_locks/i.test(migrationCode),
    "a lock row must never be deleted — it is the audit trail of what was frozen",
  );

  // ── 7. The application layer does not pretend to be the lock ──────────────
  const service = source("src/lib/sales/monthly-closing-lock.ts");
  assert.match(
    service,
    /return null;/,
    "an unreadable lock state must read as NOT locked — showing an open month as protected is the one lie this cannot afford",
  );

  // ── 8. The route is admin-gated like publish ──────────────────────────────
  const route = source("app/api/sales/monthly-closing/lock/route.ts");
  assert.match(route, /Super Admin/, "locking must be restricted to the admin account, same as publishing");
  assert.match(
    route,
    /assertPermission\(access, "sales", "import"\)/,
    "server-side permission check is the security boundary, not the hidden button",
  );
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.match(route, new RegExp(`export async function ${method}\\(`), `the route must expose ${method}`);
  }
}
