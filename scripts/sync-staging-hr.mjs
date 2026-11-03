// Reconcile STAGING's HR / org tables with PRODUCTION. Reads production, writes staging.
//
//   node scripts/sync-staging-hr.mjs            # dry run — prints the drift, writes nothing
//   node scripts/sync-staging-hr.mjs --apply    # take pre-images, then write inside ONE transaction
//
// Exit codes: 0 = in sync (or applied) · 2 = drift found in a dry run · 1 = error.
// The 2 makes a scheduled dry run useful on its own: it answers "has staging drifted?" without
// touching anything.
//
// WHY THIS EXISTS. Staging is a real clone of production, and it silently falls behind: on
// 2026-09-29 it was missing 19 employees, 13 resignations, 36 occupancy rows, 4 line-area rows,
// 2 areas, 5 teams and a position. That is not cosmetic — it made a dated territory migration
// fail its own precondition on staging while succeeding on production, and it means any staging
// rehearsal of payroll, org or sales-geography behaviour was running against a different company.
//
// WHAT MAKES IT SAFE.
//   - Direction is fixed and asserted: production is only ever READ, staging is only ever WRITTEN,
//     and both project refs are checked against the known ones before a single row moves.
//   - Tables are walked in FK dependency order, parents first.
//   - Primary keys are DISCOVERED from the catalog, never assumed, and composite keys are normal
//     here (au.line_area_map keys on line_code + area_code + effective_from).
//   - Rows that exist only on STAGING are reported and NEVER deleted.
//   - Everything happens in one transaction, after a full pre-image copy of every table touched.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

/** The two projects this script is allowed to touch (AGENTS.md section 3). */
export const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
export const STAGING_REF = "cifwmndunmlxjhyjugxa";

/**
 * FK dependency order — parents before children. Each entry names the tables it depends on, so
 * the ordering is checkable rather than a comment that rots (see tests/staging-hr-sync.test.ts).
 */
export const TABLES = [
  { schema: "public", table: "departments", dependsOn: [] },
  { schema: "public", table: "lines", dependsOn: ["public.departments"] },
  { schema: "public", table: "areas", dependsOn: ["public.lines"] },
  { schema: "public", table: "teams", dependsOn: ["public.areas"] },
  { schema: "public", table: "positions", dependsOn: ["public.areas", "public.departments", "public.lines", "public.teams"] },
  { schema: "au", table: "regions", dependsOn: [] },
  { schema: "au", table: "lines", dependsOn: [] },
  { schema: "au", table: "canonical_areas", dependsOn: [] },
  { schema: "au", table: "seats", dependsOn: ["au.canonical_areas", "au.lines", "au.regions"] },
  { schema: "au", table: "line_area_map", dependsOn: ["au.canonical_areas", "au.lines", "au.regions", "au.seats"] },
  { schema: "public", table: "employees", dependsOn: ["public.areas", "public.departments", "public.lines", "public.positions", "public.teams"] },
  { schema: "au", table: "occupancy_history", dependsOn: ["au.seats"] },
];

/**
 * Nullable UNIQUE columns, measured from pg_index on production.
 *
 * Production legitimately reuses a CRM slot when someone leaves (owner-confirmed), so the same
 * crm_id can belong to a different person on each side. The value has to be released before it
 * can be reassigned inside the same transaction.
 */
export const NULLABLE_UNIQUES = {
  "public.employees": ["crm_id", "crm_username", "work_email"],
};

/**
 * Indexes dropped for the duration of the transaction and REBUILT before it commits.
 *
 * au.occupancy_history carries UNIQUE (seat_id) WHERE effective_to IS NULL — one open span per
 * seat. Production reached its current state through a sequence of closes and opens; replaying
 * those rows in ANY single order passes through states where a seat briefly has two open spans.
 * Dropping the index for the transaction allows the transient state; rebuilding it before commit
 * IS the assertion that the final state is legal — if it were not, the rebuild fails and the
 * whole transaction rolls back.
 */
export const DEFER_INDEXES = {
  "au.occupancy_history": [{
    drop: "drop index au.occupancy_open_span",
    create: "create unique index occupancy_open_span on au.occupancy_history using btree (seat_id) where (effective_to is null)",
  }],
};

