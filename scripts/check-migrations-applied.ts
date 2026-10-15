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
// 🔴 `--no-grace` MAKES THIS A SWEEP, AND A SWEEP IS NOT THIS CHECK. The 48h grace window below is
// right for a nightly job and wrong for the question "has anything merged never been applied?" —
// it shelters exactly the newest files, which is where an unapplied migration is likeliest to be.
// Measured 2026-10-15, answering the owner's "sweep production for merged migrations never
// applied": the default run named four production files, and `--no-grace` named four MORE, three of
// them money migrations merged that morning. One command:
//   pnpm run check:migrations-swept            production, grace window down
//   pnpm run check:migrations-swept-staging    the other database (--no-grace --staging)
// Credentials come from the process environment first and then from this repo's env files, so both
// run in a shell as well as in CI — the environment always wins (resolveEnvValue).
// All eight turned out to be applied, with no ledger row, because the standing apply route writes
// none — see the remedy text at the bottom of this file and docs/migrations.md, "The 15 October
// production sweep". An unknown flag is refused, never ignored (parseDriftCheckFlags).
//
// The inventory itself — which files exist, which are acknowledged exceptions, and what counts as
// "recorded" — lives in scripts/lib/migration-inventory.ts, shared with the staging applier so the
// two can never disagree about the answer. See that file's header.
import { createClient } from "@supabase/supabase-js";

import {
  DRIFT_CHECK_ENV_FILES,
  GRACE_WINDOW_MS,
  loadLocalMigrations,
  parseDriftCheckFlags,
  projectRefFromUrl,
  resolveEnvValue,
  selectMissingMigrations,
} from "./lib/migration-inventory.ts";

async function loadRemoteMigrations(
  staging: boolean,
): Promise<{ versions: Set<string>; names: Set<string>; projectRef: string }> {
  // The process environment first, then the repo's own env files — so the one command works in a
  // shell and not only in CI, where the workflow passes each leg's pair explicitly. See
  // resolveEnvValue: a file can never override what CI set.
  const urlName = staging ? "PHOENIX_STAGING_SUPABASE_URL" : "NEXT_PUBLIC_SUPABASE_URL";
  const keyName = staging ? "PHOENIX_STAGING_SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_SERVICE_ROLE_KEY";
  const url = resolveEnvValue(urlName);
  const key = resolveEnvValue(keyName);
  if (!url || !key) {
    const missing = [!url ? urlName : null, !key ? keyName : null].filter(Boolean).join(" / ");
    throw new Error(
      `${missing} not set — cannot reach the target Supabase project. Looked in the process `
        + `environment and then ${DRIFT_CHECK_ENV_FILES.join(", ")}. `
        + (staging
          ? "The staging pair lives in .env.staging.rls.local."
          : "The production pair lives in .env.local (AGENTS.md §3); add --staging for the other project."),
    );
  }
  // Said out loud because the credentials decide WHICH DATABASE was answered, and two files in this
  // repo can reach two different projects. The values are never printed — one is a service-role key.
  console.log(
    `[migration-drift-check] credentials: ${urlName} from ${url.source}, ${keyName} from ${key.source}.`,
  );
  const projectRef = projectRefFromUrl(url.value);
  // Printed BEFORE the query so a failure still tells you what was being checked. Both MCP
  // servers and both env files can reach either project; the ref is the only thing that
  // distinguishes staging from production (AGENTS.md).
  console.log(`[migration-drift-check] target project ref: ${projectRef}`);
  const supabase = createClient(url.value, key.value);

  // PAGE THROUGH THE RPC — do not trust a single call to return every row. PostgREST caps an RPC
  // response at its `db-max-rows` setting, and that setting differs BETWEEN the two projects:
  // staging returns at most 1000 rows, production returns all of them. Once staging's ledger
  // crossed 1000 rows (on 2026-09-20, which is exactly when this check first went red), the single
  // unpaged call silently dropped the NEWEST rows past 1000 — so every migration recorded after
  // the cap read as "merged but never applied", 42 of them, all of which were in fact present in
  // schema_migrations. Worse than the false alarm: the same truncation would HIDE a genuinely
  // unapplied newest migration, defeating the check. The function itself is fine — `select count(*)
  // from public.phx_ci_migration_versions()` returns the true 1063 in direct SQL; only the REST
  // transport caps. So keep requesting successive ranges, advancing by however many rows actually
  // came back (never by the requested window — the cap may be smaller than STRIDE), until a page
  // returns nothing. Advancing by rows.length is what makes this correct for any db-max-rows value.
  const STRIDE = 1000;
  const rows: { version: string; name: string }[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("phx_ci_migration_versions")
      .range(from, from + STRIDE - 1);
    if (error) {
      throw new Error(`phx_ci_migration_versions RPC failed: ${error.message}`);
    }
    const page = (data ?? []) as { version: string; name: string }[];
    rows.push(...page);
    if (page.length === 0) break;
    from += page.length;
    // Safety valve against an RPC that ignores Range and returns the same page forever — the ledger
    // is in the low thousands, so anything past this is a bug, not a bigger database.
    if (from > 100_000) {
      throw new Error(
        `phx_ci_migration_versions returned more than 100,000 rows while paging — the RPC is likely ignoring the Range header. Aborting rather than looping.`,
      );
    }
  }
  return {
    versions: new Set(rows.map((r) => r.version)),
    names: new Set(rows.map((r) => r.name)),
    projectRef,
  };
}

