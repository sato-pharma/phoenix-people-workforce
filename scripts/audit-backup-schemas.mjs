// Classify every ad-hoc backup / rollback / analysis schema on a Phoenix database — and every
// dated snapshot TABLE sitting in `public` or `au` — and say which ones have outlived their purpose.
//
//   node scripts/audit-backup-schemas.mjs                      # production, human readable
//   node scripts/audit-backup-schemas.mjs --database staging
//   node scripts/audit-backup-schemas.mjs --retention-days 60
//   node scripts/audit-backup-schemas.mjs --json
//
// Exit codes: 0 = nothing has expired · 2 = an expired schema OR snapshot table found · 1 = error.
//
// 🔴 THIS SCRIPT NEVER DROPS ANYTHING, AND THERE IS NO FLAG THAT MAKES IT.
// Production has no point-in-time recovery — seven daily backups are the entire recovery story
// (AGENTS.md section 2.3). A schema dropped in error is therefore recoverable for seven days and
// only by restoring a backup into a SEPARATE project to extract from. That is not a risk worth
// automating away for 81 MB. The script prints the `drop schema` statements; a human runs them
// under supervision, with the dependency checks re-read live at that moment.
//
// WHY THIS EXISTS. On 2026-09-29 production carried 99 non-standard schemas holding 81 MB. Not
// one of them had an expiry: `docs/security/backup-table-placement.md` says where a snapshot goes
// and that "dropping the snapshot is the real end state", but nothing said WHEN, so nothing ever
// did. They accumulate at roughly three a day and the population only grows. The problem this
// solves is unbounded accumulation, not disk — 81 MB of a 2,499 MB database is 3.2%.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

export const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
export const STAGING_REF = "cifwmndunmlxjhyjugxa";

/**
 * How long a snapshot is kept, counted from the date in its name.
 *
 * 90 days is deliberately generous. The argument for a much shorter number is real: a pre-image
 * exists to undo a change, and once the monthly closing that the change fed has been published
 * and announced it can never lawfully be used, because a published month is never corrected
 * (AGENTS.md section 4). That reasoning lands at roughly 35-60 days.
 *
 * It is set at 90 anyway, because the cost of the two mistakes is wildly asymmetric. Keeping a
 * dead schema too long costs a few megabytes on a database where all of them together are 3.2%.
 * Dropping a live one too early costs data that has no point-in-time recovery behind it. So the
 * number is set where it cannot plausibly be the reason a rollback was impossible, and its job
 * is to cap the population at ninety days of accumulation instead of forever.
 *
 * Lower it with --retention-days once the first cycle has run and nothing was missed.
 */
export const RETENTION_DAYS = 90;

/** Schemas that are not snapshots at all, and the reason each is not. */
/** @type {Record<string, { kind: "live" | "migration" | "owner", why: string }>} */
export const EXEMPT_SCHEMAS = {
  // Live application schemas.
  analytics: { kind: "live", why: "26 views; eight public functions read them" },
  private: { kind: "live", why: "14 security-definer helper functions behind RLS" },

  // Created and owned by tracked migrations, so a database rebuilt from migrations has them.
  internal: { kind: "migration", why: "phoenix_date_offset_repair_audit, in the schema baseline" },
  _au_rollback: { kind: "migration", why: "named by 20260719220000_advisor_center_primary_keys" },

  // Permanent infrastructure, not a snapshot: the hourly undo log for the money tables, created
  // by 20260929200500_recovery_snapshot_store. It carries no date in its name precisely so the
  // rule above cannot age it out, but without this entry it would be reported UNDATED forever.
  recovery: { kind: "migration", why: "the hourly recovery undo log; permanent, never expires" },

  // The owner's own decisions. Each has a condition, not a date — none expires on its own.
  hr_backup_20260829: { kind: "owner", why: "C13 pre-image; retire only once September payroll proves the 08-29 fixes" },
  crm_backup_20260828: { kind: "owner", why: "C13 pre-image; retire only once September payroll proves the 08-29 fixes" },
  delta3_defer_backup_20260829: { kind: "owner", why: "holds line_area_map_pre — the owner's standing instruction is to keep it" },
};

