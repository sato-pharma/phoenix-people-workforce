// Applies every migration missing from STAGING, and records each one in staging's own ledger.
//
// WHY THIS EXISTS. Nothing applied migrations to staging automatically until 2026-09-04. It was a
// hand step, so staging silently fell behind production: that day it was missing 13 files merged
// between 29 August and 2 September, the oldest 137 hours old — four columns, an index swap and
// four function bodies. The nightly drift check had been red for four consecutive nights and had
// delivered four Telegram alerts, so the gap was never invisible; it was simply nobody's job.
//
// That matters more than it sounds. Staging is the pre-production rehearsal target: ci.yml's login
// smoke runs there, the staging legs of this very drift check run there, and AGENTS.md §7 routes
// risky deploys through it before they reach production. Rehearsing against a schema production
// does not share is not a rehearsal — it is a green light with nothing behind it.
//
// WHAT IT WILL NOT DO, and why each refusal is deliberate:
//
//   * IT WILL NOT TOUCH PRODUCTION. The target project ref is checked against an allowlist of
//     exactly one project before a single statement runs, and production's ref is named in the
//     refusal so a misconfigured secret reads as a mistake rather than as a connection problem.
//     There is no override flag and there must not be one — a production migration needs the
//     owner's explicit approval, applied one at a time (AGENTS.md §6).
//
//   * IT WILL NOT RE-RUN AN ACKNOWLEDGED EXCEPTION. Those are files whose effect is already live
//     by another route, and at least one would do real damage if re-run: the bare
//     `create or replace view` in 20260717030000_crm_effective_visit_type_view.sql would strip
//     `security_invoker = true` back off a live view, nightly. That list lives in the shared
//     inventory module exactly so this script cannot form its own opinion about it.
//
//   * IT WILL NOT KEEP GOING AFTER A FAILURE. Migrations are ordered, and one failing usually
//     means the next cannot succeed either — a migration adding a column that the next one
//     backfills is the ordinary shape here. A sweep reporting six successes and one failure in
//     the middle is harder to recover from than a clean stop at the first.
//
// HOW A MIGRATION IS RECORDED. The ledger row carries the FILE's version and name — not the clock
// at apply time. That is the opposite of what the MCP apply_migration tool does, and it is why
// staging's ledger is today full of versions matching no filename, and why the drift check needs a
// three-way match at all. Recording the real version means everything this script applies is
// answered by that check's cheapest and least ambiguous test.
//
// Usage:
//   node --experimental-strip-types --experimental-specifier-resolution=node \
//     scripts/apply-migrations-to-staging.ts [--dry-run]
//
// Reads PHOENIX_STAGING_DATABASE_URL. Prefer the SESSION POOLER URI from the Supabase dashboard
// (Project Settings -> Database -> Connection pooling): a direct db.<ref>.supabase.co host is
// IPv6-only and GitHub runners have no IPv6, so a direct URL fails in CI with a connection timeout
// that reads like a firewall problem rather than like the wrong URL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  loadLocalMigrations,
  MIGRATIONS_DIR,
  selectMissingMigrations,
  type LocalMigration,
  type RemoteLedger,
} from "./lib/migration-inventory.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "apply-migrations-to-staging",
  entry: import.meta.url,
  known: ["--dry-run"],
});

/**
 * The ONLY project this script may write to. Hard-coded on purpose: an allowlist can be too strict
 * but never too permissive, and "which database am I about to write to" is the one question that
 * must not depend on a secret having been set correctly. Refs are from AGENTS.md §3.
 */
const STAGING_PROJECT_REF = "cifwmndunmlxjhyjugxa";

/** Named only so a misconfigured secret reads "that is PRODUCTION", not "that is not staging". */
const PRODUCTION_PROJECT_REF = "ozucdzovmcqvepbozvqf";

const LOG = "[staging-migrate]";

/**
 * Pull the Supabase project ref out of either connection shape.
 *
 * Two shapes exist and each hides the ref somewhere different:
 *   direct  postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres        -> in the HOST
 *   pooler  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler...:5432/...   -> in the USERNAME
 *
 * Returns null rather than guessing. A URL whose ref cannot be read is refused by the caller:
 * "I could not tell which project this is" must never resolve to "carry on anyway".
 */
