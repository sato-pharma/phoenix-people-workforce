// Closes the "migration merged to main but never actually applied" gap found
// 2026-07-19 — 3 migrations sat unapplied for up to a week (two causing real
// production bugs) before a manual audit caught it. Compares every repo migration
// file's version/name against what's actually recorded in Supabase's own
// supabase_migrations.schema_migrations bookkeeping table, via the
// public.phx_ci_migration_versions() RPC (see
// 20260720000000_ci_migration_version_check_rpc.sql for why an RPC instead of a raw
// Postgres credential).
//
// Runs against STAGING only (the only project with a CI-wired credential today) —
// per the established "everything lands on staging before production" workflow,
// staging drift is a reliable proxy: if a migration never reached staging, it almost
// certainly never reached production either. Intended to run on a daily schedule
// (see .github/workflows/ci.yml), NOT on pull_request/push — a PR introducing a new
// migration is SUPPOSED to show it unapplied at review time; this checks for silent
// drift that accumulates AFTER merge, which only a recurring check catches.
//
// Known, honest limitation: this only proves "unknown as of the last scheduled
// run", not a real-time guarantee — see the grace window below.

import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");
const FILENAME_RE = /^(\d{14})_(.+)\.sql$/;

// A migration merged less than this long ago might still be mid-rollout (staging
// verification in progress, production apply pending explicit approval per
// AGENTS.md) — only flag genuinely stale drift, not the normal review window.
const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000;

// Migrations already investigated and confirmed as a one-off, accepted exception —
// add an entry here ONLY after manually verifying the migration's content is truly
// unnecessary to apply (e.g. superseded by a later migration). Do not use this to
// silence a genuine unapplied migration.
//
// All entries below were confirmed 2026-07-20 by direct schema inspection (not just
// schema_migrations bookkeeping) against staging (cifwmndunmlxjhyjugxa): each file's
// intended effect is already live, achieved by a later, differently-named migration
// (mostly from the still-unmerged codex/supabase-deep-audit-fixes branch, PR #1191).
//
// IMPORTANT — do not "fix" the drift below by re-running these files:
//   - 20260717030000_crm_effective_visit_type_view.sql creates
//     public.ireports360_visits_effective WITHOUT `security_invoker = true`. The live
//     view already has security_invoker=true (added by the later migration that
//     superseded this one). Re-applying this file's bare `create or replace view`
//     would silently strip that setting back off — a real security regression, not a
//     no-op. Confirmed via `pg_class.reloptions` on both staging and production.
const ACKNOWLEDGED_EXCEPTIONS = new Set<string>([
  // Verified: 0 of the 17 named "authenticated read" policies exist on staging or
  // production — closed by 20260719230000_apply_backlogged_m3_sales_ops_rls_closure.
  "20260712010000_revoke_blanket_authenticated_read_sales_reference.sql",
  // Verified: both partial indexes exist on staging and production — created by
  // 20260719240000_apply_backlogged_ireports360_fixes.
  "20260714000000_ireports360_visits_unmapped_partial_indexes.sql",
  // Verified: public.ireports360_visits_effective exists WITH security_invoker=true
  // on staging and production — see the do-not-reapply warning above.
  "20260717030000_crm_effective_visit_type_view.sql",
  // Verified: all 4 core tables (direct_order_pharmacies/_requests/_approval_steps/
  // _events) exist on staging; production's schema_migrations records this under a
  // drifted name (the full timestamped filename recorded as the `name` field).
  "20260718140000_direct_orders_module_foundation.sql",
  // Verified via schema_migrations presence under a drifted name on both projects
  // (recorded by Supabase MCP apply_migration, which executes before recording, so a
  // recorded row is strong evidence the SQL genuinely ran).
  "20260719120000_direct_orders_caps_discount_distcodes.sql",
  "20260719140000_au_direct_area_attribution.sql",
  "20260719141000_direct_orders_sos_injection.sql",
  "20260719150000_marketing_track_direct_sales_column.sql",
  "20260719151000_marketing_roi_actuals_v2_direct_branch.sql",
  "20260719152000_marketing_roi_refresh_facts_direct_branch.sql",
  "20260719163000_direct_sales_reconciliation.sql",
  // Verified: staging's au.regions/au.lines/au.canonical_areas/au.seats/au.line_area_map
  // row counts (9/3/42/132/126) exactly match this file's seed content — the data was
  // already loaded via the ad-hoc tooling this file's own header describes, before this
  // migration formalized it for production.
  "20260713040000_au_seed_reference_data.sql",
  // Owner decision 2026-07-20 (not a "superseded" case like the rest of this list):
  // these two GATED, one-time PRODUCTION cutover scripts deliberately were not run
  // against staging. Staging's public.areas already shows an equivalent end state (50
  // active areas) via the ad-hoc tooling referenced above, but staging's employee data
  // isn't production's real lifecycle data, so the occupancy-reconcile step (backdating
  // effective_from to each occupant's real hire date) was judged not meaningful there.
  // Revisit only if staging's employee dataset is ever made production-representative.
  "20260718120000_au_public_areas_cutover_phase9.sql",
  "20260718130000_au_occupancy_reconcile_from_master_phase9.sql",
]);

