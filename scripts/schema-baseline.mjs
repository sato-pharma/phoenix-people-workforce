#!/usr/bin/env node
// The production schema baseline (REC-041, F-DB-010) — docs/schema-baseline.md.
//
//   node scripts/schema-baseline.mjs --write   dump production, normalise, write supabase/schema/production.sql
//   node scripts/schema-baseline.mjs --check   dump production and compare it with the committed file
//   node scripts/schema-baseline.mjs --restore-check
//                                              restore the committed file into a throwaway database,
//                                              dump that, and compare it with the file (weekly job)
//
// --check exits 0 when production matches, or when every difference is explained by a migration on
// this branch that is newer than the baseline (the baseline is behind: refresh it). It exits 1 when
// production holds a change no migration explains, or when the dump itself failed: nothing measured
// is never a pass.
//
// --restore-check (docs/security/schema-restore-check.md) never reads production: it needs
// SCHEMA_RESTORE_URL, a fresh supabase/postgres container on this machine (the password in PGPASSWORD).
// It exits 0 only when the file restored with no error and the restored database dumps to the same
// objects; any restore error, any difference, or anything not measured is 1.
//
// The URL: DATABASE_URL, else PHOENIX_PRODUCTION_DATABASE_URL, else SUPABASE_DB_URL in .env.local.
// It must name production. pg_dump comes from PATH (major PG_DUMP_MAJOR), or from Docker when
// SCHEMA_BASELINE_DOCKER=1 (the nightly runner). The URL is passed by environment, never argv.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PG_DUMP_ARGS,
  PG_DUMP_DOCKER_IMAGE,
  PG_DUMP_MAJOR,
  RESTORE_PG_MAJOR,
  assertProductionUrl,
  assertScratchUrl,
  toPooler,
  compareDumps,
  explainDrift,
  flattenBooleanChains,
  freshnessQuery,
  normalizeDump,
  objectLineDiff,
  restorableBaseline,
  restorePrelude,
  rolesNamedIn,
  splitObjects,
} from "./lib/schema-baseline.mjs";
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "schema-baseline",
  entry: import.meta.url,
  known: ["--write", "--check", "--restore-check"],
});

const BASELINE = "supabase/schema/production.sql";
const LIST_LIMIT = 40;

