/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config({ path: ".env.local" });

// postgres.js, not `pg`. This script used to `require("pg")`, which has never been a
// dependency of this repo — so it died at load with MODULE_NOT_FOUND before running a single
// query. `postgres` IS a dependency and is what the other two SUPABASE_DB_URL scripts
// (audit-image-evidence-storage.ts, phase21-security-readiness-smoke.ts) already use, so
// standardising on it keeps one Postgres driver instead of adding a second.
const postgres = require("postgres");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.SUPABASE_DB_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL / POSTGRES_URL / SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const OUTPUT_DIR = path.join(process.cwd(), "supabase-export");
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  `supabase_full_export_${new Date().toISOString().slice(0, 10)}.xlsx`
);

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];
const usedSheetNames = new Set();

function safeSheetName(name) {
  let safeName = String(name || "sheet")
    .replace(/[\[\]\*\/\\\?\:]/g, "_")
    .substring(0, 25);

  if (!safeName.trim()) safeName = "sheet";

  let finalName = safeName;
  let counter = 1;

  while (usedSheetNames.has(finalName)) {
    const suffix = `_${counter}`;
    finalName = `${safeName.substring(0, 31 - suffix.length)}${suffix}`;
    counter++;
  }

  usedSheetNames.add(finalName);
  return finalName;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "object") {
    if (value instanceof Date) return value;
    return JSON.stringify(value);
  }

  return value;
}

function addRowsSheet(workbook, sheetName, rows) {
  const worksheet = workbook.addWorksheet(safeSheetName(sheetName));

  if (!rows || rows.length === 0) {
    worksheet.addRow(["No data found"]);
    return;
  }

  const columns = Object.keys(rows[0]);

  worksheet.columns = columns.map((col) => ({
    header: col,
    key: col,
    width: Math.min(Math.max(col.length + 4, 16), 45),
  }));

  rows.forEach((row) => {
    const normalizedRow = {};

    columns.forEach((col) => {
      normalizedRow[col] = normalizeCellValue(row[col]);
    });

    worksheet.addRow(normalizedRow);
  });

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  worksheet.autoFilter = {
    from: "A1",
    to: {
      row: 1,
      column: columns.length,
    },
  };
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // ssl: "require" encrypts but does not verify the cert chain — the direct equivalent of
  // the previous pg `ssl: { rejectUnauthorized: false }`, and what Supabase's pooler needs.
  // prepare: false so this works through Supabase's TRANSACTION pooler (port 6543) as well
  // as the session pooler (5432); transaction mode rejects prepared statements.
  // postgres.js connects lazily, so there is no explicit connect() step.
  const db = postgres(DATABASE_URL, {
    ssl: "require",
    max: 1,
    prepare: false,
  });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const queries = {
    "01_schemas": `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT LIKE 'pg_%'
      ORDER BY schema_name;
    `,

    "02_tables_and_views": `
      SELECT 
        table_schema,
        table_name,
        table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `,

    "03_columns": `
      SELECT 
        table_schema,
        table_name,
        column_name,
        ordinal_position,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position;
    `,

    "04_constraints": `
      SELECT
        tc.table_schema,
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_type;
    `,

    "05_indexes": `
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename, indexname;
    `,

    "06_rls_policies": `
      SELECT
        schemaname,
        tablename,
        policyname,
        permissive,
        roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      ORDER BY schemaname, tablename, policyname;
    `,

    "07_rls_enabled_tables": `
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, c.relname;
    `,

    "08_functions": `
      SELECT
        n.nspname AS schema_name,
        p.proname AS function_name,
        pg_get_function_arguments(p.oid) AS arguments,
        pg_get_function_result(p.oid) AS return_type,
        l.lanname AS language,
        p.prosecdef AS security_definer,
        pg_get_functiondef(p.oid) AS function_definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, p.proname;
    `,

    "09_triggers": `
      SELECT
        trigger_schema,
        event_object_schema,
        event_object_table,
        trigger_name,
        event_manipulation,
        action_timing,
        action_statement
      FROM information_schema.triggers
      WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY event_object_schema, event_object_table, trigger_name;
    `,

    "10_enum_types": `
      SELECT
        n.nspname AS schema_name,
        t.typname AS enum_name,
        e.enumlabel AS enum_value,
        e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      ORDER BY n.nspname, t.typname, e.enumsortorder;
    `,

    "11_extensions": `
      SELECT
        extname AS extension_name,
        extversion AS version,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY extname;
    `,

    "12_storage_buckets": `
      SELECT *
      FROM storage.buckets
      ORDER BY name;
    `,

    "13_auth_users_summary": `
      SELECT
        id,
        email,
        phone,
        role,
        aud,
        created_at,
        updated_at,
        last_sign_in_at,
        email_confirmed_at,
        phone_confirmed_at,
        banned_until
      FROM auth.users
      ORDER BY created_at DESC;
    `,
  };

  for (const [sheetName, sql] of Object.entries(queries)) {
    try {
      // .unsafe() runs a plain SQL string (these queries are static, not user input);
      // postgres.js resolves to the row array itself, not a { rows } wrapper.
      const result = await db.unsafe(sql);
      addRowsSheet(workbook, sheetName, result);
      console.log(`Added ${sheetName}`);
    } catch (error) {
      addRowsSheet(workbook, sheetName, [{ error: error.message }]);
      console.warn(`Failed ${sheetName}: ${error.message}`);
    }
  }

  const tablesResult = await db.unsafe(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name;
  `);

  for (const table of tablesResult) {
    const schema = table.table_schema;
    const tableName = table.table_name;

    if (SYSTEM_SCHEMAS.includes(schema)) continue;

    const sheetName = `data_${schema}_${tableName}`;

    try {
      const countResult = await db.unsafe(
        `SELECT COUNT(*)::int AS row_count FROM "${schema}"."${tableName}";`
      );

      const rowCount = countResult[0].row_count;

      if (rowCount > 100000) {
        addRowsSheet(workbook, sheetName, [
          {
            note: "Skipped because table has more than 100,000 rows",
            schema,
            table: tableName,
            row_count: rowCount,
          },
        ]);

        console.log(`Skipped data ${schema}.${tableName} rows=${rowCount}`);
        continue;
      }

      const dataResult = await db.unsafe(
        `SELECT * FROM "${schema}"."${tableName}" LIMIT 100000;`
      );

      addRowsSheet(workbook, sheetName, dataResult);
      console.log(`Exported data ${schema}.${tableName} rows=${dataResult.length}`);
    } catch (error) {
      addRowsSheet(workbook, sheetName, [
        {
          schema,
          table: tableName,
          error: error.message,
        },
      ]);

      console.warn(`Failed data ${schema}.${tableName}: ${error.message}`);
    }
  }

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  await db.end();

  console.log("");
  console.log("DONE");
  console.log(`Excel file created: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
