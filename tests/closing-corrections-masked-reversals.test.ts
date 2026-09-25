import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COMPANY_DIRECT_LABEL, groupClosingCorrections } from "../src/lib/sales/closing-corrections.ts";
import type { ClosingCorrectionRow } from "../src/lib/sales/closing-corrections.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

// A TAKE-BACK IS MATCHED PHARMACY BY PHARMACY, SO THE MONTH'S OTHER SALES CANNOT HIDE IT, AND A
// SAME-MONTH CORRECTION NEVER COUNTS.
//
// SoS audit, confirmed high: "Reversals masked by legitimate sales are never detected". The
// reversal detector saw a take-back only through the next month's WHOLE cell for that distributor
// (`neg.cell_units < 0`), so ordinary sales to other pharmacies that month cancelled it.
//
// 20260918165553 read every return ROW instead, and grew the section from 6 pairs to 36. A return
// row does not say which sale it undoes: 19 of the 30 new pairs came from a pharmacy that returned
// and bought at least as much again the same month. The audit's lead example is one — Overseas,
// Menoufia 1, Saginko, May 2026: Adam Pharma bought 200 in April, and May's file has +200, +200,
// -200 on consecutive lines, a line posted twice and taken back. The owner chose (2026-09-18) to
// combine the fixes: keep that migration's region key for a no-area Direct row, and count a
// take-back only against the SAME pharmacy's purchase the month before.
//
// Measured on production 2026-09-18, every page 2026-01..09: 10 pairs, among them
//   Overseas, Pedia, Qalubeya, Lacto Advanced 2: +145 u in 2026-02, then the same pharmacies took
//     122 u / -32,940.00 EGP back in 2026-03. March's cell nets -35 u, under the old 50% bar.
//   Overseas, Pedia, Alex West, Lacto Advanced 1: +109 u in 2026-04, then 61 u / -16,470.00 EGP back
//     in 2026-05. May's cell nets +13 u: nothing showed at all.
//   Direct (Company), Delta (1), Lacto Advanced 2: +648 in 2026-03, then 432 back (-83,160.00),
//     found only because the region key keeps Delta (1)'s Direct row apart from the other regions'.

const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);

const LOADER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/closing-corrections.ts", import.meta.url)),
  "utf8",
);
const VIEW_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/sales/closing-corrections-view.tsx", import.meta.url)),
  "utf8",
);

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

/** SQL with comments stripped and whitespace collapsed. */
function statementsOf(sql: string): string {
  return stripSqlComments(sql).toLowerCase().replace(/\s+/g, " ");
}

/** The text of one CTE, from its name to the next top-level CTE or the final select. */
function cte(statements: string, name: string): string {
  const start = statements.indexOf(` ${name} as (`);
  assert.ok(start >= 0, `the migration must define the ${name} CTE`);
  const end = statements.indexOf(" ), ", start);
  return statements.slice(start, end < 0 ? undefined : end);
}

const REGION_KEY = (alias: string) =>
  `case when ${alias}.is_direct and btrim(coalesce(${alias}.area_code, '')) = '' then upper(btrim(coalesce(${alias}.region_code, ''))) end`;

function pair(overrides: Partial<ClosingCorrectionRow>): ClosingCorrectionRow {
  return {
    kind: "reversal_pair",
    period: "2026-02",
    otherPeriod: "2026-03",
    line: "Pedia",
    distributorCode: "PS",
    distributorName: "Overseas",
    areaCode: "D11",
    areaName: "Qalubeya",
    regionCode: null,
    productCode: "LA002",
    productName: "Lacto Advanced 2",
    clientName: null,
    units: 145,
    value: 39_150,
    otherUnits: -122,
    otherValue: -32_940,
    otherNetUnits: -35,
    ...overrides,
  };
}

