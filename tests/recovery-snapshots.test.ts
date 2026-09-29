import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The hourly recovery undo log for the money tables.
 *
 * Production has NO point-in-time recovery — seven daily backups are the whole story — and the
 * owner declined the ~$100/month PITR add-on on 2026-09-29 in favour of this. That makes the
 * properties below the only thing standing between a bad UPDATE on payroll and a lost day.
 *
 * Everything here is checkable with no database. The behaviour was proven separately, end to
 * end, on production against a throwaway table: seed, delete a row, corrupt a row, restore,
 * and both were undone (see docs/security/recovery-snapshots.md).
 */
export function runRecoverySnapshotTests() {
  const read = (file: string) =>
    readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");

  const store = read("20260929200500_recovery_snapshot_store.sql");
  const caps = read("20260929201500_recovery_per_table_version_cap.sql");
  const order = read("20260929203100_recovery_total_order_on_snapshots.sql");

  // Both files explain at length WHY they avoid certain shapes, so the prose mentions the very
  // words the checks below hunt for. Only executable SQL counts. (The first version of this test
  // failed on its own migration's comment saying "TRUNCATE ignores deferred foreign keys".)
  const stripComments = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

  const storeSql = stripComments(store);
  const capsSql = stripComments(caps);
  const orderSql = stripComments(order);

  // ---------------------------------------------------------------- it is unreachable

  // 🔴 These are payroll pre-images. A browser role must never have USAGE on the schema — that
  // is what stops PostgREST seeing it at all, whatever the table grants say.
  assert.match(store, /revoke all on schema recovery from anon, authenticated/i,
    "anon and authenticated must have no USAGE on the recovery schema");
  assert.match(store, /revoke all on all tables in schema recovery from public, anon, authenticated/i,
    "and no table grants either");
  assert.ok(
    !/grant\s+(select|all)[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(storeSql),
    "nothing in the recovery schema may be granted to a browser role",
  );

  // The one object placed in `public` is the health RPC, and it must be service-role only.
  assert.match(store, /revoke execute on function public\.phx_ci_recovery_health\(\) from public, anon, authenticated/i);
  assert.match(store, /grant execute on function public\.phx_ci_recovery_health\(\) to service_role/i);

  // ---------------------------------------------------------------- the seven tables

  for (const t of [
    "salary_records", "salary_batches", "employees",
    "monthly_closing_publications", "monthly_closing_locks",
    "monthly_targets", "line_area_map",
  ]) {
    assert.ok(store.includes(`'${t}'`), `${t} must be registered as protected`);
  }

  // ---------------------------------------------------------------- the retention rule that matters

  // 🔴 A table's NEWEST version is never purged, at any age. au.line_area_map changes about
  // monthly, so a purely time-based purge would delete the only copy of it — leaving a table
  // that LOOKS protected with nothing to restore from. `rn > cap` is what guarantees rn = 1
  // always survives.
  assert.match(caps, /r\.rn\s*>\s*greatest\(r\.cap,\s*1\)/,
    "the version purge must keep rank 1 — a table's newest snapshot is never deleted");
  assert.match(caps, /where r\.rn > 1/,
    "the byte-ceiling purge must also never take a table's newest snapshot");

  // The daily marker keeps older recovery points for a slow-changing table.
  assert.match(caps, /keep_daily and r\.taken_at >= now\(\) - interval '30 days'/);

  // ---------------------------------------------------------------- change detection

  // The whole cost model depends on this: unchanged tables must write nothing.
  assert.match(storeSql, /if v_prev_hash is distinct from v_hash then/,
    "a snapshot is written only when the content hash changed");

  // ---------------------------------------------------------------- the restore is guarded

  assert.match(store, /p_dry_run boolean default true/,
    "restore_table must be read-only unless explicitly told otherwise");
  assert.match(store, /insert into recovery\.restore_preimages/,
    "applying a restore must capture the CURRENT contents first — there is no PITR behind a wrong restore");
  assert.ok(
    !/\btruncate\b/i.test(storeSql),
    "the restore must DELETE, not TRUNCATE: TRUNCATE ignores deferred foreign keys",
  );

  // ---------------------------------------------------------------- the 42702 lesson

  // Both functions are plpgsql and their bodies query tables whose column names collide with
  // nothing only because every reference is qualified. An unqualified one compiles clean and
  // fails at CALL time — that is what broke au.f_monthly_attribution for 2m46s earlier the same
  // day. Guard the specific shape: a bare `product_code`-style select inside these bodies.
  assert.ok(
    !/select\s+upper\(btrim\(product_code\)\)/i.test(storeSql + capsSql),
    "columns inside a plpgsql body must be qualified — a bare name that collides with a declared "
      + "variable or OUT parameter compiles and then fails at call time with 42702",
  );

  // ---------------------------------------------------------------- the ordering must be TOTAL

  // 🔴 THIS IS THE ONE THE SHAPE CHECK ABOVE COULD NOT SEE. `rn > greatest(cap, 1)` was present
  // and correct from the first commit, and the guarantee still failed: `taken_at default now()`
  // is the TRANSACTION timestamp, so snapshots taken in one transaction tie, row_number() picks
  // rn = 1 arbitrarily, and the purge kept the two OLDEST of four (measured on production against
  // a throwaway table, 2026-09-29 — v1 and v2 survived while the live table held v4).
  //
  // A correct-looking rank is worthless on a non-total order. Both halves are asserted.
  assert.match(orderSql, /alter column taken_at set default clock_timestamp\(\)/i,
    "taken_at must default to clock_timestamp(), which advances INSIDE a transaction — now() does not");

  const tieBroken = orderSql.match(/order by [a-z]\.taken_at (?:desc|asc), [a-z]\.id (?:desc|asc)/gi) ?? [];
  assert.equal(tieBroken.length, 5,
    `every snapshot ordering must tie-break on id; found ${tieBroken.length} of 5`);
  assert.ok(
    !/order by [a-z]\.taken_at (?:desc|asc)(?!,)/i.test(orderSql),
    "no ordering in the tie-break migration may still rank on taken_at alone",
  );

  // Oldest-first and newest-first must tie-break in their OWN direction, or the byte-ceiling purge
  // would take the newest of a tied group as its "oldest" victim.
  assert.match(orderSql, /order by r\.taken_at asc, r\.id asc/i,
    "the oldest-first victim scan must tie-break ascending");

  // ---------------------------------------------------------------- replay order

  // 🔴 The fix REPLACES functions created by the other two migrations, so on a fresh database it
  // must run AFTER them. Named 20260929200142 (the version the ledger auto-assigned) it would have
  // replayed FIRST and then been overwritten by the very definitions it repairs — a database that
  // rebuilds itself straight back into the bug, with every test still green.
  // Read the directory rather than comparing literals: a test that compares two hardcoded names
  // can never fail, and the whole point is to catch a RENAME.
  const migDir = new URL("../supabase/migrations/", import.meta.url);
  const all = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  const withTiebreak = all.filter((f) =>
    /order by [a-z]\.taken_at (?:desc|asc), [a-z]\.id/i.test(
      stripComments(readFileSync(new URL(f, migDir), "utf8"))));
  assert.equal(withTiebreak.length, 1,
    `exactly one migration should introduce the id tiebreak; found ${withTiebreak.join(", ") || "none"}`);

  const defines = all.filter((f) =>
    /create or replace function recovery\.(purge_snapshots|take_snapshots|restore_table)/i.test(
      stripComments(readFileSync(new URL(f, migDir), "utf8"))));
  const lastDefiner = defines[defines.length - 1];
  assert.equal(lastDefiner, withTiebreak[0],
    "the tie-break migration must be the LAST one to define these functions — replayed earlier, "
      + "a later migration overwrites it and the database rebuilds itself back into the bug");

  // ---------------------------------------------------------------- negative controls

  // Without these, a file that simply lost the guards would pass everything above.
  const noNewestGuard = "delete from recovery.table_snapshots d using ranked r where d.id = r.id and r.rn > 0;";
  assert.ok(
    !/r\.rn\s*>\s*greatest\(r\.cap,\s*1\)/.test(noNewestGuard),
    "the newest-survives detector must not match a purge that deletes everything",
  );

  const grantedToAnon = "grant select on all tables in schema recovery to anon;";
  assert.ok(
    /grant\s+(select|all)[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(grantedToAnon),
    "the browser-grant detector must fire on the shape it exists to catch",
  );

  const truncating = "truncate table public.salary_records;";
  assert.ok(/\btruncate\b/i.test(truncating), "the TRUNCATE detector must fire on a real TRUNCATE");

  const untied = "order by s.taken_at desc limit 1;";
  assert.ok(
    /order by [a-z]\.taken_at (?:desc|asc)(?!,)/i.test(untied),
    "the untied-ordering detector must fire on the exact shape that caused the incident",
  );

  const wrongWayTiebreak = "order by r.taken_at asc, r.id desc";
  assert.ok(
    !/order by r\.taken_at asc, r\.id asc/i.test(wrongWayTiebreak),
    "the ascending-tiebreak detector must reject a tiebreak that runs the other way",
  );
}
