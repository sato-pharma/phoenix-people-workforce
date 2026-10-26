import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Rule 6 of scripts/check-migrations.mjs: a migration that creates a schema must revoke it from
// anon and authenticated in the same file (audit 2026-10-26, point 13).
//
// 20261023082524_repair_stranded_in_app_notifications.sql created notification_backup_20261023 and
// never revoked it. Nothing failed, because no check asked. This test runs the REAL script against
// a scaffold, one fixture at a time, because a source pin alone would still pass if the loop were
// reduced to a no-op — the same reason tests/migration-grandfather-staleness.test.ts does it.
export function runMigrationSchemaRevokeRuleTests() {
  const SCRIPT = "scripts/check-migrations.mjs";
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /const SCHEMA_REVOKE_CUTOFF = '20261023000000';/, "rule 6's cutoff must stay where the gap happened");

  const scaffold = mkdtempSync(path.join(tmpdir(), "schema-revoke-rule-"));
  try {
    const scriptDir = path.join(scaffold, "scripts");
    const migrationsDir = path.join(scaffold, "supabase", "migrations");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    // MIGRATIONS_DIR is resolved as <script>/../supabase/migrations, so the copy reads the fixture.
    writeFileSync(path.join(scriptDir, "check-migrations.mjs"), source);

    const runWith = (fixture: Record<string, string>) => {
      for (const f of readdirSync(migrationsDir)) rmSync(path.join(migrationsDir, f));
      for (const [name, body] of Object.entries(fixture)) writeFileSync(path.join(migrationsDir, name), body);
      const r = spawnSync(process.execPath, [path.join(scriptDir, "check-migrations.mjs")], { encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const passes = (label: string, fixture: Record<string, string>) => {
      const r = runWith(fixture);
      assert.equal(r.status, 0, `${label} must PASS. Output: ${r.out}`);
    };
    const refuses = (label: string, fixture: Record<string, string>, pattern: RegExp) => {
      const r = runWith(fixture);
      assert.notEqual(r.status, 0, `${label} must FAIL check-migrations. Output: ${r.out}`);
      assert.match(r.out, pattern, `${label} must fail on rule 6 itself, not for some other reason. Output: ${r.out}`);
    };
    const NEW = "20261101000000_probe.sql";

    // ── the shape that happened: a static create, no revoke ───────────────────
    refuses(
      "a new schema with no revoke",
      { [NEW]: "create schema if not exists probe_backup_20261101;\ncreate table probe_backup_20261101.t (id int);\n" },
      /creates schema probe_backup_20261101 without revoking it/,
    );

    // ── the fix, and the ways a fix can look right and not be ─────────────────
    passes("a new schema revoked from public, anon and authenticated", {
      [NEW]: "create schema if not exists probe_backup_20261101;\nrevoke all on schema probe_backup_20261101 from public, anon, authenticated;\n",
    });
    passes("a revoke split over two statements", {
      [NEW]: "create schema probe_b;\nrevoke usage on schema probe_b from anon;\nrevoke usage, create on schema probe_b from authenticated;\n",
    });
    refuses(
      "a revoke from PUBLIC alone",
      { [NEW]: "create schema probe_c;\nrevoke all on schema probe_c from public;\n" },
      /creates schema probe_c without revoking it/,
    );
    refuses(
      "a revoke that only names anon",
      { [NEW]: "create schema probe_d;\nrevoke all on schema probe_d from public, anon;\n" },
      /creates schema probe_d without revoking it/,
    );
    refuses(
      "a revoke of a DIFFERENT schema",
      { [NEW]: "create schema probe_e;\nrevoke all on schema probe_other from public, anon, authenticated;\n" },
      /creates schema probe_e without revoking it/,
    );
    refuses(
      "a revoke that only sits in a comment",
      { [NEW]: "create schema probe_f;\n-- rollback: revoke all on schema probe_f from public, anon, authenticated;\n" },
      /creates schema probe_f without revoking it/,
    );

    // ── the dynamic shape the October backup migrations use ───────────────────
    passes("execute format create followed by execute format revoke", {
      [NEW]: [
        "do $$ declare s text := 'probe_dyn'; begin",
        "  execute format('create schema if not exists %I', s);",
        "  execute format('revoke all on schema %I from public, anon, authenticated', s);",
        "end $$;",
        "",
      ].join("\n"),
    });
    refuses(
      "execute format create with no revoke",
      { [NEW]: "do $$ begin execute format('create schema if not exists %I', 'probe_dyn'); end $$;\n" },
      /creates schema %i \(inside execute format\) without revoking it/,
    );

    // ── what is deliberately out of reach ─────────────────────────────────────
    passes("a platform schema (extensions)", { [NEW]: "create schema if not exists extensions;\n" });
    passes("a file from before the cutoff (the rule is a ratchet)", {
      "20261022000000_old.sql": "create schema if not exists probe_old;\n",
    });

    // The one file fixed after the fact is exempt only while its fixing file exists.
    const STRANDED = "20261023082524_repair_stranded_in_app_notifications.sql";
    const FIXER = "20261026120100_lock_the_notification_backup_schema.sql";
    const strandedBody = "create schema if not exists notification_backup_20261023;\n";
    passes("the stranded file beside the file that locks its schema", {
      [STRANDED]: strandedBody,
      [FIXER]: "revoke all on schema notification_backup_20261023 from public, anon, authenticated;\n",
    });
    refuses("the stranded file with its fixing file gone", { [STRANDED]: strandedBody }, /is exempt from the create-schema revoke rule only because/);
  } finally {
    rmSync(scaffold, { recursive: true, force: true });
  }
}
