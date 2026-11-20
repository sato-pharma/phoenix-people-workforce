// The pgTAP access tests: who the database lets in, asked by signing in as made-up people.
//
//   node scripts/db-access-tests.mjs
//
// Runs supabase/tests/database/access.test.sql against the throwaway database at SCHEMA_RESTORE_URL,
// which the weekly schema restore check has just rebuilt from supabase/schema/production.sql
// (.github/workflows/schema-restore-check.yml). Never production: assertScratchUrl refuses any address
// that is not this machine. The file runs in one transaction and rolls it back, so it leaves the database
// as it found it. psql comes from PATH, or from the pinned image when SCHEMA_BASELINE_DOCKER=1.
//
// Exits 0 only when every planned test printed ok; a failed test, a run that stopped part way, or one that
// could not start is 1. Account: docs/security/schema-restore-check.md, "The access tests".
import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { PG_DUMP_DOCKER_IMAGE, assertScratchUrl } from "./lib/schema-baseline.mjs";
import { ACCESS_TEST_FILE, readTap } from "./lib/db-access-tests.mjs";
import { refuseArguments } from "./lib/refuse-arguments.mjs";

// It takes no arguments, and an ignored one would be a silent change of meaning (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "db-access-tests",
  usage:
    "usage: SCHEMA_RESTORE_URL=postgresql://…@127.0.0.1:5432/postgres node scripts/db-access-tests.mjs\n" +
    "Runs supabase/tests/database/access.test.sql against a throwaway database on this machine; never production.",
});

function headline(text) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `headline=${text.replace(/\s+/g, " ")}\n`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/** psql -At over the test file. The URL and PGPASSWORD travel by environment, never argv. */
function runPsql(url) {
  const dir = path.resolve(path.dirname(ACCESS_TEST_FILE));
  const file = path.basename(ACCESS_TEST_FILE);
  const psqlArgs = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", file];
  const options = {
    env: { ...process.env, PGURL: url, PGCONNECT_TIMEOUT: "20" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
  const result =
    process.env.SCHEMA_BASELINE_DOCKER === "1"
      ? spawnSync(
          "docker",
          ["run", "--rm", "--network", "host", "-e", "PGURL", "-e", "PGPASSWORD", "-e", "PGCONNECT_TIMEOUT",
            "-v", `${dir}:/work:ro`, "-w", "/work", PG_DUMP_DOCKER_IMAGE,
            "sh", "-c", 'psql "$PGURL" "$@"', "psql", ...psqlArgs],
          options,
        )
      : spawnSync("psql", [url, ...psqlArgs], { ...options, cwd: dir });
  if (result.error) throw result.error;
  return result;
}

try {
  const url = process.env.SCHEMA_RESTORE_URL ?? "";
  assertScratchUrl(url);
  if (!existsSync(ACCESS_TEST_FILE)) throw new Error(`${ACCESS_TEST_FILE} is missing`);

  const started = Date.now();
  const run = runPsql(url);
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) process.stdout.write(`${run.stderr}\n`);

  const tap = readTap(run.stdout);
  if (run.status !== 0) tap.reasons.unshift(`psql stopped with exit ${run.status}: ${run.stderr.trim().slice(0, 500)}`);
  const ok = tap.ok && run.status === 0;

  summary([
    "## Access tests (pgTAP)",
    "",
    "| Planned | Passed | Failed | Seconds |",
    "| ---: | ---: | ---: | ---: |",
    `| ${tap.planned ?? "none"} | ${tap.passed} | ${tap.failed.length} | ${seconds} |`,
    "",
    ...tap.failed.map((line) => `- ${line.replace(/`/g, "'")}`),
    ...(ok ? [] : tap.reasons.map((reason) => `- ${reason}`)),
  ]);

  if (ok) {
    console.log(`[access-tests] PASS — ${tap.passed} of ${tap.planned} access tests passed in ${seconds}s`);
    headline(`ACCESS TESTS PASS: ${tap.passed} of ${tap.planned}`);
    process.exit(0);
  }
  const first = tap.failed[0] ?? tap.reasons[0];
  headline(`ACCESS TESTS FAILED: ${tap.reasons.join("; ")}. First: ${first.slice(0, 300)}`);
  console.log(`::error::The database access tests failed: ${tap.reasons.join("; ")}. Read docs/security/schema-restore-check.md.`);
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  headline(`ACCESS TESTS could not run: ${message.slice(0, 300)}`);
  console.log(`::error::the access tests could not run: ${message}`);
  process.exit(1);
}
