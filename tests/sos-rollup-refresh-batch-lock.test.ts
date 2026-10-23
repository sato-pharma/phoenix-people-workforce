import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Each per-batch Closing rollup rebuild takes a lock on (its own name, the batch) before it touches a row.
 *
 * Found in the 23 October 2026 technical audit (P4-04). The three refresh functions below each DELETE the
 * batch's rows and INSERT them again, and none held a lock. Two rebuilds of one batch at the same time — a
 * mapping save beside an address correction, a retry beside a slow first attempt — each delete what is
 * committed, then each insert a full set, and the batch counts twice in every figure read from it, silently.
 * That is the mechanism behind the 29 September doubled attribution.
 *
 * `20261023070000`–`20261023070200` add one line after `begin` and change nothing else (each body is
 * md5-equal to the live one once that line is removed). Proved on staging the same day: with the lock held
 * on one connection, each function waited and hit `lock_timeout` (55P03) on the other; two concurrent
 * rebuilds of one batch ran one after the other (3.6 s for two 1.5 s transactions) and left the batch's
 * rows unchanged. This file pins the SHAPE, because the failure it guards against is silent: take the line
 * out and every test of the rebuild's arithmetic still passes.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

const FUNCTIONS = [
  "phx_refresh_sos_fact_rollup",
  "phx_refresh_sos_channel_rollup",
  "phx_refresh_sos_distributor_product_rollup",
] as const;

/** The newest migration that defines the function, found by CONTENT — a later redefinition resolves. */
function newestDefinition(fn: string): { file: string; header: string; code: string } {
  const definer = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i");
  let found: { file: string; sql: string } | null = null;
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(readFileSync(new URL(name, MIGRATIONS), "utf8").replace(/\r\n/g, "\n"));
    if (definer.test(sql)) found = { file: name, sql };
  }
  assert.ok(found, `no migration defines ${fn}`);
  const start = found!.sql.search(definer);
  const open = found!.sql.indexOf("$function$", start);
  const close = found!.sql.indexOf("$function$", open + "$function$".length);
  assert.ok(open > start && close > open, `${found!.file}: the body of ${fn} must sit between $function$ markers`);
  return {
    file: found!.file,
    header: found!.sql.slice(start, open).replace(/\s+/g, " ").toLowerCase(),
    code: found!.sql.slice(open + "$function$".length, close).replace(/\s+/g, " ").toLowerCase(),
  };
}

export function runSosRollupRefreshBatchLockTests() {
  for (const fn of FUNCTIONS) {
    const { file, header, code } = newestDefinition(fn);
    const lock = `perform pg_advisory_xact_lock(hashtext('${fn}'), hashtext(p_batch_id::text));`;

    assert.ok(
      code.includes(lock),
      `${file}: ${fn} must take a TRANSACTION-scoped advisory lock keyed on its own name and the batch id — `
        + "without it, two rebuilds of one batch each delete the committed rows and each insert a full set, "
        + "and the batch counts twice in every Closing figure read from it",
    );
    assert.equal(
      code.split("pg_advisory_xact_lock(").length - 1,
      1,
      `${file}: ${fn} takes exactly one lock — a second key could deadlock against another rebuild`,
    );
    assert.doesNotMatch(
      code,
      /pg_advisory_lock\(|pg_try_advisory/,
      `${file}: ${fn} must WAIT on a transaction-scoped lock — a session lock outlives the rebuild on a pooled `
        + "connection, and a try-lock skips the second rebuild and leaves its change out of the rollup",
    );

    const lockAt = code.indexOf(lock);
    const firstDelete = code.indexOf("delete from ");
    assert.ok(firstDelete > 0, `${file}: ${fn} rebuilds by delete-then-insert`);
    assert.ok(
      lockAt < firstDelete,
      `${file}: ${fn} must take the lock BEFORE its first delete — a lock taken after it lets two rebuilds `
        + "delete side by side and both insert",
    );

    assert.match(header, /security definer/, `${file}: ${fn} stays SECURITY DEFINER`);
    assert.match(
      header,
      /set statement_timeout to '120s'/,
      `${file}: ${fn} restates its 120s statement_timeout — CREATE OR REPLACE resets a function's SET clauses, `
        + "and a rebuild with no timeout of its own inherits whatever its caller runs under",
    );
  }
}
