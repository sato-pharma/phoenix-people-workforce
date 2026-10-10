import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseAuthSessionBundle } from "../src/lib/auth/server.ts";
import { APP_SESSION_COLUMNS } from "../src/lib/auth/app-sessions.ts";

/**
 * The auth trio resolves in ONE round trip, and still applies every rule it did in three.
 *
 * Measured on production 2026-10-10 over a 118-minute window. PostgREST runs one
 * `set_config(search_path…)` per HTTP request, inside the query's own transaction, so that
 * statement's call count IS the number of round trips to the database:
 *
 *   set_config(search_path…)   176,110 calls   <- round trips
 *   employees      (lifecycle)  21,366 calls   mean 0.06 ms
 *   app_auth_users (account)    21,333 calls   mean 0.06 ms
 *   app_sessions   (session)    21,333 calls   mean 0.08 ms
 *
 * Those three identical counts are the trio resolveSessionState() fires for every authenticated
 * request: 64,032 of 176,110 round trips — 36% of all PostgREST traffic — to do 0.2 ms of SQL.
 * Promise.all had already made them concurrent, which fixed the latency (1 RTT instead of 3) and
 * left the COUNT at three separate cross-border HTTPS calls.
 *
 * What this file defends is the part that could go wrong: the RPC returns ROWS, and every
 * decision stays in TypeScript. A rule that migrates into SQL, a dropped column, or an EXECUTE
 * grant wider than service_role are each a real failure here, not a style preference.
 */