/** Every table is preceded by everything it depends on. Pure, so it is testable with no database. */
export function dependencyOrderProblems(tables = TABLES) {
  const seen = new Set();
  const problems = [];
  for (const entry of tables) {
    for (const parent of entry.dependsOn) {
      if (!seen.has(parent)) problems.push(`${entry.schema}.${entry.table} is synced before its parent ${parent}`);
    }
    seen.add(`${entry.schema}.${entry.table}`);
  }
  return problems;
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

/**
 * The direction guard. Named refs, checked before anything is read or written.
 *
 * Without this, one edited env file turns a staging refresh into a production overwrite, and
 * nothing else in the script would notice: every statement below is legal SQL against either
 * database.
 */
export function assertDirection(productionUrl, stagingUrl) {
  const prodRef = refOf(productionUrl);
  const stgRef = refOf(stagingUrl);
  if (prodRef !== PRODUCTION_REF) {
    throw new Error(`source is not production (${PRODUCTION_REF}); it resolves to ${prodRef ?? "an unrecognised ref"}`);
  }
  if (stgRef !== STAGING_REF) {
    throw new Error(`REFUSING TO WRITE: target is not staging (${STAGING_REF}); it resolves to ${stgRef ?? "an unrecognised ref"}`);
  }
  if (prodRef === stgRef) throw new Error("source and target are the same database");
}

export const norm = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const fingerprint = (row, cols) => JSON.stringify(cols.map((c) => norm(row[c])));

/**
 * The comparison itself, pure and shared.
 *
 * scripts/check-staging-hr-drift.mjs (the scheduled, read-only alarm) imports this so the alarm
 * and the fix can never disagree about what "drift" means — a reporter with its own slightly
 * different comparison would eventually say "in sync" about something the sync would change, or
 * the reverse, and there would be no way to tell which was right.
 */
export function diffRows(prodRows, stgRows, pk, compareCols) {
  const keyOf = (r) => JSON.stringify(pk.map((c) => norm(r[c])));
  const stgBy = new Map(stgRows.map((r) => [keyOf(r), r]));
  const prodKeys = new Set(prodRows.map(keyOf));
  const inserts = [];
  const updates = [];
  for (const p of prodRows) {
    const s = stgBy.get(keyOf(p));
    if (!s) inserts.push(p);
    else if (fingerprint(p, compareCols) !== fingerprint(s, compareCols)) {
      updates.push({ row: p, changed: compareCols.filter((c) => norm(p[c]) !== norm(s[c])) });
    }
  }
  return { inserts, updates, stagingOnly: stgRows.filter((s) => !prodKeys.has(keyOf(s))) };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const productionUrl = envVar("PHOENIX_PRODUCTION_DATABASE_URL");
  const stagingUrl = envVar("PHOENIX_STAGING_DATABASE_URL");
  assertDirection(productionUrl, stagingUrl);

  const orderProblems = dependencyOrderProblems();
  if (orderProblems.length) throw new Error(`TABLES is out of dependency order:\n  ${orderProblems.join("\n  ")}`);

  const prod = postgres(toPooler(productionUrl, "aws-1-eu-central-1.pooler.supabase.com"), { max: 1, prepare: false });
  const stg = postgres(toPooler(stagingUrl, "aws-0-eu-central-1.pooler.supabase.com"), { max: 1, prepare: false });

  async function meta(schema, table) {
    const [pkRow] = await prod`
      select (select string_agg(a.attname, ',' order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as pk
      from pg_constraint c
      where c.conrelid = ${`${schema}.${table}`}::regclass and c.contype = 'p'`;
    if (!pkRow?.pk) throw new Error(`no primary key on ${schema}.${table}`);
    const cols = (await prod`
      select column_name from information_schema.columns
      where table_schema = ${schema} and table_name = ${table} and is_generated = 'NEVER'
      order by ordinal_position`).map((r) => r.column_name);
    const selfRefs = (await prod`
      select (select string_agg(a.attname, ',' order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as col
      from pg_constraint c
      where c.conrelid = ${`${schema}.${table}`}::regclass and c.contype = 'f'
        and c.confrelid = c.conrelid`).map((r) => r.col).filter((c) => c && !c.includes(","));
    const [{ n: alwaysIdentity }] = await prod`
      select count(*)::int as n from information_schema.columns
      where table_schema = ${schema} and table_name = ${table}
        and is_identity = 'YES' and identity_generation = 'ALWAYS'`;
    return { pk: pkRow.pk.split(","), cols, selfRefs, overriding: alwaysIdentity > 0 };
  }

  async function plan(schema, table) {
    const { pk, cols, selfRefs, overriding } = await meta(schema, table);
    const ident = `${schema}.${table}`;
    const prodRows = await prod.unsafe(`select * from ${ident}`);
    const stgRows = await stg.unsafe(`select * from ${ident}`);
    const compare = cols.filter((c) => !pk.includes(c));
    const { inserts, updates, stagingOnly } = diffRows(prodRows, stgRows, pk, compare);
    inserts.sort((a, b) => (Number(a[pk[0]]) || 0) - (Number(b[pk[0]]) || 0));
    return {
      schema, table, pk, cols, selfRefs, overriding, inserts, updates, stagingOnly,
      prodCount: prodRows.length, stgCount: stgRows.length,
    };
  }

  function report(p) {
    const keyLabel = (r) => p.pk.map((c) => norm(r[c])).join("/");
    const quiet = !p.inserts.length && !p.updates.length && !p.stagingOnly.length;
    console.log(`${p.schema}.${p.table}`.padEnd(28)
      + `prod ${String(p.prodCount).padStart(4)} | staging ${String(p.stgCount).padStart(4)} | `
      + `+${p.inserts.length} ~${p.updates.length} only:${p.stagingOnly.length}${quiet ? "   (in sync)" : ""}`);
    if (p.inserts.length) console.log(`    new: ${p.inserts.slice(0, 12).map(keyLabel).join(", ")}${p.inserts.length > 12 ? ` +${p.inserts.length - 12} more` : ""}`);
    if (p.stagingOnly.length) console.log(`    STAGING-ONLY, left alone: ${p.stagingOnly.map(keyLabel).join(", ")}`);
    const counts = new Map();
    for (const u of p.updates) for (const c of u.changed) counts.set(c, (counts.get(c) || 0) + 1);
    if (counts.size) {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      console.log(`    differs: ${top.map(([c, n]) => `${c}(${n})`).join(", ")}${counts.size > 6 ? ` +${counts.size - 6} more` : ""}`);
    }
  }

  try {
    console.log(`source production ${PRODUCTION_REF} (read only)  ->  target staging ${STAGING_REF}\n`);
    const plans = [];
    for (const { schema, table } of TABLES) plans.push(await plan(schema, table));
    plans.forEach(report);

    const totals = plans.reduce((a, p) => ({
      ins: a.ins + p.inserts.length, upd: a.upd + p.updates.length, only: a.only + p.stagingOnly.length,
    }), { ins: 0, upd: 0, only: 0 });
    console.log(`\nTOTAL: ${totals.ins} inserts, ${totals.upd} updates, ${totals.only} staging-only rows left alone`);

    if (!apply) {
      if (totals.ins === 0 && totals.upd === 0) {
        console.log("staging is IN SYNC with production — nothing to do.");
        return 0;
      }
      console.log("DRY RUN — nothing written. Re-run with --apply to execute.");
      return 2;
    }
    if (totals.ins === 0 && totals.upd === 0) {
      console.log("nothing to apply — staging is already in sync.");
      return 0;
    }

    console.log(`\npre-images into staging_reconcile_backup_${stamp}:`);
    await stg.unsafe(`create schema if not exists staging_reconcile_backup_${stamp}`);
    for (const p of plans) {
      const dest = `staging_reconcile_backup_${stamp}.${p.schema}_${p.table}_pre`;
      await stg.unsafe(`drop table if exists ${dest}`);
      await stg.unsafe(`create table ${dest} as select * from ${p.schema}.${p.table}`);
    }
    console.log(`  ${plans.length} tables copied`);

    console.log("\nwriting (one transaction):");
    await stg.begin(async (tx) => {
      // USER TRIGGERS OFF FOR THE COPY — the single most important line in this script.
      //
      // public.employees auto-fills a vacant seat on insert and writes its OWN
      // au.occupancy_history row from the identity sequence
      // (phx_employee_insert_autofill_replacement_vacancy and friends). Correct for a real hire,
      // wrong for a replay: production already ran those triggers and their effects are inside
      // the rows being copied. Left on, staging gets production's history PLUS a second,
      // invented set, and the sequence-generated ids collide with the explicit ids being
      // restored. Disabling is transactional and rolls back with everything else. FOREIGN KEYS
      // STAY ENFORCED — only triggers are suspended.
      for (const { schema, table } of TABLES) await tx.unsafe(`alter table ${schema}.${table} disable trigger user`);

      for (const p of plans) {
        const ident = `${p.schema}.${p.table}`;
        const deferred = [];
        const touched = p.inserts.length || p.updates.length;
        const deferIdx = touched ? (DEFER_INDEXES[ident] ?? []) : [];
        for (const ix of deferIdx) await tx.unsafe(ix.drop);

        for (const col of NULLABLE_UNIQUES[ident] ?? []) {
          const keys = p.updates.filter((u) => u.changed.includes(col)).map((u) => u.row[p.pk[0]]);
          if (keys.length) await tx.unsafe(`update ${ident} set "${col}" = null where "${p.pk[0]}" = any($1)`, [keys]);
        }

        // UPDATES BEFORE INSERTS — load-bearing. Closing a span frees the one-open-span slot that
        // the inserted span then takes, and freeing a reused crm_id must precede reassigning it.
        for (const { row, changed } of p.updates) {
          // A self-referencing column is deferred on updates too: production may point an
          // existing person at a manager who is one of the rows still to be inserted.
          if (changed.some((c) => p.selfRefs.includes(c))) deferred.push(row);
          const plain = changed.filter((c) => !p.selfRefs.includes(c));
          if (!plain.length) continue;
          const where = p.pk.map((c, i) => `"${c}" = $${plain.length + i + 1}`).join(" and ");
          await tx.unsafe(
            `update ${ident} set ${plain.map((c, i) => `"${c}" = $${i + 1}`).join(", ")} where ${where}`,
            [...plain.map((c) => row[c]), ...p.pk.map((c) => row[c])],
          );
        }
        for (const row of p.inserts) {
          if (p.selfRefs.some((c) => row[c] !== null && row[c] !== undefined)) deferred.push(row);
          await tx.unsafe(
            `insert into ${ident} (${p.cols.map((c) => `"${c}"`).join(",")})`
              + `${p.overriding ? " overriding system value" : ""}`
              + ` values (${p.cols.map((_, i) => `$${i + 1}`).join(",")})`,
            p.cols.map((c) => (p.selfRefs.includes(c) ? null : row[c])),
          );
        }
        for (const row of deferred) {
          const where = p.pk.map((c, i) => `"${c}" = $${p.selfRefs.length + i + 1}`).join(" and ");
          await tx.unsafe(
            `update ${ident} set ${p.selfRefs.map((c, i) => `"${c}" = $${i + 1}`).join(", ")} where ${where}`,
            [...p.selfRefs.map((c) => row[c]), ...p.pk.map((c) => row[c])],
          );
        }

        // Rebuild before commit: this is the assertion that the final state is legal.
        for (const ix of deferIdx) await tx.unsafe(ix.create);
        if (touched) console.log(`  ${ident}: ~${p.updates.length} then +${p.inserts.length}`);
      }

      for (const { schema, table } of TABLES) await tx.unsafe(`alter table ${schema}.${table} enable trigger user`);
    });

    // Explicit ids were inserted, so any identity sequence is now behind the data.
    for (const p of plans) {
      if (p.pk.length !== 1) continue;
      const [{ seq }] = await stg.unsafe(`select pg_get_serial_sequence('${p.schema}.${p.table}', '${p.pk[0]}') as seq`);
      if (!seq) continue; // natural text key, no sequence to advance
      const [{ v }] = await stg.unsafe(`select setval('${seq}', (select max("${p.pk[0]}") from ${p.schema}.${p.table})) as v`);
      console.log(`  sequence ${seq} -> ${v}`);
    }

    // Re-run the SAME diff that planned the work. A clean pass means every row production has,
    // staging now has identically — reusing tested code rather than a second comparison that
    // could agree for the wrong reason.
    console.log("\nverify — re-reading both databases and re-diffing:");
    let clean = true;
    for (const { schema, table } of TABLES) {
      const after = await plan(schema, table);
      const ok = after.inserts.length === 0 && after.updates.length === 0;
      if (!ok) clean = false;
      console.log(`  ${schema}.${table}`.padEnd(30) + `remaining +${after.inserts.length} ~${after.updates.length} -> ${ok ? "IN SYNC" : "STILL DIFFERENT"}`);
    }
    if (!clean) {
      console.log("\nSOME TABLES STILL DIFFER — read above. The pre-images are in staging_reconcile_backup_" + stamp);
      return 1;
    }
    console.log("\nALL TABLES IN SYNC");
    return 0;
  } finally {
    await prod.end({ timeout: 5 });
    await stg.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
