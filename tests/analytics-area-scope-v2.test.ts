import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Two surfaces that could not honour an area bound, handled in the only honest ways available.
//
// 1. RECONCILIATION. analytics_cross_source takes only p_lines; its view aggregates all three legs
//    to (period, line), so there is nothing to push a bound into. (The closing leg does now carry a
//    territory, since it reads SoS Monthly Closing — but cross_source_period_line still sums it
//    away, so the refusal below stands until that view is re-cut at area grain.)
//    A geography-scoped viewer was served whole-line NATIONAL SoS / Closing / Weekly /
//    TARGET totals on a page presenting itself as their scope, with the region picker hidden. Until
//    the view is re-cut, refusing beats showing a manager national figures they will read as theirs.
//
// 2. TERRITORY ALIASES. A partial unique index makes the two-active-rows state — which makes an
//    alias resolve to NOTHING — impossible from any writer, not just the one that was fixed.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])(--|\/\/)[^\n]*/g, "$1");
}

export function runAnalyticsAreaScopeV2Tests() {
  // ── 1. Reconciliation refuses an area-scoped viewer ─────────────────────────
  {
    const dash = code(
      readFileSync(join(process.cwd(), "src/components/analytics/dashboards/reconciliation-dashboard.tsx"), "utf8"),
    );
    assert.match(
      dash,
      /if \(scope\.allowedAreaCodes != null\) \{/,
      "an area-scoped viewer must be refused before any cross-source load",
    );
    assert.match(dash, /<AnalyticsErrorState/, "the refusal must be visible, not an empty page");

    // The guard must come BEFORE the loaders, or the national query still runs.
    const guardAt = dash.indexOf("scope.allowedAreaCodes != null");
    const loadAt = dash.indexOf("loadCrossSource(");
    assert.ok(guardAt > 0 && loadAt > guardAt, "the refusal must short-circuit ahead of loadCrossSource");

    // It must key on the AREA bound specifically. allowedRegionCodes is deliberately widened to
    // reach an owned out-of-region area, so gating on it would refuse the wrong people.
    assert.ok(
      !/if \(scope\.allowedRegionCodes != null\) \{/.test(dash),
      "gate on the area bound, not the widened region set",
    );
  }

  // ── 2. One active target per alias, enforced by the database ────────────────
  {
    const file = readdirSync(join(process.cwd(), "supabase/migrations")).find((f) =>
      f.includes("territory_alias_single_active_target"),
    );
    assert.ok(file, "the alias uniqueness migration must exist");
    const sql = code(readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"));

    assert.match(
      sql,
      /create unique index if not exists[\s\S]{0,200}\(normalized_alias, target_type\)/,
      "uniqueness must be on (normalized_alias, target_type) — NOT including target_code, which is the bug",
    );
    assert.match(
      sql,
      /where active/,
      "partial on active: deactivated rows are the audit trail of what an alias used to point at",
    );
    assert.ok(
      !/target_code\s*\)/.test(sql.slice(sql.indexOf("create unique index"), sql.indexOf("comment on index"))),
      "including target_code in the key would permit exactly the two-active-rows state this prevents",
    );
  }
}
