import assert from "node:assert/strict";

import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";

/**
 * The memoized admin client is keyed on the URL and key it was built from, so one test cannot
 * leave the whole suite talking to a stand-in project.
 *
 * WHAT WENT WRONG. `getSupabaseAdmin()` memoizes its client in a module-level variable, and the
 * memo was keyed on NOTHING — while its own comment said it was "keyed on the fixed service-role
 * key". In production that distinction never shows: neither the URL nor the key changes for the
 * life of the process. In the test suite it decides how long CI takes, because all ~2,200 tests
 * share ONE node process.
 *
 * `tests/phoenix-crm-refused-readings-board.test.ts` sets `NEXT_PUBLIC_SUPABASE_URL` to
 * `https://example.supabase.co` with a stand-in service key, builds the client, and restores
 * `process.env` in a `finally` — correctly, and it was not enough. The memo already held a client
 * pointed at that host, and restoring an environment variable cannot rebuild an object that
 * already exists. From that moment every `getSupabaseAdmin()` caller in the process talked to
 * `example.supabase.co`.
 *
 * WHAT IT COST, measured 2026-10-06 on the 4 October regression. Before that test runs, a
 * `canAccess()` call on a machine with no service key throws instantly (microseconds) and
 * `resolvePermissionMatrix()` falls back to the last-known matrix. After it, the same call spends
 * a whole request abort failing against the stand-in host: 14.2s locally, ~7s on the GitHub
 * runner. And `resolvePermissionMatrix()` deliberately does NOT cache a failed load — that is
 * fail-observable by design, so a transient database error can never quietly widen access — so
 * every call pays it again rather than once. Three permission-heavy tests downstream paid it about
 * 36 times between them:
 *
 *   employee master canEdit reach            16ms  ->  70,114ms
 *   a Google Calendar outage is not …         3ms  ->  49,067ms
 *   the interview calendar's CV screen …     45ms  -> 133,233ms
 *
 * 64 milliseconds became 252 seconds, and the whole suite went from ~145s to ~419s — the entire
 * "CI got slow" complaint, in one unkeyed memo.
 *
 * WHY THE FIX IS HERE AND NOT IN THE TEST THAT TRIPPED IT. That test did everything right; the
 * next one to point the environment somewhere would trip the same wire. Keying the memo makes the
 * class of mistake impossible and makes the comment true. Memoization itself is untouched, because
 * it is load-bearing: a single request can call `getSupabaseAdmin()` dozens of times.
 */
export function runSupabaseAdminClientEnvCacheTests() {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // ── 1. memoization still holds for an unchanged environment ──────────────────────────────
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://first.example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-one";
    const first = getSupabaseAdmin();
    assert.equal(
      getSupabaseAdmin(),
      first,
      "the admin client must still be memoized while the URL and key are unchanged — a request calls getSupabaseAdmin() dozens of times",
    );

    // ── 2. a changed URL yields a new client (the headline) ──────────────────────────────────
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://second.example.supabase.co";
    const afterUrlChange = getSupabaseAdmin();
    assert.notEqual(
      afterUrlChange,
      first,
      "a changed NEXT_PUBLIC_SUPABASE_URL must rebuild the admin client — an unkeyed memo is what left the whole suite talking to a stand-in project and cost CI 274 seconds a run",
    );

    // ── 3. a changed key yields a new client too ─────────────────────────────────────────────
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-two";
    const afterKeyChange = getSupabaseAdmin();
    assert.notEqual(
      afterKeyChange,
      afterUrlChange,
      "a changed SUPABASE_SERVICE_ROLE_KEY must rebuild the admin client",
    );

    // ── 4. restoring the environment really restores the client ──────────────────────────────
    // This is the half the `finally` in a test could not deliver before: putting the variables
    // back must put the CLIENT back, or the leak outlives the test that caused it.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://first.example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-one";
    const restored = getSupabaseAdmin();
    assert.notEqual(
      restored,
      afterKeyChange,
      "restoring the environment must hand back a client built from the restored values, not the stand-in one",
    );
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
}
