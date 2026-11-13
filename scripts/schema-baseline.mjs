#!/usr/bin/env node
// The production schema baseline (REC-041, F-DB-010) — docs/schema-baseline.md.
//
//   node scripts/schema-baseline.mjs --write   dump production, normalise, write supabase/schema/production.sql
//   node scripts/schema-baseline.mjs --check   dump production and compare it with the committed file
//
// --check exits 0 when production matches, or when every difference is explained by a migration on
// this branch that is newer than the baseline (the baseline is behind: refresh it). It exits 1 when
// production holds a change no migration explains, or when the dump itself failed: nothing measured
// is never a pass.
//
// The URL: DATABASE_URL, else PHOENIX_PRODUCTION_DATABASE_URL, else SUPABASE_DB_URL in .env.local.
// It must name production. pg_dump comes from PATH (major PG_DUMP_MAJOR), or from Docker when
// SCHEMA_BASELINE_DOCKER=1 (the nightly runner). The URL is passed by environment, never argv.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PG_DUMP_ARGS,
  PG_DUMP_DOCKER_IMAGE,
  PG_DUMP_MAJOR,
  assertProductionUrl,
  toPooler,
  compareDumps,
  explainDrift,
  normalizeDump,
} from "./lib/schema-baseline.mjs";
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "schema-baseline",
  entry: import.meta.url,
  known: ["--write", "--check"],
});

const BASELINE = "supabase/schema/production.sql";
const LIST_LIMIT = 40;

const args = process.argv.slice(2);
const mode = args[0];
if (args.length !== 1 || !["--write", "--check"].includes(mode)) {
  console.error("usage: node scripts/schema-baseline.mjs --write | --check");
  process.exit(2);
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PHOENIX_PRODUCTION_DATABASE_URL) return process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  if (existsSync(".env.local")) {
    const m = readFileSync(".env.local", "utf8").match(/^SUPABASE_DB_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

function dump(url) {
  const dir = mkdtempSync(path.join(tmpdir(), "schema-baseline-"));
  const out = path.join(dir, "live.sql");
  try {
    let result;
    if (process.env.SCHEMA_BASELINE_DOCKER === "1") {
      result = spawnSync(
        "docker",
        ["run", "--rm", "--network", "host", "-e", "PGURL", "-v", `${dir}:/out`, PG_DUMP_DOCKER_IMAGE,
          "sh", "-c", `pg_dump "$PGURL" ${PG_DUMP_ARGS.join(" ")} -f /out/live.sql`],
        { env: { ...process.env, PGURL: url }, stdio: ["ignore", "inherit", "inherit"], timeout: 240_000 },
      );
    } else {
      const version = execFileSync("pg_dump", ["--version"], { encoding: "utf8" });
      const major = Number(/(\d+)(\.\d+)?/.exec(version)?.[1]);
      if (major !== PG_DUMP_MAJOR) {
        throw new Error(`pg_dump ${major} found; the baseline is written by pg_dump ${PG_DUMP_MAJOR} (${version.trim()})`);
      }
      // -f, never stdout: on Windows a pg_dump piped through stdout writes CRLF into the file.
      result = spawnSync("pg_dump", [url, ...PG_DUMP_ARGS, "-f", out], {
        env: { ...process.env, PGCONNECT_TIMEOUT: "20" },
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 240_000,
      });
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pg_dump exited ${result.status}`);
    return normalizeDump(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

/** Migration files this branch added after the commit that last wrote the baseline. */
function migrationsSinceBaseline() {
  const since = git(["log", "-1", "--format=%H", "--", BASELINE]);
  if (!since) return [];
  const names = git(["log", "--diff-filter=A", "--name-only", "--format=", `${since}..HEAD`, "--", "supabase/migrations"])
    .split("\n")
    .filter((f) => f.endsWith(".sql") && existsSync(f));
  return names.map((f) => readFileSync(f, "utf8"));
}

function list(title, keys) {
  if (keys.length === 0) return;
  console.log(`  ${title} (${keys.length}):`);
  for (const k of keys.slice(0, LIST_LIMIT)) console.log(`    ${k}`);
  if (keys.length > LIST_LIMIT) console.log(`    … and ${keys.length - LIST_LIMIT} more`);
}

try {
  // Direct host → IPv4 session pooler: the runner has no IPv6 (toPooler, scripts/lib/schema-baseline.mjs).
  const url = toPooler(databaseUrl(), process.env.SCHEMA_BASELINE_POOLER_HOST || undefined);
  assertProductionUrl(url);
  const started = Date.now();
  const live = dump(url);
  const seconds = Math.round((Date.now() - started) / 1000);

  if (mode === "--write") {
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, live, "utf8");
    console.log(`[schema-baseline] wrote ${BASELINE} — ${live.length.toLocaleString("en")} bytes, dumped in ${seconds}s`);
    process.exit(0);
  }

  if (!existsSync(BASELINE)) throw new Error(`${BASELINE} is missing — run --write first`);
  const diff = compareDumps(readFileSync(BASELINE, "utf8"), live);
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  console.log(`[schema-baseline] production dumped in ${seconds}s: ${diff.objects.toLocaleString("en")} objects, ${total} differ from ${BASELINE}`);
  if (total === 0) process.exit(0);

  const { explained, unexplained } = explainDrift(diff, migrationsSinceBaseline());
  list("added in production", diff.added);
  list("gone from production", diff.removed);
  list("changed in production", diff.changed);

  if (unexplained.length === 0) {
    console.log(
      `::warning::The schema baseline is behind production by ${total} object(s), every one named by a migration ` +
        "merged since it was written. Refresh it: node scripts/schema-baseline.mjs --write",
    );
    process.exit(0);
  }
  list("NOT named by any migration merged since the baseline", unexplained);
  console.log(
    `::error::${unexplained.length} object(s) differ in production and no migration on main names them — a change ` +
      "made by hand, or a migration applied whose pull request has not merged. Read docs/schema-baseline.md.",
  );
  process.exit(1);
} catch (error) {
  console.log(`::error::schema baseline check could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
