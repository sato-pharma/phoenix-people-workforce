import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * THE supabase/ FOLDER SAYS WHAT EACH FILE IS (enterprise audit 2026-11-13, F-ENG-016 and F-DB-013, S03).
 *
 * 62 hand-run SQL scripts sat at the root of `supabase/`, beside the migrations folder, where they read
 * like migrations nobody had applied. They moved to `supabase/scripts/`. And production ran an edge
 * function whose source was nowhere in the repository; it now lives in `supabase/functions/`.
 *
 * This keeps both true: no new `.sql` file at the root (only `seed.sql`, which `config.toml` loads), and
 * the edge function's source present, kept out of the app's typecheck and lint because it is Deno code.
 */
export function runSupabaseFolderLayoutTests() {
  const rootSql = readdirSync("supabase").filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(
    rootSql,
    ["seed.sql"],
    "only seed.sql sits at the root of supabase/ — a schema change is a migration in supabase/migrations/, a one-off script goes in supabase/scripts/",
  );
  assert.match(readFileSync("supabase/config.toml", "utf8"), /sql_paths = \["\.\/seed\.sql"\]/, "config.toml loads the seed from the root");

  const scripts = readdirSync("supabase/scripts").filter((f) => f.endsWith(".sql"));
  assert.ok(scripts.length >= 62, `the hand-run scripts are kept as a record (${scripts.length})`);
  assert.ok(existsSync("supabase/scripts/README.md"), "the scripts folder says what it holds");

  assert.ok(existsSync("supabase/functions/summarize-thread/index.ts"), "the one edge function production runs has its source here");
  const tsconfig = readFileSync("tsconfig.json", "utf8");
  assert.match(tsconfig, /"supabase\/functions",/, "the typecheck leaves the Deno edge functions out");
  assert.match(readFileSync("eslint.config.mjs", "utf8"), /"supabase\/functions\/\*\*",/, "lint leaves them out too");
}
