/**
 * Fail when a Supabase advisor category grows past its recorded baseline.
 *
 * 🔴 WHY THIS EXISTS — the root cause behind three separate findings.
 *
 * docs/security/supabase-advisor-baseline.md is the document that decides which advisor
 * findings are "accepted as by-design". It was last reviewed 2026-07-19. By 2026-09-29:
 *
 *     rls_enabled_no_policy          it said INFO x23        live: 176
 *     unused_index                   it said INFO x326       live: 615
 *     function_search_path_mutable   it said REMEDIATED      live: 10
 *
 * The third is the one that should sting. That document states, in its own words, that if
 * `function_search_path_mutable` reappears "it's a regression". It reappeared — for ten
 * functions, none of them the one it named — and nobody found out, because **nothing in this
 * repository had ever compared live advisor output to that document.** 153 tables joined an
 * "accepted" list without anyone accepting them.
 *
 * A triage reference nobody checks is not a reference. It is a story about July.
 *
 * WHAT THIS DOES. Reads public.phx_ci_advisor_counts() — the same categories recomputed from
 * pg_catalog, because `get_advisors` is an MCP tool and CI has no MCP — and fails when a live
 * count EXCEEDS the baseline in scripts/advisor-baseline.json. Growth must force a decision.
 *
 * A count that FALLS is reported and does not fail: fixing things must never be an error. The
 * script says so explicitly, because the tempting next step — auto-lowering the baseline — is
 * how a ratchet quietly loses its teeth against a count that oscillates.
 *
 * Runs in the existing daily migration-drift-check.yml job against production and staging, so
 * it costs no new GitHub Actions minutes.
 */
import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

type CategoryBaseline = { accepted: number; severity: "info" | "warn" | "error"; why: string };
type Baseline = {
  project_ref: string;
  last_reviewed: string;
  categories: Record<string, CategoryBaseline>;
};

export type AdvisorCount = { category: string; current_count: number };
export type Finding = { severity: "error" | "warning"; code: string; message: string };

/** Sentinel from the RPC: no reset stamp at all (database nor checkpointer), so the age is unknown. */
const STATS_AGE_UNKNOWN = -1;

/**
 * 🔴 How old the index counters must be before an `unused_index` count over its baseline is an
 * ERROR. Younger than this, it is a WARNING (`advisor_counters_too_young`).
 *
 * A Postgres CRASH restart throws every idx_scan back to 0, so the morning after one, every index
 * that has not been touched since reads as unused. Production crashed on 2026-10-29 at 14:04 Cairo;
 * the 30 Oct drift run read 815 against the accepted 755 on counters 18 hours old, and failed — and
 * 801 of the 807 "unused" indexes read that evening were older than 23 Oct, so nothing new had
 * joined. 96 hours, not 72: a crash on a Thursday afternoon is followed by the Friday-Saturday
 * weekend, and at 72 hours the counters have seen one working morning. Only `unused_index` is
 * softened — every other category is a catalog count that a restart does not touch.
 */
export const UNUSED_INDEX_MIN_COUNTER_HOURS = 96;

/**
 * Pure comparison, separated from I/O so it can be tested without a database.
 *
 * 🔴 An UNKNOWN category — one the database reports that the baseline has never heard of — is
 * an ERROR, not a shrug. A new advisor category appearing is precisely the event this whole
 * mechanism exists to notice, and defaulting it to "fine" would recreate the silence.
 */
