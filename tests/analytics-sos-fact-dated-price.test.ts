import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// THE ANALYTICS FACT VIEWS VALUE EACH MONTH AT THAT MONTH'S FACTORY PRICE — 2026-10-01.
//
// Saginko (SA001) is 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28); the product
// master stays 111.15 and the dated price lives in source_of_sales_product_price_history. The closing
// and attribution FUNCTIONS were repointed on 2026-09-28, but the two analytics VIEWS were not: both
// valued a distributor row as `effective_units * coalesce(p.factory_price, 0)` — the flat master price —
// in every month. analytics.sos_fact_all feeds the CEO command center's IMS contribution panel
// (src/lib/sales/sfe-performance.ts), so from October Saginko would have entered its area shares at
// 111.15 beside a closing at 170.52.
//
// The fix inlines the dated lookup instead of calling public.phx_factory_price(): a view runs the
// functions it calls with the READER's rights, and that function is executable by service_role and
// postgres only, so analytics_readonly and analytics_privileged would have been refused. This test reads
// the NEWEST migration that defines each view — so a later re-creation copied from an old definition
// fails here, not on a screen.
//
// Verified on staging and production when applied: all 18 view-month totals for January–September
// unchanged to the cent; a rolled-back probe through the views priced 10 October Saginko units at
// 1,705.20 and 10 September units at 1,111.50.

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const THIS_MIGRATION = "20261001065652_analytics_sos_fact_dated_price.sql";

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The body of `create or replace view analytics.<view> as …;` in the newest migration that defines it. */
function newestDefinition(view: string): { file: string; body: string } {
  const header = new RegExp(`create\\s+or\\s+replace\\s+view\\s+analytics\\.${view}\\s+as\\b`, "i");
  const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
  for (const file of [...files].reverse()) {
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    const match = header.exec(sql);
    if (!match) continue;
    const rest = sql.slice(match.index);
    const end = rest.indexOf(";");
    return { file, body: end > 0 ? rest.slice(0, end) : rest };
  }
  throw new Error(`no migration defines analytics.${view}`);
}

const squash = (sql: string) => sql.replace(/\s+/g, " ").toLowerCase();

export function runAnalyticsSosFactDatedPriceTests() {
  for (const view of ["sos_fact", "sos_fact_all"]) {
    const { file, body } = newestDefinition(view);
    const sql = squash(body);

    assert.equal(
      file,
      THIS_MIGRATION,
      `control: the newest migration defining analytics.${view} is the dated-price one (found ${file}) — if a newer one ` +
        "re-creates the view, it must carry the same lookup, and this pin moves with it",
    );
    assert.match(
      sql,
      /else \(f\.effective_units \* coalesce\(dated\.factory_price, p\.factory_price, \(0\)::numeric\)\)/,
      `analytics.${view} values a distributor row at the dated price covering its month, else the master price — ` +
        "never the master's flat price alone (Saginko 170.52 from 2026-10, 111.15 before)",
    );
    assert.doesNotMatch(
      sql,
      /f\.effective_units \* coalesce\(p\.factory_price, \(0\)::numeric\)/,
      `analytics.${view} no longer values a row at the flat master price`,
    );
    assert.match(
      sql,
      /left join lateral \( select h\.factory_price from public\.source_of_sales_product_price_history h where upper\(btrim\(h\.product_code\)\) = upper\(btrim\(f\.product_code\)\) and h\.effective_period <= f\.period order by h\.effective_period desc limit 1 \) dated on true/,
      `analytics.${view} looks up the newest override at or before the row's own period — public.phx_factory_price's exact rule`,
    );
    assert.doesNotMatch(
      sql,
      /phx_factory_price\s*\(/,
      `analytics.${view} must not CALL phx_factory_price: a view runs functions with the reader's rights, and ` +
        "analytics_readonly / analytics_privileged cannot execute it",
    );
    assert.match(sql, /when f\.is_direct then f\.direct_value/, `analytics.${view}: a direct row keeps its own deal value`);
  }

  // Each view is otherwise what it was: sos_fact keeps its confidential exclusion and region fallback;
  // sos_fact_all keeps neither, exactly as before.
  const fact = squash(newestDefinition("sos_fact").body);
  assert.match(
    fact,
    /<> all \(array\['la003'::text, 'la004'::text, 'ss001'::text\]\)/,
    "analytics.sos_fact still excludes the three restricted products",
  );
  assert.match(fact, /coalesce\(ar\.region_name, rg\.region_name, f\.region_code\) as region_name/, "and keeps its region-name fallback");
  const all = squash(newestDefinition("sos_fact_all").body);
  assert.doesNotMatch(all, /'la003'/, "analytics.sos_fact_all still carries every product, as before");
}
