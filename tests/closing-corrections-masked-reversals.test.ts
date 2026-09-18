import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COMPANY_DIRECT_LABEL, groupClosingCorrections } from "../src/lib/sales/closing-corrections.ts";
import type { ClosingCorrectionRow } from "../src/lib/sales/closing-corrections.ts";

// A REVERSAL IS FOUND BY WHAT WAS TAKEN BACK, NOT BY THE NEXT MONTH'S NET.
//
// SoS audit, confirmed high: "Reversals masked by legitimate sales are never detected - 23 real
// pairs worth 206,518.65 EGP are invisible". `phx_closing_corrections` reported a reversal pair only
// when the second month's NET for that distributor, area and product was itself the reversal
// (`neg.cell_units < 0`). A distributor that took most of a posting back while also selling
// normally in that cell netted positive, so the pair never appeared, and on a quiet month the page
// printed its all-clear over it.
//
// Measured on production 2026-09-18, 2026-01 to 2026-09, with the function's own rules:
//   before   6 pairs
//   after   36 pairs: the 6, 2 no-area Direct pairs of Delta (1) that only region keying reveals,
//           and 28 masked by ordinary sales, returns worth -278,193.31 EGP. Among them the audit's
//           own two examples:
//             Anti Infective Saginko, Pharma Overseas, D15, Feb +267 -> March -300 back, net +277
//             Anti Infective Saginko, Pharma Overseas, D12, April +480 -> May -251 back, net +434

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

/** The newest migration defining phx_closing_corrections — the one that wins at deploy time. */
function correctionsMigration(): string {
  const names = readdirSync(fileURLToPath(MIGRATIONS_URL))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const defining = names.filter((name) =>
    readFileSync(new URL(name, MIGRATIONS_URL), "utf8").includes("FUNCTION public.phx_closing_corrections"),
  );
  assert.ok(defining.length > 0, "no migration defines phx_closing_corrections");
  return readFileSync(new URL(defining[defining.length - 1]!, MIGRATIONS_URL), "utf8");
}

/** SQL with comment lines stripped and whitespace collapsed. */
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pairRow(overrides: Partial<ClosingCorrectionRow>): ClosingCorrectionRow {
  return {
    kind: "reversal_pair",
    period: "2026-04",
    otherPeriod: "2026-05",
    line: "Anti Infective",
    distributorCode: "PS",
    distributorName: "overseas",
    areaCode: "D12",
    areaName: "Menoufia 1",
    regionCode: null,
    productCode: "SA001",
    productName: "Saginko",
    clientName: null,
    units: 480,
    value: 53_352,
    otherUnits: -251,
    otherValue: -27_898.65,
    ...overrides,
  };
}

