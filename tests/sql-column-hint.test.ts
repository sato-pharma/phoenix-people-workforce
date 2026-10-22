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
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

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

const failure = (query: string, error: string, tool = "mcp__supabase-production__execute_sql") => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: tool,
  tool_input: { project_id: "ozucdzovmcqvepbozvqf", query },
  error,
});

export function runSqlColumnHintTests() {
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
}