export async function runClosingCorrectionsMaskedReversalsTests(): Promise<void> {
  const statements = statementsOf(correctionsMigration());
  const reversal = statements.slice(
    statements.indexOf("select 'reversal_pair'::text"),
    statements.indexOf("union all"),
  );
  const reversalWhere = reversal.slice(reversal.indexOf(" where pos.cell_units >= 50"));

  // HEADLINE — a pair is found from the same pharmacies' take-back, not only from the next month's
  // whole-cell net. Without it, 122 units of Lacto Advanced 2 taken back in Qalubeya are invisible
  // because the month's other sales leave the cell at -35.
  assert.ok(
    reversalWhere.includes("or h.clients_hit)"),
    "a reversal pair must be found from the same pharmacies' take-back (h.clients_hit), not only " +
      "from the next month's whole-cell net, which the month's other sales cancel. " +
      `Found: ${reversalWhere.slice(0, 320)}`,
  );

  // The owner's choice: a return ROW is not a take-back. Counting every negative row (the rule this
  // replaced) reports Adam Pharma's +200, +200, -200 inside May as April's sale being undone.
  assert.ok(
    !statements.includes("phx_sos_rows_attributed") && !statements.includes("ret.ret_units"),
    "a take-back must be matched pharmacy by pharmacy, never read from every return row — a line " +
      "posted twice and taken back in the same month undoes nothing in the month before",
  );

  // The original whole-cell test survives as the other half of the OR, with its thresholds, so no
  // pair it found is lost — the two Delta (1) Direct pairs among them.
  assert.ok(
    reversalWhere.includes(
      "and ((neg.cell_units < 0 and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units) or h.clients_hit)",
    ),
    `the whole-cell test must stay as the other half of the OR. Found: ${reversalWhere.slice(0, 320)}`,
  );
  assert.ok(reversalWhere.startsWith(" where pos.cell_units >= 50 "), "the 50-unit floor on the posting stays");
  assert.ok(
    reversal.includes(
      "select coalesce(tb.tb_units, 0) between 0.5 * pos.cell_units and 1.5 * pos.cell_units as clients_hit",
    ),
    "the take-back uses the same 50%-150% band as the whole-cell test",
  );
  assert.ok(
    reversalWhere.includes("and (pos.cell_period = pr.cur or neg.cell_period = pr.cur)"),
    "a pair still touches the requested month",
  );

  // The take-back is the SAME pharmacy's return, matched to its OWN purchase the month before, in
  // the same distributor, area (or Direct region) and product, and capped at what it bought then.
  const takenBack = cte(statements, "taken_back");
  for (const join of [
    "buy.cl_line = ret.cl_line",
    "buy.cl_dist = ret.cl_dist",
    "buy.cl_area = ret.cl_area",
    "buy.cl_region is not distinct from ret.cl_region",
    "buy.cl_product = ret.cl_product",
    "buy.cl_client = ret.cl_client",
    "buy.cl_period = to_char((ret.cl_period || '-01')::date - interval '1 month', 'yyyy-mm')",
  ]) {
    assert.ok(takenBack.includes(join), `taken_back must match ${join}`);
  }
  assert.ok(takenBack.includes("where ret.cl_units < 0 and buy.cl_units > 0"), "a return matched to a purchase");
  assert.ok(
    takenBack.includes("sum(least(-ret.cl_units, buy.cl_units)) as tb_units"),
    "a pharmacy's take-back is capped at what it bought the month before",
  );
  assert.ok(
    /left join taken_back tb on tb\.tb_line = neg\.cell_line and tb\.tb_dist = neg\.cell_dist and tb\.tb_area = neg\.cell_area and tb\.tb_region is not distinct from neg\.cell_region and tb\.tb_product = neg\.cell_product and tb\.tb_period = neg\.cell_period/.test(
      reversal,
    ),
    "the take-back must be joined to the second month's cell on every key it carries, region included",
  );

  // A pharmacy's own buys and returns inside one month net FIRST, so a line posted twice and taken
  // back in the same month never counts. A blank code is no identity.
  const clients = cte(statements, "clients");
  assert.ok(
    clients.includes(
      `group by f.period, f.official_line, b.distributor_code, f.area_code, ${REGION_KEY("f")}, f.product_code, btrim(f.client_code)`,
    ),
    `clients must net each pharmacy within its month and cell, region included. Found: ${clients.slice(-360)}`,
  );
  assert.ok(clients.includes("nullif(btrim(f.client_code), '') is not null"), "blank client codes never match");
  assert.ok(clients.includes("b.status = 'validated'"), "validated batches only, as the rest of the page");
  assert.ok(
    clients.includes("not in ('la003', 'la004', 'ss001')"),
    "the same products are excluded as everywhere else on the page",
  );

  // The per-distributor cells keep the region key, so two regions' no-area Direct rows are never
  // joined into one pair.
  assert.ok(cte(statements, "cells").includes(`${REGION_KEY("f")} as cell_region`), "cells carry the Direct region");
  assert.ok(
    reversal.includes("neg.cell_region is not distinct from pos.cell_region"),
    "a reversal pair must never join two regions' no-area Direct rows",
  );

  // What the row reports: the pharmacies' take-back when it qualifies, else the cell's net; the
  // cells' region; and the cell's net always in the new last column.
  assert.ok(
    reversal.includes("case when h.clients_hit then -tb.tb_units else neg.cell_units end"),
    "a qualifying take-back is reported at its own size, not at the cell's net",
  );
  assert.ok(
    reversal.includes("case when h.clients_hit then tb.tb_value else neg.cell_value end"),
    "the value follows the same choice as the units",
  );
  assert.ok(
    /returns table\([^)]*region_code text, other_net_units numeric\)/.test(statements),
    "other_net_units must be the function's last column",
  );
  assert.ok(
    reversal.includes("pos.cell_region, neg.cell_units from cells pos"),
    "reversal_pair returns the cells' region, then the cell's net",
  );
  assert.ok(
    /c\.cell_region, null::numeric from closing_cells c/.test(statements) &&
      /origin\.origin_units, null, null::text, null::numeric from \(/.test(statements),
    "net_negative and late_return return NULL for other_net_units",
  );

  // Replacing the function drops its ACL, so the migration must restate it. Nothing here calls a
  // parallel-unsafe function any more, so it is PARALLEL SAFE again.
  assert.ok(statements.includes("stable parallel safe security definer"), "function attributes preserved");
  assert.ok(statements.includes("set statement_timeout to '45s'"), "statement timeout preserved");
  assert.ok(
    statements.includes("revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated"),
    "the function must stay closed to public, anon and authenticated",
  );
  assert.ok(
    statements.includes("grant execute on function public.phx_closing_corrections(text) to service_role"),
    "the service role must keep EXECUTE after the drop and recreate",
  );

  // The sentence says how much of the take-back the month's total shows.
  const grouped = groupClosingCorrections(
    [
      pair({}),
      pair({
        period: "2026-04",
        otherPeriod: "2026-05",
        areaCode: "AB3",
        areaName: "Alex West",
        productCode: "LA001",
        productName: "Lacto Advanced 1",
        units: 109,
        value: 29_430,
        otherUnits: -61,
        otherValue: -16_470,
        otherNetUnits: 13,
      }),
      pair({
        period: "2026-04",
        otherPeriod: "2026-05",
        line: "CNS",
        distributorCode: "SF",
        distributorName: "sofico",
        areaCode: "CA4",
        areaName: "Cairo East 2",
        productCode: "CO002",
        productName: "Conviban 25mg/ml Syp",
        units: 80,
        value: 2_835,
        otherUnits: -80,
        otherValue: -2_835,
        otherNetUnits: -80,
      }),
    ],
    "2026-03",
  );
  assert.equal(grouped.reversalPairs.length, 3);
  assert.equal(grouped.isEmpty, false, "a masked reversal must stop the page's all-clear");
  const [partly, hidden, whole] = grouped.reversalPairs;
  assert.equal(partly!.areaName, "Qalubeya", "biggest take-back first");
  assert.equal(partly!.negativeUnits, -122, "the take-back, not the cell's -35");
  assert.equal(partly!.negativeMonthNetUnits, -35);
  assert.ok(
    partly!.impact.includes("took 122 units back in 2026-03") &&
      partly!.impact.includes("Overseas's other 2026-03 sales here hide part of it") &&
      partly!.impact.includes("reads -35 units"),
    `a partly hidden take-back must say how much the month shows. Got: ${partly!.impact}`,
  );
  assert.ok(
    hidden!.impact.includes("hide it: its 2026-05 total for this area and product still reads +13 units."),
    `a wholly hidden take-back must say the month still reads positive. Got: ${hidden!.impact}`,
  );
  assert.ok(!whole!.impact.includes("hide"), `nothing to add when the net shows it all. Got: ${whole!.impact}`);

  // A database older than the column sends no net: the sentence is the plain one, never a guess.
  const legacyRow: ClosingCorrectionRow = { ...pair({}) };
  delete legacyRow.otherNetUnits;
  const legacy = groupClosingCorrections([legacyRow], "2026-03");
  assert.ok(!legacy.reversalPairs[0]!.impact.includes("hide"));
  assert.equal(legacy.reversalPairs[0]!.negativeMonthNetUnits, null);

  // A no-area Direct pair is its REGION's, named the way the closing names it, and two regions'
  // pairs are two situations.
  const directPair = (regionCode: string, regionName: string, units: number, otherUnits: number) =>
    pair({
      period: "2026-03",
      otherPeriod: "2026-04",
      distributorCode: "DIRECT",
      distributorName: "Direct (Company)",
      areaCode: "",
      areaName: `${COMPANY_DIRECT_LABEL} · ${regionName}`,
      regionCode,
      units,
      value: units * 192.5,
      otherUnits,
      otherValue: otherUnits * 192.5,
      otherNetUnits: otherUnits,
    });
  const direct = groupClosingCorrections(
    [directPair("D1", "Delta (1)", 648, -432), directPair("D2", "Delta (2)", 80, -60)],
    "2026-04",
  );
  assert.equal(direct.reversalPairs.length, 2);
  assert.equal(direct.situationCount, 2, "two regions' Direct pairs are two situations, not one");
  assert.deepEqual(
    direct.reversalPairs.map((row) => row.areaName).sort(),
    [`${COMPANY_DIRECT_LABEL} · Delta (1)`, `${COMPANY_DIRECT_LABEL} · Delta (2)`],
  );
  assert.ok(!direct.reversalPairs[0]!.impact.includes("hide"), "a Direct pair's net is its whole take-back");

  // The loader reads the column; the page no longer claims more than its thresholds can.
  assert.ok(LOADER_SOURCE.includes("row.other_net_units"), "the loader must read other_net_units");
  assert.ok(
    !VIEW_SOURCE.includes("Nothing on this page distorts"),
    "the all-clear must not claim nothing distorts the month — only that nothing clears the thresholds",
  );
  assert.ok(VIEW_SOURCE.includes("Smaller ones fall below this page&apos;s thresholds and are not listed."));
}
