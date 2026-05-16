#!/usr/bin/env node

const postgres = require("postgres");

const DEFAULT_REMOTE_DB_URL =
  "postgresql://postgres.ozucdzovmcqvepbozvqf:a7ayaneikAA%24%24@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&prefer_simple_protocol=true";

const MIGRATION_ID = "20260516093000";
const MIGRATION_NAME = "20260516093000_reconcile_leave_requests_with_remote.sql";

const remoteUrl = process.env.REMOTE_SUPABASE_DB_URL || process.env.SUPABASE_DB_URL || DEFAULT_REMOTE_DB_URL;

const expectedColumns = {
  requested_at: { is_nullable: "NO", column_default: "now()" },
  manager_decision_at: { is_nullable: "YES" },
  hr_decision_at: { is_nullable: "YES" },
  attachment_url: { is_nullable: "YES" },
  manager_comment: { is_nullable: "YES" },
  hr_comment: { is_nullable: "YES" },
  payment_reason: { is_nullable: "YES" },
  manager_status: { is_nullable: "NO", column_default: "'pending'::text" },
  hr_status: { is_nullable: "NO", column_default: "'pending'::text" },
  payroll_status: { is_nullable: "NO", column_default: "'not_required'::text" },
  payment_status: { is_nullable: "NO", column_default: "'in_review'::text" },
  duration_unit: { is_nullable: "NO", column_default: "'full_day'::text" },
  total_calendar_days: { is_nullable: "NO", column_default: "0" },
  total_working_days: { is_nullable: "NO", column_default: "0" },
  leave_type_id: { is_nullable: "NO" },
  policy_id: { is_nullable: "NO" },
  balance_leave_type_id: { is_nullable: "YES" },
  hr_balance_decision: { is_nullable: "YES" },
};

const expectedConstraints = [
  "leave_requests_status_check",
  "leave_requests_manager_status_check",
  "leave_requests_hr_status_check",
  "leave_requests_payroll_status_check",
  "leave_requests_payment_status_check",
  "leave_requests_duration_unit_check",
  "leave_requests_hr_balance_decision_check",
  "leave_requests_date_check",
];

const expectedFks = [
  "leave_requests_employee_hr_id_fkey",
  "leave_requests_leave_type_id_fkey",
  "leave_requests_balance_leave_type_id_fkey",
  "leave_requests_policy_id_fkey",
];

const expectedIndexes = [
  "leave_requests_employee_idx",
  "leave_requests_status_idx",
  "leave_requests_dates_idx",
  "leave_requests_status_dates_idx",
  "leave_requests_lineup_idx",
  "leave_requests_employee_hr_id_idx",
  "leave_requests_created_at_idx",
];

function normalizeDefault(value) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function checkSchema(data, label) {
  const errors = [];

  const columnsByName = new Map(data.columns.map((row) => [row.column_name, row]));
  for (const [name, expected] of Object.entries(expectedColumns)) {
    const column = columnsByName.get(name);
    if (!column) {
      errors.push(`Missing column: leave_requests.${name}`);
      continue;
    }

    if (expected.is_nullable && column.is_nullable !== expected.is_nullable) {
      errors.push(
        `Column leave_requests.${name} nullability mismatch: expected ${expected.is_nullable}, found ${column.is_nullable}`,
      );
    }

    if (expected.column_default && normalizeDefault(column.column_default) !== normalizeDefault(expected.column_default)) {
      errors.push(
        `Column leave_requests.${name} default mismatch: expected ${expected.column_default}, found ${column.column_default}`,
      );
    }
  }

  const constraintNames = new Set(data.constraints.map((row) => row.conname));
  for (const conname of expectedConstraints) {
    if (!constraintNames.has(conname)) {
      errors.push(`Missing constraint: ${conname}`);
    }
  }

  const indexNames = new Set(data.indexes.map((row) => row.indexname));
  for (const indexName of expectedIndexes) {
    if (!indexNames.has(indexName)) {
      errors.push(`Missing index: ${indexName}`);
    }
  }

  const fkNames = new Set(data.constraints.map((row) => row.conname));
  for (const fk of expectedFks) {
    if (!fkNames.has(fk)) {
      errors.push(`Missing foreign key: ${fk}`);
    }
  }

  if (!data.migrations.includes(MIGRATION_ID)) {
    errors.push(`Missing migration record: ${MIGRATION_ID} (${MIGRATION_NAME})`);
  }

  if (errors.length > 0) {
    console.error(`\n[FAIL] ${label}\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    process.exit(1);
  }

  console.log(`\n[PASS] ${label}`);
}

async function main() {
  const sql = postgres(remoteUrl, {
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    const columns = await sql`
      select
        column_name,
        data_type,
        is_nullable,
        column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'leave_requests'
      order by ordinal_position;
    `;

    const constraints = await sql`
      select conname, pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class r on c.conrelid = r.oid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public'
        and r.relname = 'leave_requests'
        and c.contype in ('c', 'f');
    `;

    const indexes = await sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'leave_requests';
    `;

    const migrationRows = await sql`
      select coalesce(
        (
          select version
          from supabase_migrations.schema_migrations
          where version = ${MIGRATION_ID}
          limit 1
        ),
        ''
      ) as version;
    `;

    const migrationRecord = migrationRows?.[0]?.version ? [migrationRows[0].version] : [];

    checkSchema(
      {
        columns,
        constraints,
        indexes,
        migrations: migrationRecord,
      },
      "Remote leave_requests schema parity check",
    );
  } catch (error) {
    console.error("[FAIL] Remote leave_requests schema parity check");
    console.error(`  ${error?.message ?? String(error)}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exit(1);
});