export function refFromDatabaseUrl(rawUrl: string): string | null {
  const direct = /@db\.([a-z0-9]+)\.supabase\.co(?::\d+)?\//i.exec(rawUrl);
  if (direct) return direct[1].toLowerCase();
  const pooler = /:\/\/postgres\.([a-z0-9]+):/i.exec(rawUrl);
  if (pooler) return pooler[1].toLowerCase();
  return null;
}

/**
 * The guard. Throws unless the URL points at staging and nothing else.
 *
 * Returns the ref it matched so the caller can PRINT it before connecting — a run that dies
 * halfway should still have said, in its own log, which database it was talking to.
 */
export function assertStagingTarget(rawUrl: string): string {
  const ref = refFromDatabaseUrl(rawUrl);
  if (ref === null) {
    throw new Error(
      `${LOG} REFUSED: could not read a Supabase project ref out of PHOENIX_STAGING_DATABASE_URL. ` +
        "Expected either db.<ref>.supabase.co as the host or postgres.<ref> as the username. " +
        "Refusing rather than guessing — this must never run against an unidentified database.",
    );
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error(
      `${LOG} REFUSED: PHOENIX_STAGING_DATABASE_URL points at PRODUCTION (${ref}). This script ` +
        "only ever writes to staging. A production migration needs the owner's explicit approval, " +
        "applied one at a time (AGENTS.md §6). Fix the secret — there is no override flag here " +
        "and there must not be one.",
    );
  }
  if (ref !== STAGING_PROJECT_REF) {
    throw new Error(
      `${LOG} REFUSED: PHOENIX_STAGING_DATABASE_URL points at project ${ref}, which is not ` +
        `staging (${STAGING_PROJECT_REF}). The account can see four Supabase projects and two of ` +
        "them have nothing to do with this app, so an unfamiliar ref is a misconfiguration.",
    );
  }
  return ref;
}

/**
 * Rewrite a direct connection URL to the pooler.
 *
 * Copied from scripts/apply-sql-file.mjs rather than shared with it: that file is plain .mjs, run
 * without the type-stripping flag, so it cannot import a .ts module. Ten lines of URL rewriting is
 * a fair price for that. What must never be duplicated is the DECISION about which migrations are
 * missing, and that lives in exactly one place — lib/migration-inventory.ts.
 *
 * The pooler region cannot be derived from the ref (two projects in one org can sit behind aws-0
 * and aws-1), so a URL already in pooler form is passed through untouched. That is the form the
 * dashboard hands you and the form to prefer. PHOENIX_POOLER_HOST overrides the default if a
 * project ever moves region.
 */
const DEFAULT_POOLER_HOST = "aws-0-eu-central-1.pooler.supabase.com";

export function toPooler(raw: string): string {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  const host = process.env.PHOENIX_POOLER_HOST?.trim() || DEFAULT_POOLER_HOST;
  return `${scheme}://${user}.${ref}:${pass}@${host}:5432/${db}`;
}

/**
 * The migration's SQL with its ledger row appended, as ONE string sent as ONE simple-protocol
 * query. The ordering is the safety property, three ways:
 *
 *   - Postgres abandons the rest of a multi-statement simple query at the first error, so a
 *     failing migration can never reach the insert. The ledger cannot record what did not run.
 *   - A file with no explicit `begin;` runs inside Postgres's own implicit transaction for the
 *     whole string, so the migration and its ledger row commit together or not at all.
 *   - A file that opens its OWN `begin; ... commit;` has committed before the insert is reached.
 *     Still correct: the insert then runs precisely because the migration already succeeded.
 *
 * The leading newline is not cosmetic. 14 migration files in this repository end with a `--`
 * comment rather than a semicolon; without it the insert would be swallowed by that comment and
 * would silently never run, leaving a correctly-applied migration missing from the ledger and
 * therefore re-applied on every future run.
 */
