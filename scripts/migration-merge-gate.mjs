#!/usr/bin/env node
// Whether a Phoenix PR's migrations are already on PRODUCTION — the reading bash-guard C22 refuses a
// merge on (2026-11-21, the owner's "Build the guard").
//
// WHY IT EXISTS. A merge ships the app's code to production within minutes, and it applies NO
// migration (AGENTS.md §2.3). On 19 Nov 2026 four PRs (#590, #603/#608, #623) each moved a money step
// into one database function, and merged with those functions on staging only. From that evening the
// live code called four functions production did not have. On 21 Nov at 22:11 Cairo the owner's bulk
// approval of outstation claims failed for seven people with PGRST202 ("could not find the function").
// The nightly drift check had seen it, but only at 17:02 that day: it ignores anything merged in the
// last 48 hours, on purpose, because a PR's own migration is SUPPOSED to read unapplied while it is in
// review. The merge is the one moment that window must not cover, so the check moved there.
//
// THE RULE. Every `supabase/migrations/<version>_<name>.sql` file the PR adds or changes must be either
//   - recorded in production's `supabase_migrations.schema_migrations` — matched by `isRecorded`, the
//     drift check's own three-way match (version, name, or the version inside a name), never a copy; or
//   - listed in `ACKNOWLEDGED_EXCEPTIONS` in the PR HEAD's `scripts/lib/migration-inventory.ts` —
//     the evidenced entry `scripts/apply-sql-file.mjs` ends in, because that route writes no ledger row.
// A file the PR deletes is not judged. Files outside that folder are not migrations.
//
// THE DATABASE IS PRODUCTION, AND ONLY PRODUCTION. The credentials come from the process environment,
// then `.env.local` and `.env.production.rls.local` at the repository root — never the staging file,
// and never the session's current folder (a merge runs from the scratchpad, see the ship skill). The
// URL's project ref must be PRODUCTION_REF, or the read is refused: staging HAS these migrations, and a
// gate answered by staging is the exact failure it exists to stop.
//
// It fails CLOSED, in bash-guard C22: a ledger it cannot read is a merge it cannot vouch for.
'use strict';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A no-op when bash-guard imports this module; as the entry point it takes one positional, the PR number.
refuseUnknownFlags({
  name: 'migration-merge-gate',
  entry: import.meta.url,
  known: [],
  hints: ['usage: node scripts/migration-merge-gate.mjs <pr number>'],
});

/** Production's Supabase project ref (AGENTS.md §3). The only database this gate may be answered by. */
export const PRODUCTION_REF = 'ozucdzovmcqvepbozvqf';

/** The most a GitHub read's output may hold. A PR's file list carries every patch and passes 1 MB. */
export const GH_READ_MAX_BYTES = 64 * 1024 * 1024;

/** A migration file, as the drift check names one: `supabase/migrations/<14 digits>_<name>.sql`. */
const MIGRATION_PATH = /^supabase\/migrations\/((\d{14})_(.+)\.sql)$/;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The env files the production pair is read from, in order, after the process environment. */
export const PRODUCTION_ENV_FILES = ['.env.local', '.env.production.rls.local'];

/**
 * The migrations a PR adds or changes, from GitHub's `pulls/<n>/files` entries (`filename`, `status`).
 * A removed file is not judged; a renamed one is judged at its new path.
 * @param {Array<{filename?: string, status?: string}>} files
 * @returns {Array<{fileName: string, version: string, name: string}>}
 */
export function prMigrationFiles(files) {
  const out = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.filename !== 'string' || file.status === 'removed') continue;
    const m = MIGRATION_PATH.exec(file.filename);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ fileName: m[1], version: m[2], name: m[3] });
  }
  return out;
}

/**
 * The names in `ACKNOWLEDGED_EXCEPTIONS`, parsed from the text of `scripts/lib/migration-inventory.ts`
 * the way `tests/migration-exception-staleness.test.ts` parses it: one quoted entry per line inside the
 * block. Returns null when the block cannot be found, so a renamed list never reads as an empty one.
 * @param {string} source
 * @returns {Set<string> | null}
 */
