import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runPositionVacancyStatusIntegrityTests() {
  // ── Migration carries the canonical enum + backfills + drops the dead table ──────
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const migrations = readdirSync(migrationsDir);
  const integrityMigration = migrations.find((file) =>
    /position_vacancies_status_integrity\.sql$/.test(file),
  );
  assert.ok(
    integrityMigration,
    "expected a 20260616120000_position_vacancies_status_integrity.sql migration to exist",
  );

  const migrationSql = readFileSync(new URL(integrityMigration!, migrationsDir), "utf8");
  assert.match(
    migrationSql,
    /update public\.position_vacancies[\s\S]*?set status = 'cancelled'[\s\S]*?where status not in \('open', 'filled', 'cancelled'\)/i,
    "migration must backfill out-of-enum rows to 'cancelled' (e.g. the 4 'closed' DSM rows)",
  );
  assert.match(
    migrationSql,
    /add constraint position_vacancies_status_check[\s\S]*?check \(status in \('open', 'filled', 'cancelled'\)\)[\s\S]*?not valid/i,
    "migration must re-assert the CHECK constraint NOT VALID so it doesn't take an exclusive lock",
  );
  assert.match(
    migrationSql,
    /validate constraint position_vacancies_status_check/i,
    "migration must follow the NOT VALID add with a VALIDATE pass",
  );
  assert.match(
    migrationSql,
    /drop table if exists public\.notification_delivery_logs/i,
    "migration must drop the retired notification_delivery_logs table",
  );

  // ── Code-side: no writer outside the migration must produce status='closed' ─────
  // We assert this at source-text level. A clean grep across src/ + app/ for the
  // string literal "closed" inside a position_vacancies write context catches
  // future regressions (the audit confirmed no current writer; this is a guard).
  const offersService = source("src/lib/offers/service.ts");
  assert.match(
    offersService,
    /status: "filled"/,
    "closeVacancyForOffer must write 'filled', never 'closed'",
  );
  assert.doesNotMatch(
    offersService,
    /position_vacancies[\s\S]{0,200}status: "closed"/i,
    "no TypeScript writer may set position_vacancies.status to 'closed'",
  );

  // ── Bootstrap migration retains the canonical CHECK definition (sanity) ──────────
  const bootstrap = source(
    "supabase/migrations/20260501000000_phoenix_core_schema_bootstrap.sql",
  );
  assert.match(
    bootstrap,
    /status text not null default 'open' check \(status in \('open', 'filled', 'cancelled'\)\)/i,
    "bootstrap migration must still define the canonical (open|filled|cancelled) enum",
  );
}