export function withLedgerInsert(sqlText: string, migration: LocalMigration): string {
  const version = migration.version.replace(/'/g, "''");
  const name = migration.name.replace(/'/g, "''");
  return (
    `${sqlText.replace(/\s*$/, "")}\n\n` +
    "insert into supabase_migrations.schema_migrations (version, name)\n" +
    `values ('${version}', '${name}')\n` +
    "on conflict (version) do nothing;\n"
  );
}

/** The ledger as the drift check's matcher wants it: the version set and the name set. */
async function readLedger(sql: postgres.Sql): Promise<RemoteLedger> {
  const rows = await sql<{ version: string | null; name: string | null }[]>`
    select version, name from supabase_migrations.schema_migrations
  `;
  const kept = (values: (string | null)[]) =>
    new Set(values.filter((value): value is string => value !== null && value.length > 0));
  return {
    versions: kept(rows.map((row) => row.version)),
    names: kept(rows.map((row) => row.name)),
  };
}

async function main() {
  // Two ways in, and the env var is the one CI uses. Passing the flag as `pnpm run x -- --dry-run`
  // relies on pnpm's argument forwarding, which is one more mechanism to be wrong about, and its
  // failure mode points the wrong way: a flag that silently fails to arrive turns a requested dry
  // run into a real apply. An env var either has the value or does not.
  const dryRun =
    process.argv.includes("--dry-run") || process.env.PHOENIX_MIGRATE_DRY_RUN === "true";
  const rawUrl = process.env.PHOENIX_STAGING_DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      `${LOG} PHOENIX_STAGING_DATABASE_URL is not set. In CI it is a repository secret; locally it ` +
        "lives in .env.staging.rls.local. Use the Session pooler URI from the Supabase dashboard — " +
        "a direct db.<ref>.supabase.co host is IPv6-only and unreachable from a GitHub runner.",
    );
  }

  // Announced BEFORE connecting, so a run that dies on connect has still said what it was aiming
  // at. The ref is the only thing that separates these projects on any call (AGENTS.md §8).
  const ref = assertStagingTarget(rawUrl);
  const suffix = dryRun ? " — DRY RUN, nothing will be applied" : "";
  console.log(`${LOG} target project ref: ${ref} (staging)${suffix}`);

  const sql = postgres(toPooler(rawUrl), { max: 1, prepare: false });
  let applied = 0;
  try {
    // withCommitTimes: false — the only consumer of a commit time is the grace window, which this
    // script deliberately ignores. Asking for them anyway costs one git process per migration file,
    // 410 of them today, which is minutes of a CI job spent computing a number we then discard.
    const local = loadLocalMigrations({ withCommitTimes: false });
    const remote = await readLedger(sql);

    // ignoreGraceWindow: this runs ON the merge, so every file it cares about is seconds old and
    // the check's 48h window would hide exactly the migration we are here to apply. That window is
    // right for a nightly report and exactly wrong here — see selectMissingMigrations.
    const missing = selectMissingMigrations(local, remote, {
      nowMs: Date.now(),
      ignoreGraceWindow: true,
    });

    console.log(
      `${LOG} ${local.length} local migrations, ${remote.versions.size} versions recorded on ` +
        `${ref}, ${missing.length} to apply.`,
    );

    if (missing.length === 0) {
      console.log(`${LOG} OK — staging already has every migration in the repository.`);
      return;
    }

    for (const migration of missing) {
      const text = fs.readFileSync(path.join(MIGRATIONS_DIR, migration.fileName), "utf8");
      if (dryRun) {
        console.log(`${LOG} would apply ${migration.fileName} (${text.length} bytes)`);
        continue;
      }
      console.log(`${LOG} applying ${migration.fileName} ...`);
      // .simple() is required: the extended protocol refuses a multi-statement string, and every
      // migration here is many statements.
      await sql.unsafe(withLedgerInsert(text, migration)).simple();
      applied += 1;
      console.log(`${LOG} applied  ${migration.fileName}`);
    }

    console.log(
      dryRun
        ? `${LOG} DRY RUN complete — ${missing.length} migration(s) would have been applied.`
        : `${LOG} DONE — applied ${applied} migration(s) to ${ref}.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Run only when invoked directly. Importing this module from a test must not open a connection —
// tests/staging-migration-applier.test.ts exercises the exported pure functions above, and under
// the test runner process.argv[1] is the runner, so this comparison is false.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${LOG} FAILED:`, error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
