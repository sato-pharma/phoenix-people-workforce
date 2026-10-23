// A GUESSED COLUMN NAME — .claude/hooks/sql-column-hint.mjs, 2026-10-22.
//
// An audit session asked phoenix_crm_places for `pin_captured_at` (the pin's time is `captured_at`)
// and got a bare 42703. The hook answers that error with the table's real columns, nearest first, so
// the next query is read, not guessed again. This file pins three things:
//
//   1. The hook, driven as a subprocess with a fixed column list (PHX_SQL_HINT_COLUMNS_JSON) — never
//      the network — on the real failing payload and its variants.
//   2. Its silence: another tool, another error, a query that succeeded.
//   3. Its wiring: PostToolUse AND PostToolUseFailure, on every execute_sql server.

import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { settingsHookGroups } from "./support/hook-wiring.ts";

const hookPath = resolve(".claude/hooks/sql-column-hint.mjs");

const PLACES = [
  "id", "customer_id", "seat_id", "lat", "lon", "accuracy_meters", "captured_at", "status", "created_at",
  "pin_lat", "pin_lon", "pin_accuracy_meters", "photo_lat", "photo_lon", "photo_captured_at", "moved_at",
];
const CUSTOMERS = ["id", "name", "pharmacy_pin_lat", "pharmacy_pin_captured_at"];
const SCHEMA = JSON.stringify({ phoenix_crm_places: PLACES, phoenix_crm_customers: CUSTOMERS });

const REAL_QUERY =
  "select p.id, p.photo_captured_at at time zone 'Africa/Cairo' as photo_at_cairo,\n" +
  "       p.pin_captured_at at time zone 'Africa/Cairo' as pin_at_cairo\n" +
  "from phoenix_crm_places p where p.id = '8febf3c1-3300-44a3-ad37-8b6df8d2e19e';";
const REAL_ERROR =
  '{"error":{"name":"HttpException","message":"Failed to run sql query: ERROR:  42703: column p.pin_captured_at does not exist\\nLINE 3: ..."}}';

function runHook(payload: Record<string, unknown>, env: Record<string, string> = { PHX_SQL_HINT_COLUMNS_JSON: SCHEMA }): string {
  const raw = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
    env: { ...process.env, PHX_SQL_HINT_COLUMNS_JSON: "", PHX_SQL_HINT_OFFLINE: "1", ...env },
  });
  if (!raw.trim()) return "";
  return String(JSON.parse(raw).hookSpecificOutput?.additionalContext ?? "");
}

