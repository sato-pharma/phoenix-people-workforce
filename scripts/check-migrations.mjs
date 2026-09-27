#!/usr/bin/env node
// Sanity-checks the supabase/migrations directory before CI proceeds.
// Exits non-zero on any violation so it can gate the validate job.
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILENAME_RE = /^\d{14}_[\w-]+\.sql$/;
// Destructive statements that must be guarded or annotated.
const DESTRUCTIVE_RE = /^\s*(DROP\s+TABLE|TRUNCATE)/im;
// Override comment a developer can add to a migration to acknowledge the risk.
const SAFE_OVERRIDE_RE = /--\s*SAFE:/i;

// Pre-existing duplicate timestamps that were already applied to production and that CI still
// tolerates. Add new entries here ONLY for an already-applied duplicate; new migrations must use
// unique timestamps.
//
// These files are NOT frozen. `supabase_migrations.schema_migrations` is matched by `name`, and
// `version` is stamped when a migration is APPLIED rather than read off the filename — so for a
// normally stamped row the filename prefix appears nowhere in the ledger, and re-stamping it
// desyncs nothing. #1419 proved it in this repo: it re-stamped
// 20260728100000_restore_report_rpc_statement_timeouts.sql to 20260728100500_…, and that ledger row
// still reads name=restore_report_rpc_statement_timeouts, version=20260728091832, untouched.
// Full account in docs/agents-session-traps.md under Migrations.
//
// Read the actual ledger row before re-stamping, though — not every row is stamped normally. That
// migration's collision partner sits there as name=20260728100000_au_resign_vacate_all_open_seats
// (the FULL filename stem, old timestamp embedded) under version 20260728092516; for THAT row the
// prefix IS in the ledger. "A rename is safe" holds for a normally stamped row, not unconditionally.
//
// RETIRED 2026-09-03 — 20260616120000, 20260617130000 and 20260728100000 were all dead: the first
// two matched no migration file at all, and #1419's re-stamp left the third holding its prefix
// alone. Section 2b below now fails on an entry that no longer names a real duplicate, so this list
// cannot silently rot into cover for a collision that no longer exists.
const GRANDFATHERED_DUPLICATE_TIMESTAMPS = new Set([
  // phx_rep_bulk_dependency (#2131) / cv_extraction_any_job_title (#2130), authored in parallel three
  // minutes apart: #2131 merged green at 13:00 UTC, #2130 at 13:03, and the duplicate only exists once
  // BOTH are on main, so neither PR could have caught it. Applied to prod under distinct versions —
  // cv_extraction_any_job_title=20260814125822, phx_rep_bulk_dependency=20260814125938.
  '20260814150000',
]);

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`[migration-check] ERROR: ${msg}`);
  errors++;
}

function warn(msg) {
  console.warn(`[migration-check] WARN:  ${msg}`);
  warnings++;
}

