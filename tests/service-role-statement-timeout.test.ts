import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * service_role has a statement_timeout, and no function asks for more time than it will get.
 *
 * Technical audit 2026-10-23, P3-01: the app's server role had NO statement_timeout, so a query the app had
 * already abandoned (15 s) kept running on the database, and a pile of them slows every page — the 22 Oct
 * stall was four database restarts under load. The owner chose 5 minutes the same morning.
 *
 * A function's own `SET statement_timeout` CANNOT extend a lower limit set by its caller — proved on staging
 * that day (a function declaring 10s was cancelled at its caller's 1s). So the role limit must be at or above
 * every limit a function declares, or that function is cut short with a number in its header that promises
 * otherwise. This file checks both halves on every migration in the repository.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

function seconds(value: string): number {
  const m = /^(\d+)\s*(ms|s|min|h)?$/i.exec(value.trim());
  assert.ok(m, `unreadable statement_timeout value '${value}'`);
  const n = Number(m![1]);
  switch ((m![2] ?? "ms").toLowerCase()) {
    case "ms": return n / 1000;
    case "s": return n;
    case "min": return n * 60;
    default: return n * 3600;
  }
}

export function runServiceRoleStatementTimeoutTests() {
  let roleLimit: { file: string; value: string } | null = null;
  const declared: Array<{ file: string; value: string }> = [];
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    for (const m of sql.matchAll(/alter\s+role\s+service_role\s+(?:in\s+database\s+\w+\s+)?set\s+statement_timeout\s*(?:=|to)\s*'([^']+)'/gi)) {
      roleLimit = { file: name, value: m[1] };
    }
    for (const m of sql.matchAll(/\bset\s+statement_timeout\s+to\s+'([^']+)'/gi)) declared.push({ file: name, value: m[1] });
  }

  assert.ok(roleLimit, "🔴 no migration gives service_role a statement_timeout — an abandoned query would run unbounded");
  const limit = seconds(roleLimit!.value);
  assert.equal(limit, 300, `${roleLimit!.file}: service_role's limit is the owner's 5 minutes`);
  assert.ok(declared.length > 0, "the scan found the function-level limits (it reads the SET clause form)");
  const over = declared.filter((d) => seconds(d.value) > limit);
  assert.deepEqual(
    over,
    [],
    `🔴 a function declares more time than service_role's ${limit}s allows, and a function's SET cannot raise its `
      + "caller's limit — batch the job or raise the role limit with the owner, never just a bigger number",
  );
}
