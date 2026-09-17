#!/usr/bin/env node
// Scaffolds one migration file for this repo and pre-flights it against the rules CI enforces.
//
// WHY THIS EXISTS. `supabase/migrations` holds 535 files (2026-09-17) and CI checks four things
// about them that a hand-written file gets wrong in ways that are invisible while you are writing
// it. Two of the four are hard FAILURES of the required `validate` job, and both have a real
// incident behind them:
//
//   * a public SECURITY DEFINER function that never REVOKEs EXECUTE FROM PUBLIC is callable with
//     the anon key that ships in the browser bundle. Three migrations authored against
//     `check:migrations` alone looked clean and failed later in CI on 2026-08-04.
//   * `alter default privileges ... in schema public grant ... to anon` is the exact statement
//     behind the 2026-08-06 exposure: 412 customer names reachable with the public anon key for
//     two days, through six ad-hoc backup tables nobody granted anything on.
//
// And one is invisible until the file lands next to the other 535: a DUPLICATE 14-digit timestamp
// fails `validate`, and a timestamp that merely sorts EARLIER than a migration already on main
// does not fail anything at all — it just applies in the wrong order, forever.
//
// WHAT IT DOES NOT DO. It does not apply anything, to any database, ever. It writes one file and
// reports. Applying is a separate decision with its own announcement (see SKILL.md phase 6), and
// `apply_migration` is the tool for it.
//
// THE AUTHORITY IS THE REPO'S OWN CHECKERS, NOT THIS FILE. `auditSql` below is a FAST pre-flight
// on the single new file so the author sees the verdict while writing instead of after a push, and
// this script finishes by running the real checkers over the whole directory. Where the two ever
// disagree, the checkers are right and this pre-flight is the bug: a guard asserting something
// untrue costs every session a wasted round trip and teaches a false fact.
//
//   node .claude/skills/new-migration/new-migration.mjs --name add_foo_table
//   node .claude/skills/new-migration/new-migration.mjs --audit supabase/migrations/2026...sql
//   node .claude/skills/new-migration/new-migration.mjs --selftest
//
// FAILS LOUD, unlike a hook: this is a tool a session runs on purpose, so a broken argument is an
// error with a non-zero exit, never a silent allow.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

/* ------------------------------------------------------------------ timestamps */

/** The 14 digits of `date` as read in `timeZone` — YYYYMMDDHHMMSS. */
export function stampIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  // en-CA gives hour 24 for midnight in some ICU builds; 24 would sort after 23:59:59 of the
  // same day, which is wrong by a day. Normalise it the way every other formatter does.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}${get('month')}${get('day')}${hour}${get('minute')}${get('second')}`;
}

/** One second later, as 14 digits. The value is a SORT KEY, so UTC arithmetic is exact. */
export function bumpStamp(stamp) {
  const y = Number(stamp.slice(0, 4));
  const mo = Number(stamp.slice(4, 6));
  const d = Number(stamp.slice(6, 8));
  const h = Number(stamp.slice(8, 10));
  const mi = Number(stamp.slice(10, 12));
  const s = Number(stamp.slice(12, 14));
  const next = new Date(Date.UTC(y, mo - 1, d, h, mi, s + 1));
  return stampIn(next, 'UTC');
}

/**
 * A timestamp that is unique in `existing` AND sorts after every one of them.
 *
 * Both halves matter and only one of them is a CI error. A duplicate fails `validate`; a stamp
 * that merely sorts early passes every check and then applies out of order against a database
 * whose state the migration did not expect.
 *
 * The greater of Cairo and UTC is the starting point because this directory holds both: the
 * Supabase CLI stamps UTC, a hand-written file usually carries the local Cairo hour, and picking
 * the smaller of the two would file a new migration BEHIND one written three hours ago.
 */
export function mintTimestamp({ now, existing = [], zones = ['Africa/Cairo', 'UTC'] } = {}) {
  const wall = zones.map((z) => stampIn(now, z)).sort().pop();
  const latest = existing.map((f) => String(f).slice(0, 14)).filter((t) => /^\d{14}$/.test(t)).sort().pop();
  if (!latest) return wall;
  let candidate = wall > latest ? wall : bumpStamp(latest);
  const taken = new Set(existing.map((f) => String(f).slice(0, 14)));
  while (taken.has(candidate)) candidate = bumpStamp(candidate);
  return candidate;
}

/* ------------------------------------------------------------------ names */

