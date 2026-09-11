import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * THE PAYROLL DECISION TRAIL IS APPEND-ONLY, AND NOTHING MAY QUIETLY DISARM IT.
 *
 * FINDING 26. `automated_payroll_audit` (202 rows on production) and `deductions_audit` (1,566) are
 * the only record of who decided what on a payroll month. Both had zero protective triggers,
 * `authenticated` held DELETE, UPDATE and TRUNCATE on both, and every foreign key into them was
 * ON DELETE CASCADE.
 *
 * It stopped being merely an audit question when held settlements shipped. `loadHeldBalances`
 * works out who is still owed a second instalment by reading the audit rows whose action is
 * 'published'. Losing those rows does not lose the record of a payment, it loses the payment.
 *
 * THREE VERBS, THREE MECHANISMS, AND A REVOKE IS NONE OF THEM.
 *   - A REVOKE never binds the table OWNER, and a cascade runs as the owner. So
 *     `has_table_privilege` can report a table locked while a cascade empties it.
 *   - TRUNCATE fires no ROW trigger at all, so it needs its own STATEMENT-level one.
 *   - `session_replication_role = replica` switches an ordinary trigger off, so each is
 *     ENABLE ALWAYS.
 *
 * Proven on staging as the OWNER before shipping: all three verbs refused on both tables, INSERT
 * still working, deleting the parent run refused by the foreign key, and replica mode refused too.
 *
 * This test guards the half a live probe cannot: that no LATER migration takes the guard back off.
 */

const MIGRATIONS = "supabase/migrations";
const GUARD_FILE = "20260912010000_payroll_audit_trail_append_only.sql";
const TABLES = ["automated_payroll_audit", "deductions_audit"] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

export async function runPayrollAuditTrailAppendOnlyTests() {
  const files = migrationFiles();
  assert.ok(files.includes(GUARD_FILE), `the append-only migration must still be here: ${GUARD_FILE}`);

  const guard = readFileSync(path.join(MIGRATIONS, GUARD_FILE), "utf8");

  // ---- HEADLINE: all three verbs are refused, by trigger, on both trails ----------------------
  assert.match(
    guard,
    /create trigger %I before update on public\.%I for each row/,
    "UPDATE needs a row-level trigger",
  );
  assert.match(
    guard,
    /create trigger %I before delete on public\.%I for each row/,
    "DELETE needs a row-level trigger, which is also what catches a cascade",
  );
  assert.match(
    guard,
    /create trigger %I before truncate on public\.%I for each statement/,
    "TRUNCATE fires no row trigger, so it needs a STATEMENT-level one of its own — this is the " +
      "half that is always forgotten, and it empties the table in one word",
  );
  assert.match(
    guard,
    /enable always trigger/,
    "and each must be ENABLE ALWAYS, or `session_replication_role = replica` walks straight past it",
  );

  for (const table of TABLES) {
    assert.ok(guard.includes(`'${table}'`), `${table} must be covered by the guard migration`);
  }

  // ---- Every cascade into a trail becomes a refusal ----------------------------------------------
  assert.match(
    guard,
    /confdeltype = 'c'/,
    "the migration must find the cascading foreign keys rather than trusting a hardcoded name",
  );
  assert.match(
    guard,
    /replace\(fk\.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'\)/,
    "a cascade is the one delete path that asks nobody's permission — it must become a RESTRICT",
  );

  // ---- Nothing LATER may take the guard off -------------------------------------------------------
  // This is the assertion the live probe cannot make. A migration that drops one of these triggers
  // leaves production looking exactly as it does today until the day something deletes a run.
  const later = files.filter((name) => name > GUARD_FILE);
  for (const name of later) {
    const body = readFileSync(path.join(MIGRATIONS, name), "utf8").toLowerCase();
    for (const table of TABLES) {
      for (const verb of ["no_update", "no_delete", "no_truncate"]) {
        assert.ok(
          !body.includes(`drop trigger if exists ${table}_${verb}`) &&
            !body.includes(`drop trigger ${table}_${verb}`),
          `${name} drops the ${table}_${verb} guard. Removing a payroll decision is a deliberate ` +
            `act that needs the owner told first, never a line inside another migration.`,
        );
        assert.ok(
          !body.includes(`disable trigger ${table}_${verb}`),
          `${name} disables the ${table}_${verb} guard`,
        );
      }
      // A single GRANT statement, which cannot contain a semicolon, handing a write back on this
      // table. `[^;]` already spans newlines, so the dotAll flag is both unnecessary and a
      // typecheck failure under this repo's target.
      const regrant = new RegExp("grant[^;]*(update|delete|truncate)[^;]*" + table + "[^;]*authenticated");
      assert.ok(
        !regrant.test(body),
        `${name} hands the write back to authenticated on ${table}`,
      );
    }
  }

  // ---- The application must never try to change a decision it already wrote ------------------------
  // The database now refuses, so a stray update or delete would be a 500 rather than a silent loss.
  // Both are correctable only by writing a NEW row that supersedes the old one.
  const sources = [
    "src/lib/automated-payroll/audit.ts",
    "src/lib/automated-payroll/held-settlements.ts",
    "src/lib/deductions/service.ts",
  ];
  for (const file of sources) {
    const body = readFileSync(file, "utf8");
    for (const table of TABLES) {
      let at = body.indexOf(`from("${table}")`);
      while (at >= 0) {
        const window = body.slice(at, at + 400);
        assert.ok(
          !window.includes(".delete()") && !/\.update\(/.test(window),
          `${file} changes a row in ${table}. The trail is append-only: supersede with a new row.`,
        );
        at = body.indexOf(`from("${table}")`, at + 1);
      }
    }
  }
}
