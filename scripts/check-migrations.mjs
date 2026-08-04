#!/usr/bin/env node
// Sanity-checks the supabase/migrations directory before CI proceeds.
// Exits non-zero on any violation so it can gate the validate job.
'use strict';

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

// Pre-existing duplicate timestamps that were already applied to production.
// These cannot be renamed without breaking Supabase migration history.
// Add new entries here ONLY for already-applied duplicates; new migrations must use unique timestamps.
const GRANDFATHERED_DUPLICATE_TIMESTAMPS = new Set([
  '20260616120000', // attendance_deferred_atomic_ops / dv_non_mr_status / position_vacancies_status_integrity
  '20260617130000', // coaching_scale_5 / product_aliases_per_distributor
  '20260728100000', // au_resign_vacate_all_open_seats (#1416) / restore_report_rpc_statement_timeouts (#1415) — authored in parallel, each green alone, collided at merge; BOTH already applied to prod under distinct schema_migrations versions (20260728092516 / 20260728091832), so renaming either would desync migration history
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
