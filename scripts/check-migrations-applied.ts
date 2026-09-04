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
//
// The inventory itself — which files exist, which are acknowledged exceptions, and what counts as
// "recorded" — lives in scripts/lib/migration-inventory.ts, shared with the staging applier so the
// two can never disagree about the answer. See that file's header.
import { createClient } from "@supabase/supabase-js";

import {
  GRACE_WINDOW_MS,
  loadLocalMigrations,
  projectRefFromUrl,
  selectMissingMigrations,
} from "./lib/migration-inventory.ts";

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

  // The grace window stays ON here, and is off in the applier — see selectMissingMigrations for
  // why each is right. This check runs nightly: a migration merged an hour ago is not news.
  const missing = selectMissingMigrations(local, remote, { nowMs: now });

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
      "documented repair pattern), or does it still need to be applied?",
  );
  // The two projects now need different remedies, and saying so saves the reader the diagnosis.
  // Staging is applied automatically on merge, so a staging miss is a BROKEN AUTOMATION, not a
  // forgotten chore — that is a different thing to go and look at.
  console.error(
    remote.projectRef === "cifwmndunmlxjhyjugxa"
      ? "[migration-drift-check] STAGING is applied automatically by .github/workflows/staging-migrate.yml on " +
          "every merge to main that touches supabase/migrations/**. A miss here means that workflow failed, was " +
          "skipped for a missing PHOENIX_STAGING_DATABASE_URL secret, or never triggered — check its runs first, " +
          "then re-run it (workflow_dispatch) rather than applying by hand."
      : "[migration-drift-check] PRODUCTION is deliberately NOT automated: applying a migration there needs the " +
          "owner's explicit approval, one at a time (AGENTS.md §6). Take these to him rather than applying them.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[migration-drift-check] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
