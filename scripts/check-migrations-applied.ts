// Closes the "migration merged to main but never actually applied" gap found
// 2026-07-19 — 3 migrations sat unapplied for up to a week (two causing real
// production bugs) before a manual audit caught it. Compares every repo migration
// file's version/name against what's actually recorded in Supabase's own
// supabase_migrations.schema_migrations bookkeeping table, via the
// public.phx_ci_migration_versions() RPC (see
// 20260720000000_ci_migration_version_check_rpc.sql for why an RPC instead of a raw
// Postgres credential).
//
// Runs against WHICHEVER project the NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// pair points at, and prints that project ref up front — the workflow drives it once per
// environment (see .github/workflows/migration-drift-check.yml).
//
// It used to run against STAGING ONLY, on the reasoning that "if a migration never reached
// staging, it almost certainly never reached production either". That proxy is backwards for
// the risk that actually bites. The documented workflow is staging-first, with production
// apply requiring separate explicit approval (AGENTS.md), so the NORMAL failure mode is
// applied-on-staging / missing-on-production — precisely the state a staging-only check
// reports as green. Proven 2026-07-30: the staging leg had been passing daily while
// production was missing 20260725180000_analytics_dim_products_exclude_head_office.sql,
// leaving Head-Office-line products exposed to non-CEO analytics consumers for ~110h.
//
// Intended to run on a daily schedule, NOT on pull_request/push — a PR introducing a new
// migration is SUPPOSED to show it unapplied at review time; this checks for silent drift
// that accumulates AFTER merge, which only a recurring check catches.
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
  // ── Added 2026-07-30, when this check was first pointed at PRODUCTION (see the
  // production leg in .github/workflows/migration-drift-check.yml). Each was verified
  // against production by direct schema inspection, not schema_migrations bookkeeping.
  //
  // Superseded by 20260724080655_ats_replatform_phase1, which renamed the whole domain
  // recruitment_* -> ats_*. Verified on production: public.ats_candidate_cv_extractions
  // exists, ats_candidates.position_specific_fields and
  // ats_candidate_cv_extractions.position_key both exist, and 71 candidates were created
  // in the 14 days to 2026-07-30. Re-running these files would recreate the pre-rename
  // recruitment_* tables as dead duplicates.
  "20260723175328_recruitment_candidate_cv_extraction.sql",
  "20260723201106_recruitment_position_schema_framework.sql",
  // Verified: the `recruitment-files` storage bucket exists on production.
  "20260723181334_recruitment_files_storage_bucket_staging_parity.sql",
  // Verified: production's public.ireports360_visits_effective already has the
  // effective_visit_type/reclassified_no_checkin columns AND security_invoker=true. This
  // file's own header says so — it was applied 2026-07-27 under the name
  // reconcile_visits_effective_view_vstar and exists only to make the definition
  // reproducible on a fresh reset.
  "20260728000000_refresh_visits_effective_view.sql",
  // ── Added 2026-08-05, after this check had been failing on every scheduled run for days and
  // nobody was reading it. Each was verified by direct schema inspection on the target project,
  // never from schema_migrations. Five SIBLING files flagged in the same run were NOT listed —
  // they were genuinely missing and have been applied to staging instead (revoke_anon_on_crm_
  // visits_effective, outstation_expenses_approved_amount, app_auth_biometric_credentials,
  // automated_payroll_part2_non_employees_and_manual_expenses).
  //
  // Applied on BOTH projects, recorded under a drifted version (the MCP apply_migration clock,
  // not the filename). Verified live on production AND staging: au.f_monthly_achievement carries
  // the Direct fix — two `is not distinct from k.area_code` joins, with the lam join deliberately
  // left as strict `=` exactly as this file specifies, and anon/authenticated revoked with
  // service_role granted.
  "20260801150100_au_direct_counts_toward_achievement.sql",
  // Applied 2026-08-12 to production AND staging via MCP apply_migration, which stamps its own
  // clock — production recorded it as version 20260812130058, so the filename below will never
  // match the ledger. Verified live on production by direct inspection of pg_proc, not by
  // schema_migrations: `where a.channel` is gone from au.f_monthly_achievement's body, both
  // line_code rejoins read `is not distinct from`, has_actual comes off coalesce(ac.matched,
  // false), SECURITY DEFINER and search_path=au,public survive, and service_role has execute
  // while anon/authenticated do not. phx_sales_vs_target_range then reconciled to
  // phx_monthly_attribution at 0.00 variance on all three lines for 2026-07.
  "20260812150000_au_achievement_counts_unmapped_sales.sql",
  // ── Direct Orders family basket, applied to PRODUCTION 2026-08-12 via scripts/apply-sql-file.mjs,
  // which does not write to schema_migrations at all — so neither file will ever match the ledger.
  //
  // Verified live on production by direct inspection, never from schema_migrations. Before the
  // apply: direct_order_request_items absent, direct_order_requests.family_code absent,
  // phx_direct_order_item_family_guard absent. After: 32 requests, 32 items, 0 requests without a
  // line, 0 requests whose lines fail to sum to their own sales_value, 0 with a null family_code,
  // 0 turned into multi-line requests by the backfill, the guard trigger present, RLS on, and
  // pg_get_functiondef(phx_rebuild_direct_order_sos_batch) containing direct_order_request_items —
  // which is the only proof that the PER-ITEM injection is what is actually live.
  //
  // Both files were renamed TWICE on the day, chasing the expense_claims phases as they landed on
  // main: written as 20260812160000/160100 and applied to STAGING under those names, moved to
  // 20260812170000/170100 and applied to PRODUCTION under THOSE, then moved to the minute-precise
  // slots below, off the round-hour cadence that sequence walks.
  //
  // The SQL never changed through any of it, and that is checked rather than asserted: on
  // 2026-08-12 the live objects were fingerprinted on both projects and the rebuild RPC, the family
  // guard and the items table's column shape all md5-match between staging and production.
  //
  // NEITHER ledger has a row for these under any name — apply-sql-file.mjs does not write
  // schema_migrations at all. An earlier version of this comment claimed staging recorded the old
  // timestamps; it does not, and staging was surveyed to establish that rather than reasoned about.
  // This set is global, so listing them here covers both legs of the drift check, which is the
  // whole reason it is the right home for a script-applied migration.
  "20260812184500_direct_orders_request_items.sql",
  "20260812184600_direct_orders_sos_injection_per_item.sql",
  // ── Applied to STAGING 2026-08-12 to close a real gap, again via apply-sql-file.mjs, so again no
  // ledger row. Production already had both — checked before applying, which is what made it safe:
  // hold_release_ground, duplicate_of_request_id and merged_into_pharmacy_id all present there, with
  // the direct_orders registry row intact.
  //
  // WHAT THIS UNCOVERED, and it is the more important half. duplicate_cleanup refused to commit on
  // staging with "action cancel_duplicate -> undeclared target 'cancelled'" — its own guard against
  // the 2026-08-05 outage shape, where an action pointing at an undeclared status makes the loader
  // skip the WHOLE module. The cause: staging's ledger CLAIMS 20260805150000_direct_orders_cancel_held
  // is applied while its effect is absent — no `cancelled` status, no `cancel_held` action. A row
  // that says "applied" for a migration that did not take is worse than a missing row, because this
  // very check reads it as green and never lists the file. It has been quietly green on it for a
  // week. Consistent with the pre-data-only restore described in migration-drift-check.yml's header:
  // registry rows are DATA, so a schema-only restore keeps the ledger and loses the content.
  //
  // Re-applied 20260805150000 (both its registry updates are `not exists`-guarded, so idempotent),
  // then duplicate_cleanup committed. Staging's direct_orders registry now matches production
  // exactly: the same 9 statuses and the same 16 actions, no undeclared targets on either.
  "20260808214500_direct_orders_release_held.sql",
  "20260809031500_direct_orders_duplicate_cleanup.sql",
  // ── Applied to STAGING and PRODUCTION 2026-08-12/13 via apply-sql-file.mjs, so no ledger row on
  // either. This is the migration that makes PHOENIX_EXPENSE_CLAIMS_READ safe to turn on: before it,
  // expense_claims had RLS with one policy (service_role) and no grant to `authenticated`, and
  // turning the flag on took /api/admin/outstation/expenses down for ~3.5 hours with a 42501.
  //
  // Verified on production by direct inspection AND by exercising the real RLS machinery, which
  // staging cannot do (it lacks USAGE on schema `private`, so helper calls raise 42501 before any
  // policy is reached — a separate gap, and the reason every staging RLS test is currently vacuous).
  // Before: rls on, authenticated select/insert/update/delete all false, one policy. After: the same
  // 375 rows, select true, insert/update/delete still false, two policies.
  //
  // Then, as `authenticated` for 15 real users: all 15 see rows through the new policy (1 to 62
  // claims each), and for every one of them every legacy row they can see is still reachable as a
  // claim they can see. The lower per-user counts against the raw legacy union are the dedup —
  // 375 claims vs 360+39 legacy rows, a difference of exactly the 24 rows carrying both legacy ids.
  //
  // The flag remains false. Applying this does not enable anything; it only removes the reason the
  // flag was unsafe.
  "20260812213000_expense_claims_select_rls.sql",
  // Applied: verified 0 tables matching `email_backfill_backup%` remain on staging, which is this
  // file's own end state.
  "20260801100000_drop_email_backfill_backup.sql",
  // Not applicable: this hardens the very table that 20260801100000 (above) DROPS. With the table
  // gone from staging there is nothing to enable RLS on, and re-running it would fail rather than
  // protect anything.
  "20260801090000_secure_email_backfill_backup_rls.sql",
  // Not applicable: self-guarding by design — it loops over crm_restamp_backup_20260801 /
  // crm_restamp_checkins_backup_20260801 and no-ops via to_regclass when absent. Verified 0 of
  // those tables exist on staging, so the file is already a no-op there.
  "20260801110000_secure_crm_restamp_backups_rls.sql",
  // Not applicable: production-only guarded data remediation for 5 named vacancy ids whose exact
  // phantom-filled state existed only on production. The file's own header states it is "a safe
  // no-op on staging / any environment where the state differs" — the UPDATE matches on both id
  // and the specific wrong filler, so nothing on staging can match.
  "20260801160000_reopen_cross_area_misfill_vacancies.sql",
  // ── The two below are blocked by a STRUCTURAL gap, not a missed apply: staging has NO
  // deductions module at all. Verified: 0 tables matching `deductions_%` on staging, against a
  // production module that is fully present. Revisit both if staging ever gains the module.
  //
  // Pins search_path on three deductions trigger functions. Verified 0 of the 3 exist on staging
  // (deductions_candidates_guard_locked, deductions_decisions_touch_updated_at,
  // deductions_publication_lines_guard_day_overlap), so there is nothing to pin.
  "20260801140000_deductions_module_pin_trigger_search_path.sql",
  // Adds a column to public.deductions_decisions. Confirmed by attempting the apply on staging
  // 2026-08-05: Postgres refused with 42P01 relation "public.deductions_decisions" does not exist.
  "20260802094500_deductions_decisions_applied_dates.sql",
  // RESOLVED 2026-08-05 — 20260725180000_analytics_dim_products_exclude_head_office.sql is
  // APPLIED. It needs no entry in this list: it is genuinely applied AND recorded in
  // schema_migrations under its own version, so the check matches it and passes.
  //
  // Kept as a record rather than deleted, because the history is the point. This was the one
  // REAL production drift this check ever found — caught by its first production run on
  // 2026-07-30, 110h after merge, applied to staging and never to production. It was
  // deliberately left FAILING here for six days rather than silenced, because failing was the
  // only thing that would keep it visible until an owner approved the apply.
  //
  // Verified live on production 2026-08-05, by reading the view rather than the ledger:
  // pg_get_viewdef('analytics.dim_products') now carries the line exclusion character-for-
  // character as this migration writes it, and the boundary holds — 0 Head-Office-line rows and
  // 0 restricted product codes visible through dim_products (22 products), against 26 in the
  // CEO/Super-Admin dim_products_all. The four-row gap is exactly the confidential set.
  //
  // A caution for whoever checks this next: `position('head office' in viewdef) > 0` is NOT a
  // sufficient test — it answered "excluded" while a second query still counted a product that
  // would disappear, because that one read the SOURCE table. Only reading the full view
  // definition settled it. Do not re-open this on the strength of a substring match.
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