if (!fs.existsSync(MIGRATIONS_DIR)) {
  fail(`migrations directory not found: ${MIGRATIONS_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

// 1. Filename format check
for (const file of files) {
  if (!FILENAME_RE.test(file)) {
    fail(`"${file}" does not match required pattern YYYYMMDDHHMMSS_name.sql`);
  }
}

// 2. Duplicate timestamp prefix check (grandfathered timestamps are warned, not failed)
const seenTimestamps = new Map();
for (const file of files) {
  const ts = file.slice(0, 14);
  if (seenTimestamps.has(ts)) {
    const first = seenTimestamps.get(ts);
    if (GRANDFATHERED_DUPLICATE_TIMESTAMPS.has(ts)) {
      warn(`Grandfathered duplicate timestamp "${ts}" shared by "${first}" and "${file}" — do not add more files with this timestamp`);
    } else {
      fail(`Duplicate timestamp "${ts}" used by both "${first}" and "${file}" — use a unique timestamp`);
    }
  } else {
    seenTimestamps.set(ts, file);
  }
}

// 2c. A timestamp that collides with something ALREADY ON origin/main.
//
// Rule 2 above only ever saw this worktree, and that is the blind spot behind most of this check's
// failures: 10 of the last 14 `validate` failures were this step, and the commonest shape is a
// timestamp that is unique locally and collides with a migration that merged while the branch was
// open. CI judges the MERGE ref, so it sees the collision and the branch does not — the session gets
// a green local run, pushes, and reads a red check over a file that is not even on its branch.
// Three collisions in one session are on record.
//
// Reading origin/main here closes it in about 30 milliseconds and needs no network: the ref is
// already in the local object store after any fetch. It FAILS OPEN on purpose — a shallow CI
// checkout (`fetch-depth: 2`) has no origin/main, and a checkout with no git at all must not be
// refused. A check that cannot see main is silently skipped, never treated as clean proof.
let mainFiles = null;
try {
  mainFiles = new Set(
    execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'supabase/migrations'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    })
      .split('\n')
      .map((line) => path.basename(line.trim()))
      .filter((name) => name.endsWith('.sql')),
  );
} catch {
  mainFiles = null; // no origin/main, no git, shallow clone — skip, do not fail
}

if (mainFiles && mainFiles.size > 0) {
  const onMainByStamp = new Map();
  for (const name of mainFiles) onMainByStamp.set(name.slice(0, 14), name);
  for (const file of files) {
    if (mainFiles.has(file)) continue; // already merged; rule 2 covers duplicates within the tree
    const ts = file.slice(0, 14);
    const clash = onMainByStamp.get(ts);
    if (!clash) continue;
    if (GRANDFATHERED_DUPLICATE_TIMESTAMPS.has(ts)) continue;
    fail(
      `"${file}" uses timestamp "${ts}", which "${clash}" already carries on origin/main. ` +
        'CI judges the MERGE ref, so this is red there and green here — the file it collides with is not ' +
      'on your branch. NOTE: this compares against the LAST-FETCHED origin/main, so a stale ref can ' +
      'still miss a collision with something merged since your last fetch; fetch first for certainty. ' +
        'on your branch. Rename this migration to a timestamp later than every file on main: ' +
        'the new-migration skill mints one for you, or take the greatest stamp on main and add a second.'
    );
  }
} else {
  // Two different causes, and saying the wrong one sends the reader to the wrong place.
  const why = mainFiles === null
    ? 'origin/main is not readable here (no such ref, no git, or a shallow checkout)'
    : 'origin/main is readable but lists no migrations';
  console.log(`[migration-check] ${why} — skipped the cross-branch timestamp check. This is normal in a shallow CI checkout.`);
}

// 2b. A grandfathered entry must still name a REAL duplicate.
// Left unchecked this list rots into cover for a collision that no longer exists: three of the
// original four entries were already dead when this guard was added (2026-09-03). The same rule is
// enforced by tests/migration-grandfather-staleness.test.ts, but that only runs inside the full
// suite — this copy lives in the FAST check on purpose, the same reason the SECURITY DEFINER rule
// further down is duplicated here.
for (const ts of GRANDFATHERED_DUPLICATE_TIMESTAMPS) {
  const carrying = files.filter((f) => f.slice(0, 14) === ts).length;
  if (carrying < 2) {
    fail(
      `Grandfathered duplicate timestamp "${ts}" no longer names a duplicate — ${carrying} file(s) carry it. ` +
      'Remove it from GRANDFATHERED_DUPLICATE_TIMESTAMPS rather than leaving a stale exemption behind.'
    );
  }
}

// 3. Destructive-statement check (warns but does not fail — intentional migrations use DROP TABLE)
for (const file of files) {
  const filePath = path.join(MIGRATIONS_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');
  if (DESTRUCTIVE_RE.test(content) && !SAFE_OVERRIDE_RE.test(content)) {
    warn(
      `"${file}" contains DROP TABLE or TRUNCATE without a "-- SAFE:" annotation. ` +
      'Add "-- SAFE: <reason>" near the statement if this is intentional.'
    );
  }
}

// 4. Public SECURITY DEFINER functions must revoke EXECUTE from PUBLIC.
// A function created in `public` inherits PostgreSQL's default EXECUTE grant to PUBLIC, and anon /
// authenticated are members of PUBLIC — so a new SECURITY DEFINER function is callable with the
// anonymous key unless the migration revokes it. Revoking only anon/authenticated is a no-op.
//
// tests/migrations-secdef-revoke-guard.test.ts enforces the same rule, but that test only runs
// inside the full 578-file suite. Three migrations authored against `pnpm run check:migrations`
// alone therefore looked clean here and failed later in CI (2026-08-04) — this duplicate lives in
// the FAST check on purpose, so the defect surfaces in under a second instead of after a build.
const SECDEF_CUTOFF = '20260719170000';
for (const file of files) {
  if (!/^\d{14}_/.test(file) || file.slice(0, 14) < SECDEF_CUTOFF) continue;

  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Strip line comments so prose mentioning "security definer", or a commented-out example,
  // can neither raise a false alarm nor hide a real one.
  const sql = raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  const lower = sql.toLowerCase();

  const createsFunction = /\bcreate\s+(or\s+replace\s+)?function\s+(public\.)?[a-z_][a-z0-9_]*\s*\(/i.test(sql);
  const isSecurityDefiner = /\bsecurity\s+definer\b/i.test(sql);
  if (!createsFunction || !isSecurityDefiner) continue;

  const hasRevokeExecute =
    /\brevoke\s+execute\s+on\s+function\b/i.test(lower) ||
    /\brevoke\s+execute\s+on\s+functions\b/i.test(lower) || // ALTER DEFAULT PRIVILEGES form
    /execute\s+format\([^)]*revoke\s+execute/i.test(sql); // sweep via dynamic SQL
  const revokesPublic = /\bfrom\s+[^;]*\bpublic\b/i.test(lower);

  if (!(hasRevokeExecute && revokesPublic)) {
    fail(
      `"${file}" creates a public SECURITY DEFINER function but never REVOKEs EXECUTE on it FROM PUBLIC. ` +
      'anon/authenticated inherit EXECUTE through PUBLIC membership, so revoking only those two is a no-op. ' +
      'Add: revoke execute on function public.<fn>(<args>) from public, anon, authenticated; ' +
      'then re-grant explicitly (revoking PUBLIC on a default ACL also strips service_role): ' +
      'grant execute on function public.<fn>(<args>) to service_role;'
    );
  }
}

// 5. No migration may hand anon/authenticated a schema-wide DEFAULT privilege on `public`.
// This is the statement that caused the 2026-08-06 leak. Six ad-hoc backup tables were born
// readable by anon — nobody granted anything, the schema default did it — and 412 customer names
// were reachable with the public anon key for two days. 20260809130000 and 20260809180000 revoked
// those defaults; this rule stops a future migration quietly granting them back, which would
// reopen the hole for every table created afterwards without touching a single existing table
// (and so without any other check noticing).
//
// Only GRANT is rejected. REVOKE on the same objects is the fix and must stay allowed.
//
// The 2026-07-11 baseline is exempt, and is the reason this rule exists. It is a pg_dump of
// production as it stood that day, so it faithfully records the four
// `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon/authenticated` lines that Supabase
// ships by default — the very statements that made the zz_backup_* tables readable. Rewriting a
// historical snapshot to satisfy a lint would make it stop describing what the database actually
// was. It is neutralised by 20260809130000 + 20260809180000 revoking those defaults, not by
// editing the dump.
const DEFAULT_ACL_EXEMPT = new Set(['20260711135352_phoenix_production_schema_baseline.sql']);
for (const file of files) {
  if (!/^\d{14}_/.test(file) || DEFAULT_ACL_EXEMPT.has(file)) continue;

  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Same comment-stripping rationale as rule 4: the rollback instructions in
  // 20260809130000/20260809180000 are commented-out GRANTs and must not trip this.
  const sql = raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n')
    .replace(/\s+/g, ' ');

  // `alter default privileges [for role X] in schema public grant ... to ... anon|authenticated`
  const grantsDefaultToBrowserRole =
    /\balter\s+default\s+privileges\b[^;]*\bin\s+schema\s+public\b[^;]*\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(sql);

  if (grantsDefaultToBrowserRole) {
    fail(
      `"${file}" GRANTs a schema-wide DEFAULT privilege on \`public\` to anon or authenticated. ` +
      'That is the exact statement behind the 2026-08-06 exposure: every table created afterwards is ' +
      'born readable with the public anon key, no existing table changes, and nothing else notices. ' +
      'Grant on the specific table instead (grant select on table public.<t> to authenticated;) and ' +
      'enable RLS on it.'
    );
  }
}

// Summary
const total = files.length;
if (errors === 0 && warnings === 0) {
  console.log(`[migration-check] OK — ${total} migrations passed all checks.`);
  process.exit(0);
}

if (warnings > 0 && errors === 0) {
  console.log(`[migration-check] ${total} migrations — ${warnings} warning(s), 0 errors. Passing.`);
  process.exit(0);
}

console.error(`[migration-check] ${total} migrations — ${errors} error(s), ${warnings} warning(s). Fix the errors before merging.`);
process.exit(1);