export function acknowledgedExceptions(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const opener = 'ACKNOWLEDGED_EXCEPTIONS = new Set<string>([';
  const start = text.indexOf(opener);
  if (start < 0) return null;
  const end = text.indexOf('\n]);', start);
  if (end < 0) return null;
  const block = text.slice(start + opener.length, end);
  return new Set([...block.matchAll(/^ {2}"(\d{14}_[^"]+\.sql)",?$/gm)].map((m) => m[1]));
}

/**
 * The verdict. `ledger` may be null only when nothing needs it (every file acknowledged).
 * @param {{ migrations: Array<{fileName: string, version: string, name: string}>,
 *           acknowledged: Set<string>, ledger: {versions: Set<string>, names: Set<string>} | null,
 *           isRecorded: (m: object, ledger: object) => boolean }} input
 */
export function migrationMergeVerdict({ migrations, acknowledged, ledger, isRecorded }) {
  const applied = [];
  const acknowledgedHere = [];
  const missing = [];
  for (const migration of migrations) {
    if (acknowledged.has(migration.fileName)) acknowledgedHere.push(migration.fileName);
    else if (ledger && isRecorded(migration, ledger)) applied.push(migration.fileName);
    else missing.push(migration.fileName);
  }
  return { ok: missing.length === 0, applied, acknowledged: acknowledgedHere, missing };
}

/** The production pair, from the process environment first and then the env files at the repo root. */
async function productionCredentials(repoRoot) {
  const { resolveEnvValue } = await import(new URL('./lib/migration-inventory.ts', import.meta.url).href);
  const files = PRODUCTION_ENV_FILES.map((f) => join(repoRoot, f)).filter((f) => existsSync(f));
  const url = resolveEnvValue('NEXT_PUBLIC_SUPABASE_URL', files);
  const key = resolveEnvValue('SUPABASE_SERVICE_ROLE_KEY', files);
  return { url, key };
}

/**
 * Production's migration ledger, through the drift check's own RPC (`phx_ci_migration_versions`),
 * paged because PostgREST caps an RPC response at its db-max-rows. Throws on anything short of a
 * full read of PRODUCTION's ledger.
 * @param {{ repoRoot?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function readProductionLedger(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const { projectRefFromUrl } = await import(new URL('./lib/migration-inventory.ts', import.meta.url).href);
  const { url, key } = await productionCredentials(repoRoot);
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found in the environment or in ' +
        `${PRODUCTION_ENV_FILES.join(', ')} at ${repoRoot}`,
    );
  }
  const ref = projectRefFromUrl(url.value);
  if (ref !== PRODUCTION_REF) {
    throw new Error(
      `the Supabase URL from ${url.source} is project ${ref}, not production (${PRODUCTION_REF}) — ` +
        'the gate is answered by production only',
    );
  }
  const base = url.value.replace(/\/+$/, '');
  const STRIDE = 1000;
  const versions = new Set();
  const names = new Set();
  let rows = 0;
  for (let from = 0; ; ) {
    const res = await fetchImpl(`${base}/rest/v1/rpc/phx_ci_migration_versions?offset=${from}&limit=${STRIDE}`, {
      method: 'POST',
      headers: {
        apikey: key.value,
        Authorization: `Bearer ${key.value}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`the production ledger read answered HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error('the production ledger read did not return a list');
    for (const row of page) {
      if (row && typeof row.version === 'string') versions.add(row.version);
      if (row && typeof row.name === 'string') names.add(row.name);
    }
    if (page.length === 0) break;
    rows += page.length;
    from += page.length;
    if (from > 100_000) throw new Error('the production ledger read returned over 100,000 rows — it is ignoring the page');
  }
  // A ledger that answered empty is not a ledger: production has thousands of rows.
  if (rows === 0) throw new Error('the production ledger read returned no rows');
  return { versions, names, rows, ref };
}

/** `isRecorded`, the drift check's own match — loaded lazily so a PR with no migrations never needs it. */
export async function loadIsRecorded() {
  const { isRecorded } = await import(new URL('./lib/migration-inventory.ts', import.meta.url).href);
  return isRecorded;
}

/** The text of a GitHub `contents` answer's `.content` — base64, wrapped at 60 characters. */
export function decodeContents(content) {
  return Buffer.from(String(content ?? '').replace(/\s+/g, ''), 'base64').toString('utf8');
}

/** One line for a refusal: which files, and what was found. */
export function describeMigrationVerdict(verdict) {
  const parts = [`not on production: ${verdict.missing.join(', ')}`];
  if (verdict.applied.length) parts.push(`already applied: ${verdict.applied.join(', ')}`);
  if (verdict.acknowledged.length) parts.push(`acknowledged: ${verdict.acknowledged.join(', ')}`);
  return parts.join('; ');
}

// `node scripts/migration-merge-gate.mjs <pr>` — the same reading by hand, for a PR you are about to
// put to the owner. Exit 0 every migration is on production (or there are none), 1 some are not,
// 2 it could not tell. Reads GitHub through gh and production through the env files above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pr = process.argv[2];
  if (!/^\d{1,7}$/.test(pr ?? '')) {
    console.log('usage: node scripts/migration-merge-gate.mjs <pr number>');
    process.exit(pr === '--help' || pr === '-h' ? 0 : 2);
  }
  const { execFileSync, execSync } = await import('node:child_process');
  // Through cmd.exe on Windows, where gh ships as .cmd too — the same joined line bash-guard runs.
  // 🔴 The file list carries every file's patch and passes node's default 1 MB: PR 699 answered
  // 1,089,812 bytes and this read ended "could not tell: … ENOBUFS" (23 Nov 2026). bash-guard's
  // reader holds the same figure.
  const read = { encoding: 'utf8', maxBuffer: GH_READ_MAX_BYTES };
  const gh = (args) =>
    process.platform === 'win32' ? execSync(['gh', ...args].join(' '), read) : execFileSync('gh', args, read);
  try {
    const repo = 'sato-pharma/phoenix-people-workforce';
    const files = gh(['api', `repos/${repo}/pulls/${pr}/files?per_page=100`, '--paginate', '--jq', '.[]'])
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const migrations = prMigrationFiles(files);
    if (migrations.length === 0) {
      console.log(`PR #${pr} adds or changes no migration.`);
      process.exit(0);
    }
    const sha = gh(['pr', 'view', pr, '--json', 'headRefOid', '--jq', '.headRefOid', '--repo', repo]).trim();
    const content = gh(['api', `repos/${repo}/contents/scripts/lib/migration-inventory.ts?ref=${sha}`, '--jq', '.content']);
    const acknowledged = acknowledgedExceptions(decodeContents(content));
    if (!acknowledged) throw new Error('ACKNOWLEDGED_EXCEPTIONS not found in the PR head');
    const ledger = await readProductionLedger();
    const verdict = migrationMergeVerdict({ migrations, acknowledged, ledger, isRecorded: await loadIsRecorded() });
    console.log(`production ledger: ${ledger.rows} rows from project ${ledger.ref}`);
    console.log(verdict.ok ? `PR #${pr}: every migration is on production.` : `PR #${pr}: ${describeMigrationVerdict(verdict)}`);
    process.exit(verdict.ok ? 0 : 1);
  } catch (e) {
    console.log(`could not tell: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(2);
  }
}