/** Schemas every Postgres/Supabase database has. Nothing here is ever a snapshot. */
export const STANDARD_SCHEMAS = new Set([
  "pg_catalog", "information_schema", "public", "auth", "storage", "graphql", "graphql_public",
  "realtime", "_realtime", "supabase_functions", "supabase_migrations", "extensions", "vault",
  "pgbouncer", "net", "cron", "pgsodium", "pgsodium_masks", "au", "pg_toast",
]);

export const VERDICT = {
  LIVE: "LIVE",            // not a snapshot
  PINNED: "PINNED",        // something in the live database depends on it
  PROTECTED: "PROTECTED",  // the owner's decision, or a migration owns it
  UNDATED: "UNDATED",      // no date anywhere — it can never expire, so a human must look
  YOUNG: "YOUNG",          // inside the retention window
  EXPIRED: "EXPIRED",      // past retention, nothing depends on it
};

/**
 * Every valid YYYYMMDD / YYYY_MM_DD / YYYY-MM-DD in a string, as ISO dates.
 *
 * Invalid dates are skipped rather than clamped: `_20261301` is not December 1st with a stray 3,
 * it is not a date at all, and treating it as one would invent an expiry.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function datesIn(text) {
  const out = [];
  const re = /20(\d{2})[-_]?(\d{2})[-_]?(\d{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, yy, mm, dd] = m;
    const year = 2000 + Number(yy);
    const month = Number(mm);
    const day = Number(dd);
    const iso = `${year}-${mm}-${dd}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) continue;
    if (parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) continue;
    out.push(iso);
  }
  return out;
}

/**
 * The date a snapshot was taken: the one in the schema name, else the NEWEST one among its table
 * names.
 *
 * The fallback matters more than it looks. Five schemas on production carry no date in the name —
 * `ops_backup`, `marketing_rollback`, `map_audit_baseline`, `plan_backups`, `_au_rollback` — and
 * between them they hold 43% of all backup bytes. Three of the five name dates on their TABLES
 * (`ops_backup.v2_vacation_requests_a10_pre_paidfix_20260917`), so they can be aged after all.
 * The newest is the right one: a schema reused for a later snapshot is only as expired as its
 * most recent contents.
 *
 * @param {string} schemaName
 * @param {string[]} [tableNames]
 * @returns {string | null}
 */
export function snapshotDateOf(schemaName, tableNames = []) {
  const fromSchema = datesIn(schemaName);
  if (fromSchema.length > 0) return fromSchema.sort().at(-1);
  const fromTables = tableNames.flatMap((t) => datesIn(t));
  if (fromTables.length > 0) return fromTables.sort().at(-1);
  return null;
}

/**
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number}
 */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The verdict for one schema. Pure — everything it needs is in the arguments.
 *
 * 🔴 ORDER IS THE SAFETY PROPERTY. A live dependency is checked BEFORE age, so no schema is ever
 * called expired while something references it, however old it is. That is not theoretical here:
 * `deductions_governance_backup_20260830` was a month old and the live table
 * `public.private_calendar_no_activity_clarifications` held a foreign key into it, so a sweep
 * that went by name and age would have taken production's referential integrity with it. That one
 * was dropped by 20261009213000_drop_clarifications_fk_into_deductions_backup.sql; the ordering
 * stays, because the next such dependency will not announce itself.
 *
 * @param {{ schema: string, tables?: string[], blockers?: string[] }} entry
 * @param {{ today: string, retentionDays?: number }} options
 * @returns {{ verdict: string, reason: string, date: string | null, ageDays: number | null }}
 */