export async function runClosingCorrectionsMaskedReversalsTests(): Promise<void> {
  const statements = statementsOf(correctionsMigration());
  const reversal = statements.slice(
    statements.indexOf("select 'reversal_pair'::text"),
    statements.indexOf("select 'net_negative'::text"),
  );
  assert.ok(reversal.length > 0, "expected a reversal_pair branch before the net_negative one");

  // HEADLINE — the second month's RETURNS are a reversal on their own, under the same 50%-150%
  // band. Without this branch Pharma Overseas' 251 Saginko units taken back from D12 in May are
  // invisible, because 685 units of ordinary May sales keep that cell's net at +434.
  assert.ok(
    reversal.includes(
      "or (ret.ret_units < 0 and abs(ret.ret_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)",
    ),
    "a reversal pair must also be reported when the second month's RETURNS are the reversal, " +
      "whatever that month's ordinary sales do to its net — otherwise a masked reversal is never " +
      `detected and the page prints its all-clear over it. Found: ${reversal.slice(reversal.indexOf(" where "), reversal.indexOf(" where ") + 400)}`,
  );

  // The returns are the cell's own negative rows, from the attributed feed the fact rollup is
  // built from, so they land in the same area as the sale they reverse. The rollup keeps one row per
  // client and nets a client's same-month return into its own purchases: it finds neither of the
  // audit's two named examples.
  const returns = statements.slice(statements.indexOf("returns as materialized ("), statements.indexOf("closing_cells as ("));
  assert.ok(returns.length > 0, "the returns CTE must exist, MATERIALIZED, and come before closing_cells");
  assert.ok(
    returns.includes("cross join lateral public.phx_sos_rows_attributed(m.period) a"),
    "returns must read the attributed rows, not the per-client rollup",
  );
  assert.ok(/where a\.qty < 0 /.test(returns), "returns must read the negative rows only");
  assert.ok(
    returns.includes("upper(btrim(coalesce(a.product_code, ''))) not in ('la003', 'la004', 'ss001')"),
    "returns must exclude the same products as the cells they are matched to",
  );
  assert.ok(
    /select pr\.cur as period from periods pr union all select pr\.next from periods pr/.test(returns),
    "returns must cover both months a pair's second month can be: this period and the next",
  );
  assert.ok(
    returns.includes("b.distributor_code as ret_dist") && returns.includes("b.status = 'validated' and b.period = m.period"),
    "returns must be per distributor, from the validated batch of that month, like the cells",
  );

  // Matched to the second month's cell on every key the cells carry, region included.
  assert.ok(
    /left join returns ret on ret\.ret_period = neg\.cell_period and ret\.ret_line = neg\.cell_line and ret\.ret_dist = neg\.cell_dist and ret\.ret_area = neg\.cell_area and ret\.ret_region is not distinct from neg\.cell_region and ret\.ret_product = neg\.cell_product/.test(
      reversal,
    ),
    "returns must be joined to the second month's cell on period, line, distributor, area, region and product",
  );

  // Nothing reported before is lost: the net rule stays, and so do the thresholds.
  assert.ok(
    reversal.includes(
      "(neg.cell_units < 0 and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)",
    ),
    "the old net rule must stay, so no pair reported today disappears",
  );
  assert.ok(reversal.includes("where pos.cell_units >= 50 "), "the 50-unit floor on the posting is unchanged");
  assert.ok(
    reversal.includes("and (pos.cell_period = pr.cur or neg.cell_period = pr.cur)"),
    "a pair still touches the requested month",
  );

  // The pair shows what was taken back, which is what its sentence always said.
  assert.ok(
    reversal.includes("coalesce(ret.ret_units, neg.cell_units), round(coalesce(ret.ret_value, neg.cell_value)::numeric, 2)"),
    "other_units / other_value must be the second month's returns, with the net only as a fallback",
  );

  // The page tells the masked pair like any other: the distributor's name, what it posted, and what
  // it took back, never the net that hid it.
  const masked = groupClosingCorrections([pairRow({})], "2026-05");
  assert.equal(masked.reversalPairs.length, 1);
  assert.equal(masked.isEmpty, false, "a masked reversal must stop the page's all-clear");
  const [pair] = masked.reversalPairs;
  assert.equal(pair!.negativeUnits, -251);
  assert.ok(
    pair!.impact.startsWith("overseas posted +480 units (53,352.00 EGP) in 2026-04, then took 251 units back in 2026-05"),
    `the sentence must name what was taken back. Got: ${pair!.impact}`,
  );

  // A no-area Direct pair is its REGION's, named the way the closing names it, and two regions'
  // pairs are two situations.
  const direct = groupClosingCorrections(
    [
      pairRow({
        period: "2026-03",
        otherPeriod: "2026-04",
        line: "Pedia",
        distributorCode: "DIRECT",
        distributorName: "Direct (Company)",
        areaCode: "",
        areaName: `${COMPANY_DIRECT_LABEL} · Delta (1)`,
        regionCode: "D1",
        productCode: "LA002",
        productName: "Lacto Advanced 2",
        units: 648,
        value: 124_740,
        otherUnits: -432,
        otherValue: -83_160,
      }),
      pairRow({
        period: "2026-03",
        otherPeriod: "2026-04",
        line: "Pedia",
        distributorCode: "DIRECT",
        distributorName: "Direct (Company)",
        areaCode: "",
        areaName: `${COMPANY_DIRECT_LABEL} · Delta (2)`,
        regionCode: "D2",
        productCode: "LA002",
        productName: "Lacto Advanced 2",
        units: 80,
        value: 15_400,
        otherUnits: -60,
        otherValue: -11_550,
      }),
    ],
    "2026-04",
  );
  assert.equal(direct.reversalPairs.length, 2);
  assert.equal(direct.situationCount, 2, "two regions' Direct pairs are two situations, not one");
  assert.deepEqual(
    direct.reversalPairs.map((row) => row.areaName).sort(),
    [`${COMPANY_DIRECT_LABEL} · Delta (1)`, `${COMPANY_DIRECT_LABEL} · Delta (2)`],
  );
}
