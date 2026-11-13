// Export one snapshot schema from PRODUCTION to dated CSV files on this machine, before it is dropped.
//
//   node scripts/export-backup-schema.mjs <schema>
//   node scripts/export-backup-schema.mjs <schema> --out <folder>
//
// Writes <out>/<schema>/<table>.csv for every table, plus manifest.json: each table's row count,
// column list, byte size and SHA-256, the export time, and the production ref read from. The audit
// (scripts/audit-backup-schemas.mjs) prints no drop statement for an "export-then-drop" schema until
// that manifest exists.
//
// Only a schema the owner has decided "export-then-drop" in scripts/backup-schema-decisions.json is
// exported — this is the first half of his decision, not a general dump tool. It only READS the
// database. Default folder: PHOENIX_SNAPSHOT_EXPORT_DIR, else `snapshot-exports` beside the repo,
// which is outside every checkout on purpose: this repository is public and these files hold real
// business data, so they must never be committed.
//
// Exit codes: 0 = exported and verified · 1 = error.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { EXPORT_ROOT, PRODUCTION_REF, envVar, readDecisions, refOf, toPooler } from "./audit-backup-schemas.mjs";

/** One CSV field: null is empty, objects are JSON, anything with a comma, quote or newline is quoted. */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const schema = argv[0];
  const outIndex = argv.indexOf("--out");
  const root = outIndex >= 0 ? argv[outIndex + 1] : EXPORT_ROOT;
  const known = new Set(["--out"]);
  for (const a of argv.slice(1)) {
    if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
  }
  if (!schema || !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("usage: node scripts/export-backup-schema.mjs <schema> [--out <folder>]");

  const decision = readDecisions()[schema];
  if (decision?.decision !== "export-then-drop") {
    throw new Error(`${schema} is not decided "export-then-drop" in scripts/backup-schema-decisions.json — nothing exported`);
  }

  const rawUrl = envVar("PHOENIX_PRODUCTION_DATABASE_URL");
  if (refOf(rawUrl) !== PRODUCTION_REF) throw new Error(`the production URL does not resolve to ${PRODUCTION_REF}`);
  const sql = postgres(toPooler(rawUrl, "aws-1-eu-central-1.pooler.supabase.com"), { max: 1, prepare: false });

  const dir = path.join(root, schema);
  mkdirSync(dir, { recursive: true });
  const manifest = { schema, ref: PRODUCTION_REF, exportedAt: new Date().toISOString(), decision, tables: [] };
  try {
    const tables = await sql`
      select c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = ${schema} and c.relkind in ('r', 'p')
       order by c.relname`;
    if (tables.length === 0) throw new Error(`${schema} has no tables on production — is the name right?`);

    for (const { name } of tables) {
      const columns = (await sql`
        select attname from pg_attribute
         where attrelid = ${`${schema}.${name}`}::regclass and attnum > 0 and not attisdropped
         order by attnum`).map((r) => r.attname);
      const rows = await sql`select * from ${sql(schema)}.${sql(name)}`;
      const csv = toCsv(columns, rows);
      const file = path.join(dir, `${name}.csv`);
      writeFileSync(file, csv, "utf8");

      // Read it back: the manifest describes the file on disk, not the buffer that was meant to be written.
      const onDisk = readFileSync(file);
      const [{ count }] = await sql`select count(*)::int as count from ${sql(schema)}.${sql(name)}`;
      if (count !== rows.length) throw new Error(`${schema}.${name}: read ${rows.length} rows but the table now holds ${count}`);
      manifest.tables.push({
        table: name,
        rows: rows.length,
        columns,
        bytes: onDisk.length,
        sha256: createHash("sha256").update(onDisk).digest("hex"),
      });
      console.log(`${schema}.${name}: ${rows.length} rows -> ${file}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const total = manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(`EXPORTED ${schema}: ${manifest.tables.length} table(s), ${total} row(s) -> ${dir}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(String(error?.message ?? error));
      process.exit(1);
    });
}