export function classify(entry, options) {
  const { schema, tables = [], blockers = [] } = entry;
  const { today, retentionDays = RETENTION_DAYS } = options;

  const exempt = EXEMPT_SCHEMAS[schema];
  if (exempt?.kind === "live") {
    return { verdict: VERDICT.LIVE, reason: exempt.why, date: null, ageDays: null };
  }

  if (blockers.length > 0) {
    return { verdict: VERDICT.PINNED, reason: blockers.join("; "), date: null, ageDays: null };
  }

  if (exempt) {
    return { verdict: VERDICT.PROTECTED, reason: exempt.why, date: null, ageDays: null };
  }

  const date = snapshotDateOf(schema, tables);
  if (date === null) {
    return {
      verdict: VERDICT.UNDATED,
      reason: "no date in the schema name or any table name — it can never expire; date it or drop it deliberately",
      date: null,
      ageDays: null,
    };
  }

  const ageDays = daysBetween(date, today);
  if (ageDays < retentionDays) {
    return { verdict: VERDICT.YOUNG, reason: `${retentionDays - ageDays} days left`, date, ageDays };
  }
  return { verdict: VERDICT.EXPIRED, reason: `${ageDays} days old, retention is ${retentionDays}`, date, ageDays };
}

/**
 * Standard schemas that nonetheless host ad-hoc snapshot TABLES.
 *
 * 🔴 WHY THIS EXISTS. Everything above sweeps non-standard SCHEMAS, and `public` and `au` are both
 * on STANDARD_SCHEMAS — so a pre-image taken as a dated table next to the live data was outside
 * this script's reach entirely and could never expire. That is not hypothetical: it was found on
 * 2026-10-13 while triaging `rls_enabled_no_policy`, which had just been raised 210 → 212 by
 * `public.address_brick_moves_20261013` and already carried `public.sos_map_unmap_preimage_20261010`
 * and `au.bak_20261008_luxor_notes_fix`. The baseline doc said the snapshots "leave the count by
 * themselves as their schemas pass retention"; for these there was no schema to pass, so they were
 * a standing ratchet on an advisor count AND on the population this script exists to cap.
 *
 * `docs/security/backup-table-placement.md` says a snapshot belongs in a dated schema. These are
 * the ones that did not, reported where they live rather than pretended out of existence.
 */
export const SNAPSHOT_TABLE_SCHEMAS = ["public", "au"];

/**
 * Snapshot tables the owner keeps on a condition rather than a date. Same shape as EXEMPT_SCHEMAS,
 * deliberately empty: nothing is exempt until he says so, and an entry here is his decision.
 */
/** @type {Record<string, { why: string }>} */
export const EXEMPT_SNAPSHOT_TABLES = {};

/** A dated name whose date sits at the very END — the shape of an ad-hoc copy. */
const TRAILING_DATE = /20\d{2}[-_]?\d{2}[-_]?\d{2}$/;

/**
 * The words a snapshot is named with, as whole underscore-delimited parts.
 *
 * 🔴 Whole parts, never substrings: `pre` as a substring matches `prepared`, `price` and
 * `prescription`, and `old` matches `household`. That is the same mistake the function-dependency
 * query above documents — a match in the right bucket for the wrong reason is worse than no match,
 * because it teaches you to skim the reasons.
 */
const SNAPSHOT_TOKENS =
  /(?:^|_)(?:bak|backup|backups|rollback|pre|preimage|pre_image|snapshot|snap|old|orig|copy|archive|before|undo|deprecated)(?:_|$)/i;