const NAME_OK = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** CI accepts `[\w-]+`; this directory is 535 files of snake_case. Hold the convention. */
export function validateName(name) {
  if (!name) return 'a migration needs a --name, in snake_case (add_foo_table)';
  if (name.length > 60) return `the name is ${name.length} characters — keep it under 60 so the filename stays readable`;
  if (name.endsWith('.sql')) return 'drop the .sql — the name is the part after the timestamp';
  if (/^\d/.test(name)) return 'the name must not start with a digit — the 14-digit timestamp is added for you';
  if (!NAME_OK.test(name)) {
    return `"${name}" is not snake_case — lower-case words joined by single underscores (CI allows more, this directory does not)`;
  }
  return null;
}

/* ------------------------------------------------------------------ the SQL pre-flight */

/**
 * Strip `--` line comments, exactly as scripts/check-migrations.mjs does.
 *
 * Without this, prose mentioning "security definer" raises a false alarm and a commented-out
 * GRANT hides a real one. The rollback instructions in 20260809130000 are commented-out GRANTs:
 * a pre-flight that read them would fail a migration that is itself the fix.
 */
export function stripSqlComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

/**
 * The four rules CI applies to a migration's CONTENT, run against one file.
 *
 * Levels match CI exactly: `error` fails the required `validate` job, `warn` does not. Reporting a
 * warning as an error would teach a session to add a `-- SAFE:` annotation it does not believe.
 */