type LocalMigration = { fileName: string; version: string; name: string; commitTimeMs: number | null };

function loadLocalMigrations(): LocalMigration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const out: LocalMigration[] = [];
  for (const fileName of files) {
    const m = FILENAME_RE.exec(fileName);
    if (!m) continue; // check-migrations.mjs already fails malformed filenames separately
    const [, version, name] = m;
    let commitTimeMs: number | null = null;
    try {
      const relPath = path.relative(process.cwd(), path.join(MIGRATIONS_DIR, fileName));
      const epochSeconds = execSync(`git log --follow -1 --format=%ct -- "${relPath}"`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (epochSeconds) commitTimeMs = Number(epochSeconds) * 1000;
    } catch {
      // Not fatal — if git history is unavailable (e.g. shallow checkout), treat as
      // "no age known" and let it through the grace-window check below.
    }
    out.push({ fileName, version, name, commitTimeMs });
  }
  return out;
}

async function loadRemoteMigrations(): Promise<{ versions: Set<string>; names: Set<string> }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }
  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("phx_ci_migration_versions");
  if (error) {
    throw new Error(`phx_ci_migration_versions RPC failed: ${error.message}`);
  }
  const rows = (data ?? []) as { version: string; name: string }[];
  return {
    versions: new Set(rows.map((r) => r.version)),
    names: new Set(rows.map((r) => r.name)),
  };
}

async function main() {
  const local = loadLocalMigrations();
  const remote = await loadRemoteMigrations();
  const now = Date.now();

  const missing: LocalMigration[] = [];
  for (const migration of local) {
    if (ACKNOWLEDGED_EXCEPTIONS.has(migration.fileName)) continue;

    const withinGraceWindow =
      migration.commitTimeMs !== null && now - migration.commitTimeMs < GRACE_WINDOW_MS;
    if (withinGraceWindow) continue;

    // Matches by exact version, OR by name (catches the known MCP apply_migration
    // version-drift pattern, where the recorded version is the MCP server clock at
    // apply time rather than the repo filename's timestamp), OR by the version
    // appearing as a substring of some recorded name (a handful of historical rows
    // recorded a full alternate filename-with-timestamp as their "name" field).
    const versionMatches = remote.versions.has(migration.version);
    const nameMatches = remote.names.has(migration.name);
    const substringMatches = [...remote.names].some((n) => n.includes(migration.version));
    if (!versionMatches && !nameMatches && !substringMatches) {
      missing.push(migration);
    }
  }

  console.log(
    `[migration-drift-check] ${local.length} local migrations, ${remote.versions.size} recorded on target project.`,
  );

  if (missing.length === 0) {
    console.log("[migration-drift-check] OK — every migration outside the grace window is accounted for.");
    process.exit(0);
  }

  console.error(
    `[migration-drift-check] ${missing.length} migration(s) merged to main but not found (by version or name) ` +
      `in the target project's schema_migrations, and older than the ${GRACE_WINDOW_MS / 3_600_000}h grace window:`,
  );
  for (const m of missing) {
    const age = m.commitTimeMs ? `${Math.round((now - m.commitTimeMs) / 3_600_000)}h old` : "age unknown";
    console.error(`  - ${m.fileName} (${age})`);
  }
  console.error(
    "[migration-drift-check] This means zero known errors as of this run, not a real-time guarantee — " +
      "investigate each file above: was it actually applied under a drifted version/name (reconcile via the " +
      "documented repair pattern), or does it still need to be applied to staging/production?",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[migration-drift-check] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
