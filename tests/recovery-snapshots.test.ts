import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

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
  const streamed = read("20261016103901_recovery_snapshot_streamed_fingerprint.sql");

  // Every file explains at length WHY it avoids certain shapes, so the prose mentions the very
  // words the checks below hunt for. Only executable SQL counts. (The first version of this test
  // failed on its own migration's comment saying "TRUNCATE ignores deferred foreign keys".)
  const storeSql = stripSqlComments(store);
  const capsSql = stripSqlComments(caps);
  const orderSql = stripSqlComments(order);
  const streamedSql = stripSqlComments(streamed);

  // One function's body: from its `create or replace function` to the close of the dollar quote
  // that follows it. Read by the quote, not by the next statement, so a body is never cut short by
  // a `grant` or `revoke` written inside a string.
  const bodyOf = (sql: string, fn: string): string => {
    const head = new RegExp(`create or replace function recovery\\.${fn}\\b`, "i").exec(sql);
    assert.ok(head, `recovery.${fn} is not defined in the SQL handed to bodyOf`);
    const opener = /\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(head.index));
    assert.ok(opener, `recovery.${fn} has no dollar-quoted body`);
    const start = head.index + opener.index + opener[0].length;
    const end = sql.indexOf(opener[0], start);
    assert.ok(end > start, `recovery.${fn}'s body never closes its ${opener[0]} quote`);
    return sql.slice(start, end);
  };

  // ---------------------------------------------------------------- it is unreachable

  // 🔴 These are payroll pre-images. A browser role must never have USAGE on the schema — that
  // is what stops PostgREST seeing it at all, whatever the table grants say.
  assert.match(store, /revoke all on schema recovery from anon, authenticated/i,
    "anon and authenticated must have no USAGE on the recovery schema");
  assert.match(store, /revoke all on all tables in schema recovery from public, anon, authenticated/i,
    "and no table grants either");
  for (const [file, sql] of [["the store", storeSql], ["the streamed fingerprint", streamedSql]]) {
    assert.ok(
      !/grant\s+(select|all|execute)[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i.test(sql),
      `nothing in the recovery schema may be granted to a browser role (${file})`,
    );
  }

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

  // ---------------------------------------------------------------- an unchanged hour builds nothing

  // 🔴 The store's first body answered "has it changed?" by BUILDING the table's whole JSON copy
  // and hashing its text. monthly_closing_locks reached 28,457,501 bytes by 2026-10-16, so every
  // :05 held a ~28 MB jsonb plus two ~28 MB strings in one backend on a 2 GB compute, and the runs
  // that took 36-50 s were the minutes production's renders timed out (the account is in
  // docs/security/recovery-snapshots.md, "The streamed fingerprint"). The check is now a streamed
  // fingerprint, and the copy is built only for a table whose fingerprint moved.
  const take = bodyOf(streamedSql, "take_snapshots");
  const fingerprint = bodyOf(streamedSql, "fingerprint_table");
  const payloadFingerprint = bodyOf(streamedSql, "payload_fingerprint");

  assert.match(take, /if v_prev_hash is distinct from v_hash then/,
    "the streamed body must still write a snapshot only when the fingerprint changed");

  // The check reads count, size and fingerprint — and nothing table-sized.
  const checkCall = /select f\.fp_rows, f\.fp_bytes, f\.fp_hash\s+into v_rows, v_bytes, v_hash\s+from recovery\.fingerprint_table\(v_row\.source_schema, v_row\.source_table, v_row\.pk_columns\) f/i;
  assert.match(take, checkCall,
    "the hourly check must call fingerprint_table WITHOUT the payload flag");

  // The copy, and the count, size and fingerprint stored beside it, come out of ONE statement, so
  // what is stored always describes the copy even if the table moved since the check.
  const payloadCall = /select f\.fp_rows, f\.fp_bytes, f\.fp_hash, f\.fp_payload\s+into v_rows, v_bytes, v_hash, v_payload\s+from recovery\.fingerprint_table\([^)]*, true\) f/i;
  assert.match(take, payloadCall,
    "the payload must be read together with the count, size and fingerprint stored beside it");

  // Built only on change: the payload call sits inside the change branch, and nothing before the
  // branch reads a payload.
  const payloadBuiltOnlyOnChange = (body: string): boolean => {
    const branch = body.search(/if v_prev_hash is distinct from v_hash then/i);
    const build = body.search(/fingerprint_table\([^)]*, true\)/i);
    const firstPayloadRead = body.search(/\bfp_payload\b|canonical_payload\s*\(/i);
    return branch >= 0 && build > branch && firstPayloadRead > branch;
  };
  assert.ok(payloadBuiltOnlyOnChange(take),
    "the full copy must be built only inside the changed-table branch — building it to answer "
      + "the question is exactly the cost this replaced");

  assert.ok(!/canonical_payload\s*\(/i.test(take),
    "take_snapshots must not call canonical_payload(): fingerprint_table's payload is the copy");
  assert.ok(!/::\s*text\b/i.test(take),
    "take_snapshots must never cast a payload to text — that is two more table-sized strings");

  // The fingerprint itself: one md5 per row, joined in primary-key order, under the 'r2:' scheme.
  assert.match(fingerprint, /''r2:''\s*\|\|\s*md5\(coalesce\(string_agg\(md5\(r\.recovery_row_text\), '''' order by %1\$s\), ''''\)\)/i,
    "the fingerprint must be 'r2:' || md5 of the row md5s aggregated in primary-key order");
  assert.ok((fingerprint.match(/\boffset 0\b/gi) ?? []).length >= 2,
    "both OFFSET 0 fences must stay — without them the planner evaluates to_jsonb(t) and its text "
      + "once per reference, doubling the work");
  assert.match(fingerprint, /when count\(\*\) = 0 then 2\s+else 2 \+ sum\(octet_length\(r\.recovery_row_text\)\) \+ 2 \* \(count\(\*\) - 1\) end/i,
    "the size must be the row texts plus the array's own '[', ']' and ', ' — byte-identical to "
      + "octet_length(payload::text), so the 64 MB ceiling still means what it did");
  assert.match(fingerprint, /case when p_with_payload/i,
    "the payload is aggregated only when the caller asks for it");

  // The stored payload re-fingerprints to the same value, in the same order.
  assert.match(payloadFingerprint, /'r2:' \|\| md5\(coalesce\(string_agg\(md5\(x\.element_text\), '' order by e\.ord\), ''\)\)/i,
    "payload_fingerprint must hash the stored elements in their stored (primary-key) order");
  assert.match(payloadFingerprint, /with ordinality as e\(value, ord\)/i);

  // A version stored before the scheme moved is upgraded once, in place — never re-captured, which
  // would evict real history from a table that keeps only twelve versions.
  assert.match(take, /if v_prev_id is not null and v_prev_hash not like 'r2:%' then/i,
    "a legacy hash must be recognised by its missing 'r2:' prefix");
  assert.match(take, /update recovery\.table_snapshots s\s+set content_hash = v_prev_hash\s+where s\.id = v_prev_id/i,
    "the upgraded fingerprint must be written onto that one newest row");

  // The helpers are reached only through take_snapshots(), which runs as its owner.
  for (const helper of ["fingerprint_table\\(text, text, text\\[\\], boolean\\)", "payload_fingerprint\\(jsonb\\)"]) {
    assert.match(streamed, new RegExp(`revoke execute on function recovery\\.${helper} from public, anon, authenticated`, "i"),
      `recovery.${helper.replace(/\\/g, "")} must be revoked from public, anon and authenticated`);
  }
  assert.match(streamed, /revoke execute on function recovery\.take_snapshots\(\) from public, anon, authenticated/i);
  assert.match(streamed, /grant execute on function recovery\.take_snapshots\(\) to service_role/i);

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
  //
  // Asked PER FUNCTION, of the function's own body, since 20261016103901 replaced take_snapshots()
  // a third time: whichever migration defines each of the three LAST is the one a fresh database
  // ends up running, so that body must carry the id tiebreak and no untied ordering. A tie-break
  // migration replayed too early, or a later redefinition that drops the tiebreak, both leave a
  // last definer without it.
  const migDir = new URL("../supabase/migrations/", import.meta.url);
  const all = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  const tiedOrdering = /order by [a-z]\.taken_at (?:desc|asc), [a-z]\.id (?:desc|asc)/i;
  const untiedOrdering = /order by [a-z]\.taken_at (?:desc|asc)(?!,)/i;

  let definersSeen = 0;
  for (const fn of ["purge_snapshots", "take_snapshots", "restore_table"]) {
    const head = new RegExp(`create or replace function recovery\\.${fn}\\b`, "i");
    const definers = all
      .map((f) => [f, stripSqlComments(readFileSync(new URL(f, migDir), "utf8"))] as const)
      .filter(([, sql]) => head.test(sql));
    assert.ok(definers.length >= 2,
      `recovery.${fn} should be defined by the store and at least one later fix; found `
        + `${definers.map(([f]) => f).join(", ") || "none"} — the directory read is broken`);
    definersSeen += definers.length;

    const [lastFile, lastSql] = definers[definers.length - 1];
    const body = bodyOf(lastSql, fn);
    assert.match(body, tiedOrdering,
      `${lastFile} is the LAST migration to define recovery.${fn}, so its body is what a fresh `
        + "database runs — and it ranks snapshots without the id tiebreak");
    assert.ok(!untiedOrdering.test(body),
      `${lastFile}'s recovery.${fn} still ranks on taken_at alone somewhere`);
  }
  // 3 + 3 + 2 on 2026-10-16: the store's three, the version cap's purge, the tie-break's three and
  // the streamed take_snapshots. A sweep that finds fewer has stopped reading the directory.
  assert.ok(definersSeen >= 8, `found only ${definersSeen} definitions of the three functions`);

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

  // The old body's shape — build the copy, then hash its text — must trip every streamed check.
  const buildThenHash = `
      v_payload := recovery.canonical_payload(v_row.source_schema, v_row.source_table, v_row.pk_columns);
      v_hash := md5(v_payload::text);
      if v_prev_hash is distinct from v_hash then
        insert into recovery.table_snapshots (payload) values (v_payload);
      end if;`;
  assert.ok(!payloadBuiltOnlyOnChange(buildThenHash),
    "the built-only-on-change detector must reject a body that builds the copy to answer the question");
  assert.ok(/canonical_payload\s*\(/i.test(buildThenHash), "the canonical_payload detector must fire on the old body");
  assert.ok(/::\s*text\b/i.test(buildThenHash), "the text-cast detector must fire on the old body");

  // A payload read hoisted above the branch, even through fingerprint_table, is the same cost.
  const hoisted = `
      select f.fp_rows, f.fp_bytes, f.fp_hash, f.fp_payload into v_rows, v_bytes, v_hash, v_payload
      from recovery.fingerprint_table(v_row.source_schema, v_row.source_table, v_row.pk_columns, true) f;
      if v_prev_hash is distinct from v_hash then
        insert into recovery.table_snapshots (payload) values (v_payload);
      end if;`;
  assert.ok(!payloadBuiltOnlyOnChange(hoisted),
    "the built-only-on-change detector must reject a payload read placed before the change test");

  // An unordered aggregate hashes the rows in whatever order the scan returns them, so an unchanged
  // table could read as changed — the order clause is the part that must be present.
  const unordered = "''r2:'' || md5(coalesce(string_agg(md5(r.recovery_row_text), ''''), ''''))";
  assert.ok(
    !/''r2:''\s*\|\|\s*md5\(coalesce\(string_agg\(md5\(r\.recovery_row_text\), '''' order by %1\$s\), ''''\)\)/i.test(unordered),
    "the ordered-fingerprint detector must reject an aggregate with no primary-key order",
  );

  const oneFence = "from (select a.*, a.recovery_row_json::text as recovery_row_text from (select t.id, to_jsonb(t) as recovery_row_json from x t offset 0) a) r";
  assert.ok((oneFence.match(/\boffset 0\b/gi) ?? []).length < 2,
    "the fence counter must notice when one of the two OFFSET 0 fences is gone");
}