/**
 * Is this the name of an ad-hoc snapshot table rather than live data?
 *
 * A DATE IS REQUIRED EITHER WAY — without one there is nothing to age, and a table that can never
 * expire is not something to propose dropping. Given a date, either shape qualifies: the date at
 * the end (`address_brick_moves_20261013`) or a snapshot word anywhere
 * (`bak_20261008_luxor_notes_fix`, `sos_map_unmap_preimage_20261010`).
 *
 * A false positive here costs one line of output asking a human to look, because this script drops
 * nothing. A false negative is what let three of these sit unswept, so the test is deliberately the
 * looser of the two — and `relispartition` is excluded in SQL, which is what keeps a daily partition
 * like `events_20261013` out of it.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSnapshotTableName(name) {
  if (datesIn(name).length === 0) return false;
  return TRAILING_DATE.test(name) || SNAPSHOT_TOKENS.test(name);
}

/**
 * The verdict for one snapshot table. Pure, and the same ladder as `classify`.
 *
 * 🔴 THE SAME ORDERING SAFETY: a live dependency beats age, always. The schema sweep learned that
 * from `deductions_governance_backup_20260830`, which a live foreign key pinned at a month old; a
 * table in `public` is MORE exposed to that, not less, because the live tables sit beside it.
 *
 * @param {{ schema: string, table: string, blockers?: string[] }} entry
 * @param {{ today: string, retentionDays?: number }} options
 * @returns {{ verdict: string, reason: string, date: string | null, ageDays: number | null }}
 */
export function classifyTable(entry, options) {
  const { schema, table, blockers = [] } = entry;
  const { today, retentionDays = RETENTION_DAYS } = options;

  if (blockers.length > 0) {
    return { verdict: VERDICT.PINNED, reason: blockers.join("; "), date: null, ageDays: null };
  }

  const exempt = EXEMPT_SNAPSHOT_TABLES[`${schema}.${table}`];
  if (exempt) {
    return { verdict: VERDICT.PROTECTED, reason: exempt.why, date: null, ageDays: null };
  }

  const date = datesIn(table).sort().at(-1) ?? null;
  if (date === null) {
    return {
      verdict: VERDICT.UNDATED,
      reason: "no date in the table name — it can never expire; date it or drop it deliberately",
      date: null,
      ageDays: null,
    };
  }

  const ageDays = daysBetween(date, today);
  if (ageDays < retentionDays) {
    return { verdict: VERDICT.YOUNG, reason: `${retentionDays - ageDays} days left`, date, ageDays };
  }
  return { verdict: VERDICT.EXPIRED, reason: `${ageDays} days old, retention is ${retentionDays}`, date, ageDays };
}

const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];

function envVar(name) {
  // The nightly check runs on GitHub, where the secrets arrive in the environment and no env file exists.
  if (process.env[name]) return process.env[name];
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  throw new Error(`missing ${name} — run this from the repo root, where the env files are`);
}

/** The pooler REGION cannot be derived from the ref: production is aws-1, staging aws-0. */
function toPooler(raw, host) {
  const m = /^(\w+):\/\/([^:]+):([^@]+)@db\.([a-z0-9]+)\.supabase\.co:(\d+)\/(.+)$/.exec(raw);
  if (!m) return raw;
  const [, scheme, user, pass, ref, , db] = m;
  return `${scheme}://${user}.${ref}:${pass}@${host}:5432/${db}`;
}

export function refOf(url) {
  return /db\.([a-z0-9]{20})\.supabase\.co/.exec(url)?.[1]
    ?? /postgres\.([a-z0-9]{20}):/.exec(url)?.[1]
    ?? null;
}