async function main() {
  // Parsed before anything opens a connection, so an unknown flag costs nothing — and it is
  // REFUSED rather than ignored, because a dropped flag would answer the narrow question in the
  // wide question's words. See parseDriftCheckFlags.
  const { ignoreGraceWindow, staging } = parseDriftCheckFlags(process.argv.slice(2));
  const local = loadLocalMigrations();
  const remote = await loadRemoteMigrations(staging);
  const now = Date.now();

  // The grace window stays ON by default here, and is off in the applier — see
  // selectMissingMigrations for why each is right. This check runs nightly: a migration merged an
  // hour ago is not news. 🔴 `--no-grace` is what a SWEEP wants, and the difference is not
  // cosmetic: on 2026-10-15 the window sheltered four of the eight production files with missing
  // ledger rows, three of them money migrations merged that morning.
  const missing = selectMissingMigrations(local, remote, { nowMs: now, ignoreGraceWindow });
  // One noun phrase, used in all three sentences below, so the report can never describe the
  // nightly question while having answered the sweep's.
  const scope = ignoreGraceWindow
    ? `every migration including the newest (--no-grace: the ${GRACE_WINDOW_MS / 3_600_000}h grace window is stood down)`
    : `every migration outside the ${GRACE_WINDOW_MS / 3_600_000}h grace window`;

  console.log(
    `[migration-drift-check] ${local.length} local migrations, ${remote.versions.size} recorded on ${remote.projectRef}; judging ${scope}.`,
  );

  if (missing.length === 0) {
    console.log(
      `[migration-drift-check] OK — ${scope} is accounted for on ${remote.projectRef}.`,
    );
    process.exit(0);
  }

  console.error(
    `[migration-drift-check] ${missing.length} migration(s) merged to main but not found (by version or name) ` +
      `in ${remote.projectRef}'s schema_migrations, judging ${scope}:`,
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
      : "[migration-drift-check] PRODUCTION is not automated, but it no longer waits on the owner either: since " +
          "2026-10-15 AGENTS.md §8 pre-authorizes `scripts/apply-sql-file.mjs` as the STANDING route for a " +
          "migration the Supabase MCP refuses, with no per-migration word (announce a destructive or bulk change " +
          "first). 🔴 FIRST ESTABLISH WHICH OF THE TWO THINGS THIS IS, because that route writes NO ledger row and " +
          "so produces this very finding for migrations that ARE applied: on 2026-10-15 a sweep of all four files " +
          "listed here found all four live on production and none unapplied. Verify by DIGEST against the catalog, " +
          "never by object presence (`create or replace` means an older generation satisfies a presence probe just " +
          "as well) — and compare md5 of the file's dollar-quoted body in FOUR shapes, as-is LF, as-is CRLF, " +
          "comment-stripped LF and comment-stripped CRLF, because some apply routes normalise line endings and " +
          "strip full-line comments. Already applied: record an evidenced entry in ACKNOWLEDGED_EXCEPTIONS " +
          "(scripts/lib/migration-inventory.ts), never a ledger write. Genuinely missing: apply it by that route.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[migration-drift-check] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