export function evaluateAdvisorCounts(baseline: Baseline, live: AdvisorCount[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const statsAge = live.find((r) => r.category === "stats_age_hours")?.current_count;
  const countersTooYoung =
    typeof statsAge === "number" && statsAge >= 0 && statsAge < UNUSED_INDEX_MIN_COUNTER_HOURS;

  for (const row of live) {
    if (row.category === "stats_age_hours") continue; // context, not a category — see below
    seen.add(row.category);

    const entry = baseline.categories[row.category];
    if (!entry) {
      findings.push({
        severity: "error",
        code: "advisor_category_unknown",
        message:
          `Advisor category \`${row.category}\` (count ${row.current_count}) is not in ` +
          "scripts/advisor-baseline.json. A category nobody has triaged is exactly what this " +
          "check exists to surface — decide on it and record the decision with its reason.",
      });
      continue;
    }

    if (row.current_count > entry.accepted && row.category === "unused_index" && countersTooYoung) {
      findings.push({
        severity: "warning",
        code: "advisor_counters_too_young",
        message:
          `\`unused_index\` is ${row.current_count}, above its accepted baseline of ${entry.accepted} ` +
          `(+${row.current_count - entry.accepted}), but the index counters are only ${statsAge}h old ` +
          `(under ${UNUSED_INDEX_MIN_COUNTER_HOURS}h): a stats reset or a crash restart zeroed them, so ` +
          "every index not touched since reads as unused. Not judged until the counters are old " +
          "enough; it becomes an error then if it is still over.",
      });
    } else if (row.current_count > entry.accepted) {
      findings.push({
        severity: "error",
        code: "advisor_baseline_exceeded",
        message:
          `\`${row.category}\` is ${row.current_count}, above its accepted baseline of ` +
          `${entry.accepted} (+${row.current_count - entry.accepted}). Accepted because: ` +
          `${entry.why} — fix the database, or record why the new number is right, in ` +
          "docs/security/supabase-advisor-baseline.md with the date. Raising the number to go " +
          "green is how the 2026-07-19 baseline drifted from 23 to 176 unnoticed.",
      });
    } else if (row.current_count < entry.accepted) {
      // Never an error. Reported so the baseline can be tightened deliberately, by a human.
      findings.push({
        severity: "warning",
        code: "advisor_baseline_improved",
        message:
          `\`${row.category}\` is ${row.current_count}, BELOW its baseline of ${entry.accepted} ` +
          `(-${entry.accepted - row.current_count}). Good news. Lower the baseline in ` +
          "scripts/advisor-baseline.json to lock the improvement in — this is deliberately not " +
          "automatic, because a count that oscillates would otherwise ratchet itself loose.",
      });
    }
  }

  // A category vanishing means the RPC stopped reporting it — the check going blind looks
  // identical to the check passing, which is the failure mode this file was written about.
  for (const name of Object.keys(baseline.categories)) {
    if (!seen.has(name)) {
      findings.push({
        severity: "error",
        code: "advisor_category_missing",
        message:
          `Baseline category \`${name}\` was not reported by phx_ci_advisor_counts(). The check ` +
          "has gone blind to it; that is not the same as the finding being resolved.",
      });
    }
  }

  return findings;
}

function projectRef(url: string | undefined): string {
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? "");
  return m ? m[1] : "(unknown)";
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }

  const baseline = JSON.parse(
    readFileSync(new URL("./advisor-baseline.json", import.meta.url), "utf8"),
  ) as Baseline;

  const ref = projectRef(url);
  console.log(`[advisor-baseline] target project ref: ${ref}`);
  console.log(`[advisor-baseline] baseline last reviewed ${baseline.last_reviewed}`);

  // 🔴 The baseline records what was decided about ONE database. Measured 2026-09-29, staging
  // reads unused_index 624 against production's 615 and rls_enabled_no_policy 161 against 176 —
  // differences that mean nothing and would fail this nightly. Refuse to compare rather than
  // invent a verdict; a check that cries wolf is the one people learn to skip past.
  if (ref !== baseline.project_ref) {
    console.log(
      `[advisor-baseline] baseline is for ${baseline.project_ref}, not ${ref} — NOT comparing. ` +
        "These counts are a per-database triage record, not a universal standard.",
    );
    return;
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("phx_ci_advisor_counts");
  if (error) {
    // Same contract as every other optional gate here: a target that predates the migration is
    // "not deployed yet", not a violation. Staging and production are checked independently.
    console.log(
      `[advisor-baseline] gate not available on this target (${error.message}) — skipping.`,
    );
    return;
  }

  const live = (data ?? []) as AdvisorCount[];
  const statsAge = live.find((r) => r.category === "stats_age_hours")?.current_count;

  for (const row of [...live].sort((a, b) => a.category.localeCompare(b.category))) {
    if (row.category === "stats_age_hours") continue;
    const accepted = baseline.categories[row.category]?.accepted;
    console.log(
      `[advisor-baseline] ${row.category}: ${row.current_count}` +
        (accepted === undefined ? "  (NOT IN BASELINE)" : `  (baseline ${accepted})`),
    );
  }

  // 🔴 `unused_index` is meaningless without this. A stats reset makes every index look unused,
  // and reading that as a drop list is the trap the baseline document already warns about.
  // The RPC measures the age from the LATER of pg_stat_database.stats_reset and
  // pg_stat_checkpointer.stats_reset (20261030211500). The second matters: a CRASH restart throws
  // every counter away WITHOUT stamping pg_stat_database.stats_reset (it stays NULL), but crash
  // recovery does stamp the checkpointer's. Reading only the first, the 2026-10-29 crash read as
  // "no reset recorded" and this line told the reader the counters were long-accumulated.
  if (statsAge === STATS_AGE_UNKNOWN) {
    console.log(
      "[advisor-baseline] index stats: no reset recorded on the database or the checkpointer. " +
        "Counters have accumulated since the stats file was created.",
    );
  } else if (typeof statsAge === "number") {
    console.log(
      `[advisor-baseline] index stats have been accumulating for ${statsAge}h ` +
        `(${(statsAge / 24).toFixed(1)} days) — short windows make an index look unused.`,
    );
  }

  const findings = evaluateAdvisorCounts(baseline, live);
  for (const f of findings) {
    console.log(`[advisor-baseline] ${f.severity === "error" ? "ERROR" : "WARN "} ${f.code}: ${f.message}`);
  }

  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length > 0) {
    console.error(
      `[advisor-baseline] ${errors.length} error(s) on ${ref}. An advisor count above its ` +
        "accepted baseline means something was added that nobody triaged.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[advisor-baseline] OK on ${ref} — no category above its accepted baseline.`);
}

// Same guard as its siblings here. A path comparison against import.meta.url does NOT work on
// Windows (backslashes vs a file:// URL) — it silently matched nothing and the script ran to
// exit 0 having done absolutely nothing, which is indistinguishable from passing.
if (process.argv[1] && /check-advisor-baseline\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[advisor-baseline] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