// Section 4 needs the hook run WITHOUT blocking this process: its schema source is a loopback
// server in this very process, and execFileSync holds the event loop, so a synchronous run can
// never be answered — the hook's fetch would simply time out and the test would measure nothing.
function runHookAsync(payload: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, PHX_SQL_HINT_COLUMNS_JSON: "", PHX_SQL_HINT_OFFLINE: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20000,
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", fail);
    child.on("close", () => {
      if (!out.trim()) return done("");
      try {
        done(String(JSON.parse(out).hookSpecificOutput?.additionalContext ?? ""));
      } catch (err) {
        fail(err);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const failure = (query: string, error: string, tool = "mcp__supabase-production__execute_sql") => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: tool,
  tool_input: { project_id: "ozucdzovmcqvepbozvqf", query },
  error,
});

export async function runSqlColumnHintTests() {
  // 1. The real payload: the alias resolves to phoenix_crm_places and `captured_at` leads.
  const real = runHook(failure(REAL_QUERY, REAL_ERROR));
  assert.match(real, /`p\.pin_captured_at` does not exist/, "the hint must name the guessed column");
  assert.match(real, /phoenix_crm_places's real columns/, "the alias p must resolve to phoenix_crm_places");
  assert.match(real, /nearest to `pin_captured_at`: `captured_at`/, "the true column must be named first");
  assert.ok(!real.includes("pharmacy_pin_captured_at"), "another table's column must not be offered for p");

  // The PostToolUse shape: the error arrives as text blocks in tool_response.
  const asResponse = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__execute_sql",
    tool_input: { project_id: "ozucdzovmcqvepbozvqf", query: REAL_QUERY },
    tool_response: [{ type: "text", text: REAL_ERROR }],
  });
  assert.match(asResponse, /nearest to `pin_captured_at`: `captured_at`/, "a tool_response error must be read too");

  // An unqualified column lists every table in the query.
  const bare = runHook(
    failure(
      "select pin_time from phoenix_crm_places pl join phoenix_crm_customers c on c.id = pl.customer_id",
      'ERROR:  42703: column "pin_time" does not exist',
    ),
  );
  assert.match(bare, /phoenix_crm_places's real columns/, "an unqualified column must list the first table");
  assert.match(bare, /phoenix_crm_customers's real columns/, "an unqualified column must list the joined table");

  // An INSERT/UPDATE names the relation itself.
  const insert = runHook(
    failure("update phoenix_crm_customers set pin_at = now()", 'ERROR:  42703: column "pin_at" of relation "phoenix_crm_customers" does not exist'),
  );
  assert.match(insert, /phoenix_crm_customers's real columns — nearest to `pin_at`: `pharmacy_pin_captured_at`/, "the named relation must be listed");

  // No schema (staging, no key, offline): the exact information_schema read is named instead.
  const offline = runHook(failure(REAL_QUERY, REAL_ERROR), {});
  assert.match(offline, /information_schema\.columns/, "with no schema the hint must name the query that reads one");
  assert.match(offline, /'phoenix_crm_places'/, "the fallback query must name the resolved table");

  // A CTE alias is not a table.
  const cte = runHook(
    failure("with ev as (select id from phoenix_crm_places) select ev.when_at from ev", "ERROR:  42703: column ev.when_at does not exist"),
  );
  assert.match(cte, /`ev` is a CTE/, "a CTE qualifier must be called a CTE");
  assert.ok(!cte.includes("real columns"), "a CTE must not be listed as a table");

  // 2. Silence.
  assert.equal(runHook({ ...failure(REAL_QUERY, REAL_ERROR), tool_name: "Bash" }), "", "only execute_sql calls are read");
  assert.equal(runHook(failure(REAL_QUERY, 'ERROR:  42P01: relation "phoenix_crm_place" does not exist')), "", "another error is not a column guess");
  assert.equal(
    runHook({ hook_event_name: "PostToolUse", tool_name: "mcp__supabase-production__execute_sql", tool_input: { query: REAL_QUERY }, tool_response: "[]" }),
    "",
    "a query that succeeded is silent",
  );
  assert.equal(runHook({}), "", "an empty payload fails open");

  // 3. The wiring: both events, every execute_sql server.
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const groups = settingsHookGroups(event).filter((g) => (g.hooks ?? []).some((h) => (h.command ?? "").includes("sql-column-hint.mjs")));
    assert.ok(groups.length > 0, `sql-column-hint.mjs must be registered for ${event} in .claude/settings.json`);
    for (const tool of [
      "mcp__supabase-production__execute_sql",
      "mcp__supabase-staging__execute_sql",
      "mcp__b345e47e-3198-4b48-97cc-07b47bbb3087__execute_sql",
    ]) {
      assert.ok(
        groups.some((g) => new RegExp(g.matcher ?? "").test(tool)),
        `the ${event} matcher must match ${tool}`,
      );
    }
  }

  // 4. The schema cache. PostgREST rebuilds its whole OpenAPI spec per call — 567 tables and views,
  // 8,131 columns, 4,773 KB decoded, measured on 2026-10-23 at anywhere from 1,072 ms to 8,671 ms —
  // and that was paid on EVERY missing-column failure (36 that day, p90 6,378 ms, which was the old
  // 6 s abort firing and returning nothing). The map is now cached per project for 10 minutes.
  //
  // The schema source here is a loopback server, never Supabase: it counts the requests the hook
  // makes, so "the cache saved the call" is asserted rather than assumed, and it serves one column
  // no cache in this test holds (`served_only_column`) so the ANSWER's source is provable too.
  const cacheDir = mkdtempSync(join(tmpdir(), "phx-sql-hint-cache-test-"));
  const CACHE_PROJECT = "notarealprojectref";
  const SERVED = ["id", "customer_id", "captured_at", "served_only_column"];
  let served = 0;
  const server = createServer((_req, res) => {
    served += 1;
    res.writeHead(200, { "content-type": "application/openapi+json" });
    res.end(JSON.stringify({ definitions: { phoenix_crm_places: { properties: Object.fromEntries(SERVED.map((c) => [c, {}])) } } }));
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(null)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0, "the loopback schema server must be listening");

  const cachePath = join(cacheDir, CACHE_PROJECT + ".json");
  const seedCache = (ageMs: number, tables: Record<string, string[]>) =>
    writeFileSync(cachePath, JSON.stringify({ readAt: Date.now() - ageMs, tables }));
  const cacheEnv = { PHX_SQL_HINT_COLUMNS_JSON: "", PHX_SQL_HINT_OFFLINE: "", PHX_SQL_HINT_CACHE_DIR: cacheDir };
  // Only this env makes a fetch possible at all: the hook requires the project id to appear in the
  // URL, so every OTHER case in this file cannot reach a real project even by mistake.
  const sourceEnv = {
    ...cacheEnv,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}/${CACHE_PROJECT}`,
    SUPABASE_SERVICE_ROLE_KEY: "loopback-test-key",
  };
  const runCached = (env: Record<string, string>) =>
    runHookAsync(
      { hook_event_name: "PostToolUseFailure", tool_name: "mcp__supabase-production__execute_sql", tool_input: { project_id: CACHE_PROJECT, query: REAL_QUERY }, error: REAL_ERROR },
      env,
    );

  try {
    // A cache written seconds ago answers the hint and asks the source for NOTHING — the whole point.
    seedCache(5_000, { phoenix_crm_places: PLACES });
    served = 0;
    const fresh = await runCached(sourceEnv);
    assert.equal(served, 0, "a warm cache must make no schema request at all");
    assert.match(fresh, /nearest to `pin_captured_at`: `captured_at`/, "a warm cache must still answer the hint");
    assert.ok(fresh.includes("moved_at"), "the answer must come from the cache");
    assert.ok(!fresh.includes("served_only_column"), "a warm cache must not be answered from the source");
    assert.ok(!/was read \d+ min ago/.test(fresh), "a cache seconds old must not carry an age caveat");

    // Minutes old it still answers, but says how old: this repo applies migrations constantly.
    seedCache(5 * 60_000, { phoenix_crm_places: PLACES });
    served = 0;
    const aging = await runCached(sourceEnv);
    assert.equal(served, 0, "a cache inside its TTL must still make no request");
    assert.match(aging, /was read 5 min ago — a column added since will not be in it/, "a cache minutes old must state its age");

    // Past the 10-minute TTL the schema is read again, and the fresh read replaces the cache.
    seedCache(11 * 60_000, { phoenix_crm_places: PLACES });
    served = 0;
    const expired = await runCached(sourceEnv);
    assert.equal(served, 1, "a cache past its TTL must be re-read, exactly once");
    assert.ok(expired.includes("served_only_column"), "an expired cache must be answered from the source");
    assert.ok(Date.now() - Number(JSON.parse(readFileSync(cachePath, "utf8")).readAt) < 60_000, "a fresh read must be written back to the cache");

    // A table the query names but the cache has never seen is a table created since the cache was
    // written: re-read rather than report it unknown. Nothing else in the output distinguishes this,
    // so the request count is what pins it.
    seedCache(5_000, { phoenix_crm_customers: CUSTOMERS });
    served = 0;
    const unseen = await runCached(sourceEnv);
    assert.equal(served, 1, "a cache missing the queried table must be re-read");
    assert.match(unseen, /phoenix_crm_places's real columns/, "the re-read must answer the hint");

    // With no reachable source and nothing usable cached, it names the information_schema read —
    // asserted specifically, because that fallback sentence itself says "Read the real columns…".
    seedCache(11 * 60_000, { phoenix_crm_places: PLACES });
    served = 0;
    const nosource = await runCached(cacheEnv);
    assert.equal(served, 0, "the no-source case must not reach the loopback server either");
    assert.match(nosource, /information_schema\.columns/, "with no schema the hint must name the query that reads one");
    assert.ok(!nosource.includes("phoenix_crm_places's real columns"), "an expired cache must not list columns");
  } finally {
    server.close();
  }
}
