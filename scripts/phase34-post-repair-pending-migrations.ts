// RETIRED 2026-07-11: this script implemented a production-migration approval gate built
// around one specific pre-baseline migration, which is now archived under
// supabase/_migrations_archive/pre-baseline-2026-07-11/. That gate concept is superseded by
// the baseline-snapshot model — see docs/migrations.md ("Baseline Model") for the current
// approach. Left in place for history/reference; not part of the active migration pipeline.

import { readdirSync, readFileSync } from "node:fs";

import postgres from "postgres";

type MigrationRow = {
  version: string;
};

loadLocalEnv();

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Environment variables may be injected by the runner.
  }
}

function localMigrationVersions() {
  return readdirSync("supabase/migrations")
    .map((fileName) => {
      const match = fileName.match(/^(\d{14})_(.+)\.sql$/);
      return match ? { fileName, version: match[1] } : null;
    })
    .filter((item): item is { fileName: string; version: string } => Boolean(item))
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is required");

  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    ssl: "require",
  });

  try {
    const local = localMigrationVersions();
    const remote = await sql<MigrationRow[]>`
      select version::text
      from supabase_migrations.schema_migrations
      order by version
    `;
    const remoteVersions = new Set(remote.map((row) => row.version));
    const pending = local.filter((migration) => !remoteVersions.has(migration.version));
    const phase21Applied = remoteVersions.has("20260518232733");
    const phase28Pending = pending.some((migration) => migration.version === "20260519102840");

    console.log(JSON.stringify({
      checks: [
        {
          label: "Phase 21 migration history repair is reflected",
          ok: phase21Applied,
        },
        {
          label: "Phase 28 remains pending",
          ok: phase28Pending,
        },
        {
          details: pending,
          label: "Only Phase 28 remains pending",
          ok: pending.length === 1 && pending[0]?.version === "20260519102840",
        },
      ],
      pending,
      phase21Applied,
      phase28Pending,
      source: "read-only local migration to remote schema_migrations comparison",
    }, null, 2));

    if (!phase21Applied || !phase28Pending || pending.length !== 1) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