const args = process.argv.slice(2);
const mode = args[0];
if (args.length !== 1 || !["--write", "--check", "--restore-check"].includes(mode)) {
  console.error("usage: node scripts/schema-baseline.mjs --write | --check | --restore-check");
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

/**
 * Runs pg_dump or psql at the pinned major against `url`, inside `dir` (mounted at /work under Docker), so a
 * relative file name means the same file either way. From PATH locally; from PG_DUMP_DOCKER_IMAGE when
 * SCHEMA_BASELINE_DOCKER=1. The URL and any PGPASSWORD travel by environment, never argv.
 */
function pgTool(tool, url, toolArgs, { dir, capture = false, timeout = 240_000 }) {
  const env = { ...process.env, PGURL: url, PGCONNECT_TIMEOUT: "20" };
  const options = {
    env,
    stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    timeout,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  };
  let result;
  if (process.env.SCHEMA_BASELINE_DOCKER === "1") {
    result = spawnSync(
      "docker",
      ["run", "--rm", "--network", "host", "-e", "PGURL", "-e", "PGPASSWORD", "-e", "PGCONNECT_TIMEOUT",
        "-v", `${dir}:/work`, "-w", "/work", PG_DUMP_DOCKER_IMAGE,
        "sh", "-c", `${tool} "$PGURL" "$@"`, tool, ...toolArgs],
      options,
    );
  } else {
    const version = execFileSync(tool, ["--version"], { encoding: "utf8" });
    const major = Number(/(\d+)(\.\d+)?/.exec(version)?.[1]);
    if (major !== PG_DUMP_MAJOR) {
      throw new Error(`${tool} ${major} found; the baseline is written by pg_dump ${PG_DUMP_MAJOR} (${version.trim()})`);
    }
    result = spawnSync(tool, [url, ...toolArgs], { ...options, cwd: dir });
  }
  if (result.error) throw result.error;
  return result;
}

function dump(url) {
  const dir = mkdtempSync(path.join(tmpdir(), "schema-baseline-"));
  try {
    // -f, never stdout: on Windows a pg_dump piped through stdout writes CRLF into the file.
    const result = pgTool("pg_dump", url, [...PG_DUMP_ARGS, "-f", "live.sql"], { dir });
    if (result.status !== 0) throw new Error(`pg_dump exited ${result.status}`);
    return normalizeDump(readFileSync(path.join(dir, "live.sql"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(argv) {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

/**
 * Migration files added since LOOKBACK_HOURS before the commit that last wrote the baseline.
 *
 * Not strictly "after it": migrations are applied to production BEFORE their PR merges, so one merged
 * shortly before the baseline commit can still have been applied after the dump it holds. Measured
 * 2026-11-13: #334 merged after this branch was cut and its column change read as a hand change, and
 * #337's two tables were applied 20 minutes after the dump. The lookback only ever turns red into a
 * named ::warning::, never hides a difference: every one is still listed.
 */
const LOOKBACK_HOURS = 24;
function migrationsSinceBaseline() {
  const written = git(["log", "-1", "--format=%ct", "--", BASELINE]);
  if (!written) return [];
  const since = new Date((Number(written) - LOOKBACK_HOURS * 3600) * 1000).toISOString();
  const names = git(["log", "--diff-filter=A", "--name-only", "--format=", `--since=${since}`, "HEAD", "--", "supabase/migrations"])
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

/** A line for the run's summary page on GitHub, when there is one. */
function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/** The one line the weekly job's Telegram alert quotes (a step output, read by its notify job). */
function headline(text) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `headline=${text.replace(/\s+/g, " ")}\n`);
}

/**
 * --restore-check: restore the committed file into the throwaway database at SCHEMA_RESTORE_URL, dump that
 * with the same pg_dump and normalising, and compare the two with compareDumps. A file that rebuilds
 * production restores with no error and dumps back to itself, object for object.
 */
function restoreCheck() {
  const url = process.env.SCHEMA_RESTORE_URL ?? "";
  assertScratchUrl(url);
  if (!existsSync(BASELINE)) throw new Error(`${BASELINE} is missing`);
  const baseline = readFileSync(BASELINE, "utf8");
  const objects = splitObjects(baseline).size;
  const dir = mkdtempSync(path.join(tmpdir(), "schema-restore-"));
  let restoreErrors;
  let restoreSeconds;
  try {
    const psql = (psqlArgs, timeout = 60_000) =>
      pgTool("psql", url, ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...psqlArgs], { dir, capture: true, timeout });
    const scalar = (sql) => {
      const r = psql(["-At", "-c", sql]);
      if (r.status !== 0) throw new Error(`psql exited ${r.status}: ${r.stderr.trim()}`);
      return r.stdout.trim();
    };

    const serverMajor = Math.floor(Number(scalar("show server_version_num")) / 10000);
    if (serverMajor !== RESTORE_PG_MAJOR) {
      throw new Error(`the scratch database runs Postgres ${serverMajor}; production runs ${RESTORE_PG_MAJOR}`);
    }
    const leftovers = Number(scalar(freshnessQuery()));
    if (leftovers !== 0) {
      throw new Error(`the scratch database is not fresh: ${leftovers} of the baseline's schemas or tables already exist`);
    }

    const existing = new Set(scalar("select rolname from pg_roles").split("\n"));
    const missing = rolesNamedIn(baseline).filter((role) => !existing.has(role));
    console.log(`[schema-restore] Postgres ${serverMajor}; creating ${missing.length} role(s) the file names: ${missing.join(", ") || "none"}`);
    writeFileSync(path.join(dir, "prelude.sql"), restorePrelude(missing), "utf8");
    const prelude = psql(["-f", "prelude.sql"]);
    if (prelude.status !== 0) throw new Error(`the prelude failed (psql ${prelude.status}): ${prelude.stderr.trim()}`);

    // Every error, not the first: one run names everything a rebuild would trip on.
    writeFileSync(path.join(dir, "baseline.sql"), restorableBaseline(baseline), "utf8");
    const started = Date.now();
    const restore = pgTool("psql", url, ["-X", "-q", "-v", "ON_ERROR_STOP=0", "-f", "baseline.sql"], {
      dir,
      capture: true,
      timeout: 600_000,
    });
    restoreSeconds = Math.round((Date.now() - started) / 1000);
    if (restore.status !== 0) throw new Error(`psql could not run the file (exit ${restore.status}): ${restore.stderr.trim().slice(0, 2000)}`);
    restoreErrors = restore.stderr.split("\n").filter((line) => /\b(ERROR|FATAL):/.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const started = Date.now();
  const restored = dump(url);
  const dumpSeconds = Math.round((Date.now() - started) / 1000);
  const diff = compareDumps(baseline, restored);
  // An object whose only change is Postgres folding a nested AND/OR chain on the way back in holds the same
  // expression (flattenBooleanChains, scripts/lib/schema-baseline.mjs). It is listed, never counted.
  const fileObjects = splitObjects(baseline);
  const restoredObjects = splitObjects(restored);
  const sameExpression = (key) =>
    flattenBooleanChains(fileObjects.get(key) ?? "") === flattenBooleanChains(restoredObjects.get(key) ?? "");
  const refolded = diff.changed.filter(sameExpression);
  const changed = diff.changed.filter((key) => !sameExpression(key));
  const total = diff.added.length + diff.removed.length + changed.length;
  console.log(
    `[schema-restore] ${BASELINE}: ${objects.toLocaleString("en")} objects restored in ${restoreSeconds}s with ` +
      `${restoreErrors.length} error(s); the restored database dumped in ${dumpSeconds}s to ` +
      `${diff.objects.toLocaleString("en")} objects, ${total} differ from the file` +
      (refolded.length > 0 ? ` (and ${refolded.length} hold the same expression with Postgres's own brackets)` : ""),
  );
  list("errors while restoring", restoreErrors);
  list("in the restored database, not in the file", diff.added);
  list("in the file, missing from the restored database", diff.removed);
  list("restored differently from the file", changed);
  list("the same expression, re-bracketed by Postgres's parser (not a difference)", refolded);
  // What changed in each, so the run log names the difference itself (- the file, + the restored database).
  for (const key of [...changed, ...refolded].slice(0, LIST_LIMIT)) {
    const lines = objectLineDiff(fileObjects.get(key) ?? "", restoredObjects.get(key) ?? "");
    console.log(`  ${key}${refolded.includes(key) ? " (same expression)" : ""}:`);
    for (const line of lines.slice(0, 12)) console.log(`      ${line}`);
    if (lines.length > 12) console.log(`      … and ${lines.length - 12} more line(s)`);
  }
  summary([
    "## Schema restore check",
    "",
    `| Objects in ${BASELINE} | Restore errors | Objects after restore | Differences | Same expression, re-bracketed |`,
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${objects.toLocaleString("en")} | ${restoreErrors.length} | ${diff.objects.toLocaleString("en")} | ${total} | ${refolded.length} |`,
    "",
    ...restoreErrors.slice(0, LIST_LIMIT).map((line) => `- error: \`${line.replace(/`/g, "'")}\``),
    ...[...diff.added, ...diff.removed, ...changed].slice(0, LIST_LIMIT).map((key) => `- differs: \`${key}\``),
    ...refolded.slice(0, LIST_LIMIT).map((key) => `- same expression, re-bracketed: \`${key}\``),
  ]);

  if (restoreErrors.length === 0 && total === 0) {
    console.log(
      `[schema-restore] PASS — the file rebuilds production's ${objects.toLocaleString("en")} objects` +
        (refolded.length > 0 ? `; ${refolded.length} of them come back re-bracketed by Postgres, the same expression.` : " exactly."),
    );
    headline(`PASS: ${objects} objects restored, 0 errors, 0 differences (${refolded.length} re-bracketed, same expression)`);
    process.exit(0);
  }
  const verdict = `${restoreErrors.length} restore error(s), ${total} object(s) differ after the restore`;
  headline(`${verdict} (of ${objects} objects)${restoreErrors[0] ? `. First error: ${restoreErrors[0].slice(0, 300)}` : ""}`);
  console.log(`::error::The schema baseline does not rebuild production: ${verdict}. Read docs/security/schema-restore-check.md.`);
  process.exit(1);
}

try {
  if (mode === "--restore-check") restoreCheck();

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
  const message = error instanceof Error ? error.message : String(error);
  if (mode === "--restore-check") headline(`the restore check could not run: ${message.slice(0, 300)}`);
  console.log(`::error::schema baseline check could not run: ${message}`);
  process.exit(1);
}