export function auditSql(sql) {
  const findings = [];
  const bare = stripSqlComments(sql);
  const flat = bare.replace(/\s+/g, ' ');

  // R1 — DROP TABLE / TRUNCATE without an acknowledgement. WARN in CI, so warn here.
  if (/^\s*(DROP\s+TABLE|TRUNCATE)/im.test(sql) && !/--\s*SAFE:/i.test(sql)) {
    findings.push({
      rule: 'R1 destructive-unannotated',
      level: 'warn',
      message:
        'contains DROP TABLE or TRUNCATE with no "-- SAFE: <reason>" annotation. CI warns and still ' +
        'passes; the annotation is how the next reader knows the loss was intended.',
    });
  }

  // R2 — a public SECURITY DEFINER function must REVOKE EXECUTE FROM PUBLIC. ERROR in CI.
  const createsFunction = /\bcreate\s+(or\s+replace\s+)?function\s+(public\.)?[a-z_][a-z0-9_]*\s*\(/i.test(bare);
  const isSecurityDefiner = /\bsecurity\s+definer\b/i.test(bare);
  if (createsFunction && isSecurityDefiner) {
    const lower = bare.toLowerCase();
    const revokesExecute =
      /\brevoke\s+execute\s+on\s+function\b/i.test(lower) ||
      /\brevoke\s+execute\s+on\s+functions\b/i.test(lower) ||
      /execute\s+format\([^)]*revoke\s+execute/i.test(bare);
    const fromPublic = /\bfrom\s+[^;]*\bpublic\b/i.test(lower);
    if (!(revokesExecute && fromPublic)) {
      findings.push({
        rule: 'R2 secdef-execute-not-revoked',
        level: 'error',
        message:
          'creates a public SECURITY DEFINER function and never REVOKEs EXECUTE on it FROM PUBLIC. ' +
          'anon and authenticated inherit EXECUTE through PUBLIC membership, so revoking only those ' +
          'two is a no-op. Add: revoke execute on function public.<fn>(<args>) from public, anon, ' +
          'authenticated;  then re-grant what needs it: grant execute on function ' +
          'public.<fn>(<args>) to service_role;',
      });
    }
  }

  // R3 — the 2026-08-06 statement. ERROR in CI. Only GRANT; REVOKE is the fix and stays allowed.
  if (
    /\balter\s+default\s+privileges\b[^;]*\bin\s+schema\s+public\b[^;]*\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i.test(
      flat,
    )
  ) {
    findings.push({
      rule: 'R3 default-privilege-to-browser-role',
      level: 'error',
      message:
        'GRANTs a schema-wide DEFAULT privilege on `public` to anon or authenticated. Every table ' +
        'created afterwards is born readable with the public anon key, no existing table changes, ' +
        'and nothing else notices. Grant on the specific table instead and enable RLS on it.',
    });
  }

  // R4 — a backup table in `public`. ERROR in check:sql-backups.
  const backupInPublic = /\bcreate\s+table\s+(if\s+not\s+exists\s+)?(public\.)?"?([a-z0-9_]*backup[a-z0-9_]*)"?\s*(\(|as\b)/i;
  const m = backupInPublic.exec(flat);
  if (m) {
    findings.push({
      rule: 'R4 backup-table-in-public',
      level: 'error',
      message:
        `creates "${m[3]}" in \`public\`. A point-in-time snapshot never goes there: \`public\` is the ` +
        'one schema PostgREST exposes and Supabase grants anon SELECT on new tables in it. Put it in ' +
        'its own dated schema — create schema if not exists <domain>_backup_YYYYMMDD; revoke all on ' +
        'schema <domain>_backup_YYYYMMDD from anon, authenticated;',
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ the template */

export function template({ stamp, name }) {
  return `-- ${name}
--
-- WHAT THIS CHANGES:
-- WHY:
-- ROLLBACK: (the statement that undoes this, or why it cannot be undone)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- your statements here

commit;

-- Before you push, the rules that fail the required \`validate\` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp ${stamp} was minted to sort after every migration already on main.
`;
}

/* ------------------------------------------------------------------ the real checkers */

function runChecker(label, args) {
  try {
    const out = execFileSync('node', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return { label, ok: true, out: out.trim() };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    return { label, ok: false, out: out || String(err.message || err) };
  }
}

/* ------------------------------------------------------------------ selftest */

function selftest() {
  let failed = 0;
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      failed += 1;
      console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
    }
    return ok;
  };
  const rules = (sql) => auditSql(sql).map((f) => `${f.level}:${f.rule.split(' ')[0]}`).sort();

  console.log('SELFTEST new-migration:');

  // --- timestamps -------------------------------------------------------------
  const noon = new Date('2026-09-17T12:00:00Z');
  check('stamp in UTC', stampIn(noon, 'UTC'), '20260917120000');
  check('stamp in Cairo is 3h ahead', stampIn(noon, 'Africa/Cairo'), '20260917150000');
  check('midnight Cairo is 00, never 24', stampIn(new Date('2026-09-17T21:00:00Z'), 'Africa/Cairo'), '20260918000000');
  check('bump rolls the second', bumpStamp('20260917120000'), '20260917120001');
  check('bump rolls the day', bumpStamp('20260917235959'), '20260918000000');
  check('bump rolls the year', bumpStamp('20261231235959'), '20270101000000');

  check('empty directory takes the wall clock', mintTimestamp({ now: noon, existing: [] }), '20260917150000');
  check(
    'a stamp already ahead of the clock is bumped, never reused',
    mintTimestamp({ now: noon, existing: ['20260917150000_a.sql'] }),
    '20260917150001',
  );
  check(
    'a FUTURE migration still sorts first — the new file goes after it',
    mintTimestamp({ now: noon, existing: ['20261231235959_far.sql'] }),
    '20270101000000',
  );
  check(
    'a collision on the bumped value is bumped again',
    mintTimestamp({ now: noon, existing: ['20260917150000_a.sql', '20260917150001_b.sql'] }),
    '20260917150002',
  );
  check(
    'only the newest existing stamp matters',
    mintTimestamp({ now: noon, existing: ['20200101000000_old.sql', '20260917150000_a.sql'] }),
    '20260917150001',
  );
  check('junk filenames are ignored, not crashed on', mintTimestamp({ now: noon, existing: ['README.md', 'x.sql'] }), '20260917150000');

  // --- names ------------------------------------------------------------------
  check('a good name passes', validateName('add_weekly_review_day'), null);
  check('a missing name is named as missing', typeof validateName(''), 'string');
  check('CamelCase is refused', typeof validateName('addFooTable'), 'string');
  check('a trailing .sql is refused', typeof validateName('add_foo.sql'), 'string');
  check('a leading digit is refused', typeof validateName('2026_add_foo'), 'string');
  check('a double underscore is refused', typeof validateName('add__foo'), 'string');
  check('a hyphen is refused', typeof validateName('add-foo'), 'string');

  // --- the SQL rules ----------------------------------------------------------
  check('a plain migration is clean', rules('begin; alter table public.employees add column x text; commit;'), []);

  check('R1 fires on DROP TABLE', rules('drop table public.old_thing;'), ['warn:R1']);
  check('R1 fires on TRUNCATE', rules('truncate public.staging_rows;'), ['warn:R1']);
  check('R1 is silenced by -- SAFE:', rules('-- SAFE: debris from #1234\ndrop table public.old_thing;'), []);

  const secdef = 'create function public.f() returns int language sql security definer as $$ select 1 $$;';
  check('R2 fires on an unrevoked SECURITY DEFINER function', rules(secdef), ['error:R2']);
  check(
    'R2 is satisfied by a revoke FROM PUBLIC',
    rules(`${secdef} revoke execute on function public.f() from public, anon, authenticated;`),
    [],
  );
  check(
    'R2 still fires when only anon/authenticated are revoked',
    rules(`${secdef} revoke execute on function public.f() from anon, authenticated;`),
    ['error:R2'],
  );
  check(
    'R2 ignores a SECURITY INVOKER function',
    rules('create function public.f() returns int language sql as $$ select 1 $$;'),
    [],
  );
  check('R2 ignores prose in a comment', rules('-- this is not a security definer function\nselect 1;'), []);

  check(
    'R3 fires on a default privilege granted to anon',
    rules('alter default privileges in schema public grant all on tables to anon;'),
    ['error:R3'],
  );
  check(
    'R3 leaves the REVOKE that fixes it alone',
    rules('alter default privileges in schema public revoke all on tables from anon, authenticated;'),
    [],
  );
  check(
    'R3 ignores a commented-out GRANT (the rollback note in 20260809130000)',
    rules('-- alter default privileges in schema public grant all on tables to anon;\nselect 1;'),
    [],
  );

  check('R4 fires on a backup table in public', rules('create table public.crm_backup_20260801 as select * from public.crm;'), [
    'error:R4',
  ]);
  check('R4 fires with no schema qualifier at all', rules('create table sales_backup_20260801 (id int);'), ['error:R4']);
  check(
    'R4 leaves a dated backup SCHEMA alone',
    rules('create schema if not exists crm_backup_20260801; create table crm_backup_20260801.rows as select 1;'),
    [],
  );

  check(
    'several rules fire together',
    rules(`truncate public.x; ${secdef} create table public.y_backup_20260801 (id int);`),
    ['error:R2', 'error:R4', 'warn:R1'],
  );

  // --- the template it writes must pass its own pre-flight --------------------
  check('the template is clean', auditSql(template({ stamp: '20260917150000', name: 'example' })), []);

  const total = 37;
  console.log(`  ${total} cases, ${failed} failed`);
  if (failed) {
    console.error('SELFTEST FAILED');
    process.exit(1);
  }
  console.log('SELFTEST OK');
}

/* ------------------------------------------------------------------ cli */

function reportFindings(file, findings) {
  if (!findings.length) {
    console.log(`pre-flight  clean — ${file}`);
    return 0;
  }
  console.log(`pre-flight  ${findings.length} finding(s) — ${file}`);
  for (const f of findings) {
    console.log(`  ${f.level.toUpperCase().padEnd(5)} ${f.rule}`);
    console.log(`        ${f.message}`);
  }
  return findings.filter((f) => f.level === 'error').length;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const auditAt = argv.indexOf('--audit');
  if (auditAt >= 0) {
    const file = argv[auditAt + 1];
    if (!file) {
      console.error('--audit needs a path to a .sql file');
      process.exit(2);
    }
    const path = resolve(REPO, file);
    if (!existsSync(path)) {
      console.error(`no such file: ${path}`);
      process.exit(2);
    }
    const errors = reportFindings(file, auditSql(readFileSync(path, 'utf8')));
    process.exit(errors ? 1 : 0);
  }

  const nameAt = argv.indexOf('--name');
  const name = nameAt >= 0 ? argv[nameAt + 1] : null;
  const problem = validateName(name);
  if (problem) {
    console.error(problem);
    console.error('usage: node .claude/skills/new-migration/new-migration.mjs --name add_foo_table [--dry-run]');
    process.exit(2);
  }

  if (!existsSync(MIGRATIONS)) {
    console.error(`migrations directory not found: ${MIGRATIONS}`);
    process.exit(2);
  }
  const existing = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  const stamp = mintTimestamp({ now: new Date(), existing });
  const file = `${stamp}_${name}.sql`;
  const path = join(MIGRATIONS, file);
  const body = template({ stamp, name });

  console.log(`migrations   ${existing.length} on disk, newest ${existing.map((f) => f.slice(0, 14)).sort().pop()}`);
  console.log(`new file     supabase/migrations/${file}`);

  if (argv.includes('--dry-run')) {
    console.log('dry run — nothing written');
    return;
  }

  if (existsSync(path)) {
    console.error(`refusing to overwrite ${path}`);
    process.exit(1);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  console.log('written      fill in WHAT/WHY/ROLLBACK and the statements, then re-run with --audit');

  // The whole-directory checkers are the authority. Run them now so a duplicate timestamp or a
  // broken neighbour surfaces here rather than in CI.
  const results = [
    runChecker('check:migrations', ['scripts/check-migrations.mjs']),
    runChecker('check:sql-backups', [
      '--experimental-strip-types',
      '--experimental-specifier-resolution=node',
      'scripts/check-sql-backup-placement.ts',
    ]),
  ];
  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);
    const tail = r.out.split('\n').slice(-6).join('\n');
    if (tail) console.log(tail.replace(/^/gm, '      '));
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main();