/** `https://<ref>.supabase.co` -> `<ref>`, so every run states which project it judged. */
function projectRefFromUrl(url: string): string {
  return /^https?:\/\/([a-z0-9]+)\./i.exec(url)?.[1] ?? url;
}

async function loadRemoteMigrations(): Promise<{ versions: Set<string>; names: Set<string>; projectRef: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }
  const projectRef = projectRefFromUrl(url);
  // Printed BEFORE the query so a failure still tells you what was being checked. Both MCP
  // servers and both env files can reach either project; the ref is the only thing that
  // distinguishes staging from production (AGENTS.md).
  console.log(`[migration-drift-check] target project ref: ${projectRef}`);
  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("phx_ci_migration_versions");
  if (error) {
    throw new Error(`phx_ci_migration_versions RPC failed: ${error.message}`);
  }
  const rows = (data ?? []) as { version: string; name: string }[];
  return {
    versions: new Set(rows.map((r) => r.version)),
    names: new Set(rows.map((r) => r.name)),
    projectRef,
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
    `[migration-drift-check] ${local.length} local migrations, ${remote.versions.size} recorded on ${remote.projectRef}.`,
  );

  if (missing.length === 0) {
    console.log(
      `[migration-drift-check] OK — every migration outside the grace window is accounted for on ${remote.projectRef}.`,
    );
    process.exit(0);
  }

  console.error(
    `[migration-drift-check] ${missing.length} migration(s) merged to main but not found (by version or name) ` +
      `in ${remote.projectRef}'s schema_migrations, and older than the ${GRACE_WINDOW_MS / 3_600_000}h grace window:`,
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