export async function runAuthSessionBundleTests() {
  const migrationSource = readFileSync(
    new URL("../supabase/migrations/20261010140000_phx_auth_session_bundle.sql", import.meta.url),
    "utf8",
  );
  const serverSource = readFileSync(new URL("../src/lib/auth/server.ts", import.meta.url), "utf8");
  const appSessionsSource = readFileSync(new URL("../src/lib/auth/app-sessions.ts", import.meta.url), "utf8");

  // READ THE SQL, NOT THE PROSE. Every assertion below runs against the migration with its line
  // comments stripped, because this migration documents itself heavily — it names the columns it
  // selects, and explains why it is not security definer, in comments. Matching the raw file made
  // two checks unfalsifiable: removing `is_test_persona` from the SELECT still passed, because the
  // comment above the SELECT also names it. Caught 2026-10-10 by deleting the column and watching
  // this file stay green while tests/test-accounts.test.ts went red.
  // (No string literal in this migration contains `--`, so stripping line comments is safe here.)
  const executableSql = migrationSource
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  // ---------------------------------------------------------------- the payload reader

  const full = parseAuthSessionBundle({
    app_session: { id: "s1", login_id: "omar", role: "Super Admin" },
    auth_user: { login_id: "omar", hr_id: "B-10", role: "Super Admin", is_active: true },
    employee: { employment_status: "active", last_working_date: null },
    employee_lookup_failed: false,
    employee_key: "B-10",
  });
  assert.equal(full.appSession?.login_id, "omar", "the session row must survive the read");
  assert.equal(full.authUser?.hr_id, "B-10", "the account row must survive the read");
  assert.equal(full.employee?.employment_status, "active", "the employee row must survive the read");
  assert.equal(full.employeeLookupFailed, false);
  assert.equal(full.employeeKey, "B-10", "the key the RPC used must be reported back");

  // "No row" and "lookup failed" are different answers and must not collapse into each other:
  // the first ALLOWS (unlinked/system account), the second DENIES. Collapsing them in either
  // direction is a real defect — one locks out valid accounts, the other is a fail-open.
  const noEmployee = parseAuthSessionBundle({
    app_session: { id: "s1" },
    auth_user: { login_id: "svc", hr_id: null },
    employee: null,
    employee_lookup_failed: false,
    employee_key: null,
  });
  assert.equal(noEmployee.employee, null);
  assert.equal(noEmployee.employeeLookupFailed, false, "a missing employee row is not a failed lookup");
  assert.equal(noEmployee.employeeKey, null, "no hr_id to look up must report no key");

  const failedLookup = parseAuthSessionBundle({
    app_session: { id: "s1" },
    auth_user: { login_id: "omar", hr_id: "B-10" },
    employee: null,
    employee_lookup_failed: true,
    employee_key: "B-10",
  });
  assert.equal(failedLookup.employeeLookupFailed, true, "a failed lookup must stay a failed lookup");

  // A malformed or absent payload must read as "no rows", never as "allowed": a null app_session
  // is a rejected session two checks later, so the fail-closed direction is preserved without
  // this reader knowing any rule.
  for (const junk of [null, undefined, "", 0, [], { app_session: "nonsense" }]) {
    const parsed = parseAuthSessionBundle(junk);
    assert.equal(parsed.appSession, null, `malformed payload ${JSON.stringify(junk)} must yield no session`);
    assert.equal(parsed.authUser, null, `malformed payload ${JSON.stringify(junk)} must yield no account`);
    assert.equal(parsed.employeeLookupFailed, false);
  }

  // A blank key is no key — otherwise the gate-key comparison below would match "" against a
  // real hr_id and reuse a gate that was never evaluated for that employee.
  assert.equal(parseAuthSessionBundle({ employee_key: "   " }).employeeKey, null, "a blank key must be null");

  // ---------------------------------------------------------------- columns match the SQL

  // Every app_sessions column the rules read must be selected by the RPC. The rules run on the
  // bundled row, so a column present in one list and missing from the other is not a type error
  // — it is a rule silently reading undefined.
  for (const column of APP_SESSION_COLUMNS.split(",").map((c) => c.trim())) {
    assert.match(
      executableSql,
      new RegExp(`\\b${column}\\b`),
      `phx_auth_session_bundle must select app_sessions.${column} — APP_SESSION_COLUMNS reads it`,
    );
  }

  // The account columns, including the two that carry his test-persona feature. Ten active
  // personas mirror real employees by design, so dropping either breaks all ten.
  for (const column of [
    "login_id",
    "hr_id",
    "role",
    "is_active",
    "session_version",
    "is_test_persona",
    "test_persona_of_hr_id",
  ]) {
    assert.match(
      executableSql,
      new RegExp(`\\b${column}\\b`),
      `phx_auth_session_bundle must select app_auth_users.${column}`,
    );
  }

  for (const column of ["employment_status", "last_working_date"]) {
    assert.match(executableSql, new RegExp(`\\b${column}\\b`), `the lifecycle gate needs employees.${column}`);
  }

  // ---------------------------------------------------------------- rows, not decisions

  // The whole safety argument is that policy did not move into SQL. These are the rule words
  // from evaluateAppSessionRow and the lifecycle gate; none may appear in the migration.
  for (const policyWord of [
    "idle_expired",
    "absolute_expired",
    "login_id_mismatch",
    "role_changed",
    "session_version_mismatch",
    "missing_app_session",
    "resigned",
    "terminated",
  ]) {
    assert.ok(
      !executableSql.includes(policyWord),
      `phx_auth_session_bundle must return rows, not decisions — found policy "${policyWord}" in the SQL`,
    );
  }

  // ...and the rules still live in exactly one place, applied to the bundled row.
  assert.match(
    appSessionsSource,
    /export function evaluateAppSessionRow\(/,
    "the app_sessions rules must be callable on a row that was already read",
  );
  assert.match(
    serverSource,
    /evaluateAppSessionRow\(bundle\.appSession, payload\)/,
    "resolveSessionState must put the bundled session row through the shared rules",
  );
  assert.equal(
    (serverSource.match(/reason: "idle_expired"/g) ?? []).length,
    0,
    "resolveSessionState must not re-implement a session expiry rule of its own",
  );

  // ---------------------------------------------------------------- fail-closed is preserved

  // An unreadable employees row must still DENY with employee_lookup_failed rather than throw.
  // Raising inside the RPC would turn one bad row into a thrown error for the whole bundle —
  // the amplification that signed everyone out on 2026-10-10.
  assert.match(
    executableSql,
    /exception\s+when\s+others\s+then/,
    "the employees lookup must catch its own failure so the gate can fail closed, not throw",
  );
  assert.match(
    serverSource,
    /employee_lookup_failed/,
    "resolveSessionState must still deny with employee_lookup_failed on an unreadable row",
  );

  // The gate must be reused only when the key the RPC actually used matches the effective HR id.
  // Comparing against payload.hrId instead would reuse a gate evaluated for a different employee
  // — which for a test persona is a different person entirely.
  assert.match(
    serverSource,
    /String\(effectiveHrId \?\? ""\)\.trim\(\) === String\(bundle\.employeeKey \?\? ""\)\.trim\(\)/,
    "the lifecycle gate may only be reused when it was keyed on the effective HR id",
  );
  assert.match(
    serverSource,
    /resolveEmployeeLifecycleGate\(supabase, effectiveHrId\)/,
    "a key mismatch must still re-read the gate on the effective HR id",
  );

  // ---------------------------------------------------------------- the security boundary

  // The function takes a login_id and returns that account's session data with no authorization
  // check of its own, because its only caller is the service-role admin client. A browser key
  // must never reach it. These grants are the entire boundary — it is not security definer.
  assert.match(
    executableSql,
    /grant execute on function public\.phx_auth_session_bundle\(uuid, text\) to service_role;/,
    "the bundle RPC must be executable by service_role",
  );
  for (const role of ["public", "anon", "authenticated"]) {
    assert.match(
      executableSql,
      new RegExp(`revoke all on function public\\.phx_auth_session_bundle\\(uuid, text\\) from ${role};`),
      `the bundle RPC must be revoked from ${role} — it returns session data for any login_id`,
    );
  }
  assert.ok(
    !/security\s+definer/i.test(executableSql),
    "the bundle RPC needs no elevation (service_role already bypasses RLS) and must not take any",
  );
  assert.match(executableSql, /\bstable\b/i, "the bundle RPC is a read and must be declared stable");

  // ---------------------------------------------------------------- the two measurements

  // Round trips are counted and timed, because nothing measured them before: the database's own
  // view said 5.0 ms mean and 49 ms of execution per request against a 647 ms median page.
  const supabaseServerSource = readFileSync(new URL("../src/lib/supabase/server.ts", import.meta.url), "utf8");
  assert.match(
    supabaseServerSource,
    /recordTiming\("supabase\.fetch", Date\.now\(\) - startedAt\)/,
    "every Supabase round trip must be timed — its count is the round-trip counter",
  );
  for (const bucket of ["supabase.fetch.timeout", "supabase.fetch.failed"]) {
    assert.ok(supabaseServerSource.includes(bucket), `${bucket} must be recorded separately from a slow answer`);
  }

  // The keep-alive pin must stay unbounded. Undici queues once `connections` is reached, and a
  // stalled request holds its socket for the whole 15s timeout — so bounding the pool is how a
  // few stalls (p99 14,875 ms) would become a queue for everyone.
  const keepAliveSource = readFileSync(new URL("../src/lib/observability/keep-alive.ts", import.meta.url), "utf8");
  assert.ok(
    !/\bconnections:\s*\d/.test(keepAliveSource),
    "the keep-alive agent must NOT bound connections — a bounded pool turns a stall into a queue",
  );
  assert.match(keepAliveSource, /keepAliveTimeout:/, "the keep-alive pin must set the idle timeout");
  assert.match(
    readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8"),
    /pinKeepAliveDispatcher/,
    "the keep-alive dispatcher must be pinned at boot, before anything makes an outbound call",
  );
  // ------------------------------------------------- the gate key has no token fallback

  // The RPC keys the employees lookup on the FRESH ACCOUNT ROW's hr_id and nothing else,
  // because that is the same expression resolveSessionState() uses for effectiveHrId. An
  // earlier revision also took the token's hr_id and fell back to it, which made the two keys
  // disagree on 203 of 823 real production sessions (9 admin accounts whose
  // app_auth_users.hr_id is NULL) and forced a second gate evaluation for a quarter of all
  // traffic. The decision came out the same either way — which is exactly why only a test
  // keeps the fallback from coming back.
  assert.ok(
    !executableSql.includes("p_hr_id"),
    "the bundle RPC must not take the token's hr_id — the gate keys on the account row alone",
  );
  assert.match(
    executableSql,
    /v_employee_key := nullif\(btrim\(coalesce\(v_user->>'hr_id', ''\)\), ''\);/,
    "the employees lookup must be keyed on the account row's hr_id, with no fallback",
  );
  assert.ok(
    !serverSource.includes("p_hr_id"),
    "resolveSessionState must not pass the token's hr_id to the bundle RPC",
  );
  // The three-argument form must be DROPPED, not merely replaced: PostgreSQL overloads on the
  // argument list, so `create or replace` of the two-argument form leaves the old one in place,
  // still executable and still keyed on the token.
  assert.match(
    executableSql,
    /drop function if exists public\.phx_auth_session_bundle\(uuid, text, text\);/,
    "the superseded three-argument form must be dropped, not left beside the new one",
  );

}