function formatBytes(n) {
  const b = Number(n);
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} kB`;
  return `${b} B`;
}

/** Read the catalogue. Everything the classifier needs, in four queries. */
export async function readCatalogue(sql) {
  const standard = [...STANDARD_SCHEMAS];

  const schemas = await sql`
    select n.nspname as schema,
           coalesce(sum(pg_total_relation_size(c.oid)) filter (where c.relkind in ('r','p','v','m')), 0)::bigint as size_bytes,
           coalesce(array_agg(c.relname order by c.relname) filter (where c.relkind in ('r','p')), '{}') as tables,
           count(*) filter (where c.relkind in ('v','m')) as views
    from pg_namespace n
    left join pg_class c on c.relnamespace = n.oid
    where n.nspname <> all(${standard})
      and n.nspname not like 'pg\\_temp%'
      and n.nspname not like 'pg\\_toast\\_temp%'
    group by n.nspname
    order by 2 desc`;

  // 1. A foreign key from OUTSIDE the schema pointing INTO it. Dropping it breaks the live table.
  const fks = await sql`
    select tgtn.nspname as schema,
           'foreign key ' || con.conname || ' on ' || srcn.nspname || '.' || src.relname || ' points into it' as blocker
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_namespace srcn on srcn.oid = src.relnamespace
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace tgtn on tgtn.oid = tgt.relnamespace
    where con.contype = 'f' and srcn.nspname <> tgtn.nspname
      and tgtn.nspname <> all(${standard})`;

  // 2. A view or materialised view built on one of its tables.
  const views = await sql`
    select distinct tn.nspname as schema,
           'view ' || vn.nspname || '.' || v.relname || ' reads it' as blocker
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class
    join pg_namespace vn on vn.oid = v.relnamespace
    join pg_class t on t.oid = d.refobjid
    join pg_namespace tn on tn.oid = t.relnamespace
    where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
      and vn.oid <> tn.oid and tn.nspname <> all(${standard})`;

  // 3. A function whose body names the schema in a SCHEMA-QUALIFIED reference — `<schema>.`, not
  //    the bare word.
  //
  //    🔴 The bare word was tried first and it is useless: several schemas here are named after
  //    ordinary English words, so `internal` matched the word "internal" inside Supabase's own
  //    `realtime.apply_rls` and `storage.search` and was reported as pinned by two functions that
  //    have nothing to do with it. That lands in the right bucket for the wrong reason, which is
  //    worse than not checking — it masks the real classification and teaches you to skim the
  //    reasons. A dependency is always written `schema.object`, so the dot is what makes it one.
  const funcs = await sql`
    select distinct n.nspname as schema,
           'function ' || pn.nspname || '.' || p.proname || ' references it' as blocker
    from pg_proc p
    join pg_namespace pn on pn.oid = p.pronamespace
    join pg_namespace n on p.prosrc ~ ('\\m' || n.nspname || '\\.')
    where n.nspname <> all(${standard})
      and n.nspname not like 'pg\\_temp%'
      and pn.nspname <> n.nspname`;

  const blockers = new Map();
  for (const row of [...fks, ...views, ...funcs]) {
    if (!blockers.has(row.schema)) blockers.set(row.schema, []);
    blockers.get(row.schema).push(row.blocker);
  }

  return schemas.map((s) => ({
    schema: s.schema,
    tables: s.tables ?? [],
    views: Number(s.views),
    sizeBytes: Number(s.size_bytes),
    blockers: blockers.get(s.schema) ?? [],
  }));
}

/**
 * Read the dated snapshot TABLES living in the standard schemas, with what depends on each.
 *
 * Two round trips on purpose: the dependency queries are asked about the candidate names, which
 * are only known after the first read.
 */
export async function readSnapshotTables(sql) {
  const schemas = SNAPSHOT_TABLE_SCHEMAS;

  // A partitioned child is excluded here, not later: `events_20261013` is a daily partition, not a
  // snapshot, and it is the one shape the name test cannot tell apart.
  const rows = await sql`
    select n.nspname as schema,
           c.relname as name,
           pg_total_relation_size(c.oid)::bigint as size_bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any(${schemas})
      and c.relkind in ('r', 'p')
      and c.relispartition = false
      and c.relname ~ '20[0-9]{2}[-_]?[0-9]{2}[-_]?[0-9]{2}'
    order by 3 desc`;

  const candidates = rows.filter((r) => isSnapshotTableName(r.name));
  if (candidates.length === 0) return [];
  const names = candidates.map((r) => r.name);

  // 1. A foreign key from ANOTHER table pointing into it.
  const fks = await sql`
    select tgt.relname as name,
           'foreign key ' || con.conname || ' on ' || srcn.nspname || '.' || src.relname || ' points into it' as blocker
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_namespace srcn on srcn.oid = src.relnamespace
    join pg_class tgt on tgt.oid = con.confrelid
    where con.contype = 'f' and src.oid <> tgt.oid and tgt.relname = any(${names})`;

  // 2. A view or materialised view reading it.
  const views = await sql`
    select distinct t.relname as name,
           'view ' || vn.nspname || '.' || v.relname || ' reads it' as blocker
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class
    join pg_namespace vn on vn.oid = v.relnamespace
    join pg_class t on t.oid = d.refobjid
    where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
      and v.oid <> t.oid and t.relname = any(${names})`;

  // 3. A function whose body names it.
  //
  //    The schema sweep above refuses a bare-word match, and rightly — `internal` matched the
  //    English word inside Supabase's own functions. Here the bare name is safe for the one reason
  //    that makes it so: every candidate carries a DATE, so `address_brick_moves_20261013` cannot
  //    collide with prose. Matched as a whole word all the same.
  const funcs = await sql`
    select distinct t.name,
           'function ' || pn.nspname || '.' || p.proname || ' names it' as blocker
    from pg_proc p
    join pg_namespace pn on pn.oid = p.pronamespace
    cross join unnest(${names}::text[]) as t(name)
    where p.prosrc is not null and p.prosrc ~ ('\\m' || t.name || '\\M')`;

  const blockers = new Map();
  for (const row of [...fks, ...views, ...funcs]) {
    if (!blockers.has(row.name)) blockers.set(row.name, []);
    blockers.get(row.name).push(row.blocker);
  }

  return candidates.map((r) => ({
    schema: r.schema,
    table: r.name,
    sizeBytes: Number(r.size_bytes),
    blockers: blockers.get(r.name) ?? [],
  }));
}

const GROUPS = [
  [VERDICT.PINNED, "KEEP — a live object depends on it"],
  [VERDICT.LIVE, "KEEP — a live application schema, not a snapshot"],
  [VERDICT.PROTECTED, "KEEP — the owner's decision, or a migration owns it"],
  [VERDICT.UNDATED, "LOOK — undated, so it can never expire on its own"],
  [VERDICT.YOUNG, "KEEP — inside the retention window"],
  [VERDICT.EXPIRED, "EXPIRED — past retention, nothing depends on it"],
];

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const asJson = argv.includes("--json");
  const target = arg("--database", "production");
  const retentionDays = Number(arg("--retention-days", String(RETENTION_DAYS)));
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`--retention-days must be a positive number, got ${arg("--retention-days", "")}`);
  }
  if (target !== "production" && target !== "staging") {
    throw new Error(`--database must be production or staging, got ${target}`);
  }

  const rawUrl = target === "production"
    ? envVar("PHOENIX_PRODUCTION_DATABASE_URL")
    : envVar("PHOENIX_STAGING_DATABASE_URL");
  const expectedRef = target === "production" ? PRODUCTION_REF : STAGING_REF;
  const actualRef = refOf(rawUrl);
  if (actualRef !== expectedRef) {
    throw new Error(`${target} should be ref ${expectedRef}, but the URL resolves to ${actualRef ?? "an unrecognised ref"}`);
  }
  const host = target === "production"
    ? "aws-1-eu-central-1.pooler.supabase.com"
    : "aws-0-eu-central-1.pooler.supabase.com";

  const sql = postgres(toPooler(rawUrl, host), { max: 1, prepare: false });
  const today = new Date().toISOString().slice(0, 10);

  try {
    const catalogue = await readCatalogue(sql);
    const rows = catalogue
      .map((entry) => ({ ...entry, ...classify(entry, { today, retentionDays }) }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const tableRows = (await readSnapshotTables(sql))
      .map((entry) => ({ ...entry, ...classifyTable(entry, { today, retentionDays }) }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const expired = rows.filter((r) => r.verdict === VERDICT.EXPIRED);
    const expiredTables = tableRows.filter((r) => r.verdict === VERDICT.EXPIRED);

    if (asJson) {
      console.log(JSON.stringify(
        { database: target, ref: expectedRef, today, retentionDays, rows, snapshotTables: tableRows },
        null,
        2,
      ));
      return expired.length + expiredTables.length > 0 ? 2 : 0;
    }

    const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);
    console.log(`BACKUP SCHEMA RETENTION — ${target} (${expectedRef})`);
    console.log(`${today} · retention ${retentionDays} days · ${rows.length} non-standard schemas · ${formatBytes(totalBytes)}\n`);

    for (const [verdict, heading] of GROUPS) {
      const group = rows.filter((r) => r.verdict === verdict);
      if (group.length === 0) continue;
      const bytes = group.reduce((n, r) => n + r.sizeBytes, 0);
      console.log(`${heading} — ${group.length}, ${formatBytes(bytes)}`);
      for (const r of group) {
        const age = r.ageDays === null ? "" : ` ${r.date} (${r.ageDays}d)`;
        console.log(`  ${r.schema.padEnd(44)}${formatBytes(r.sizeBytes).padStart(9)}${age}`);
        console.log(`      ${r.reason}`);
      }
      console.log("");
    }

    if (tableRows.length > 0) {
      const tableBytes = tableRows.reduce((n, r) => n + r.sizeBytes, 0);
      console.log(`SNAPSHOT TABLES IN ${SNAPSHOT_TABLE_SCHEMAS.join(" / ")} — ${tableRows.length}, ${formatBytes(tableBytes)}`);
      console.log("  A dated snapshot that was taken as a TABLE beside the live data, so no schema");
      console.log("  of its own can ever age it out. backup-table-placement.md says it belongs in a");
      console.log("  dated schema; until it is moved or dropped, it is swept here.\n");
      for (const [verdict, heading] of GROUPS) {
        const group = tableRows.filter((r) => r.verdict === verdict);
        if (group.length === 0) continue;
        console.log(`  ${heading} — ${group.length}, ${formatBytes(group.reduce((n, r) => n + r.sizeBytes, 0))}`);
        for (const r of group) {
          const age = r.ageDays === null ? "" : ` ${r.date} (${r.ageDays}d)`;
          console.log(`    ${`${r.schema}.${r.table}`.padEnd(54)}${formatBytes(r.sizeBytes).padStart(9)}${age}`);
          console.log(`        ${r.reason}`);
        }
      }
      console.log("");
    }

    if (expired.length + expiredTables.length === 0) {
      console.log(
        `NOTHING HAS EXPIRED. ${rows.length} schemas and ${tableRows.length} snapshot tables, ` +
        `none past ${retentionDays} days with no dependency on it.`,
      );
      return 0;
    }

    console.log("TO DROP — run by hand, under supervision, re-reading the dependency checks first.");
    console.log("Production has no point-in-time recovery: seven daily backups are the whole story.\n");
    for (const r of expired) {
      console.log(`-- ${r.schema}: ${r.tables.length} table(s), ${formatBytes(r.sizeBytes)}, ${r.reason}`);
      console.log(`--   ${r.tables.join(", ") || "(no tables)"}`);
      console.log(`drop schema if exists ${r.schema} cascade;`);
    }
    // 🔴 No `cascade` on a table. The schema form has it because a snapshot schema is dropped whole;
    // a lone table sits in `public` BESIDE the live data, so a cascade there would silently take
    // whatever had come to depend on it. Without it the statement simply refuses, which is the
    // answer a human wants at that moment.
    for (const r of expiredTables) {
      console.log(`-- ${r.schema}.${r.table}: ${formatBytes(r.sizeBytes)}, ${r.reason}`);
      console.log(`drop table if exists ${r.schema}.${r.table};`);
    }
    const reclaimable = [...expired, ...expiredTables].reduce((n, r) => n + r.sizeBytes, 0);
    console.log(
      `\nTOTAL: ${expired.length} expired schema(s) and ${expiredTables.length} expired table(s), ` +
      `${formatBytes(reclaimable)} reclaimable.`,
    );
    return 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exit(1);
    });
}
