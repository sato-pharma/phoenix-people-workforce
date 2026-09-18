import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { groupClosingCorrections } from "../src/lib/sales/closing-corrections.ts";
import type { ClosingCorrectionRow } from "../src/lib/sales/closing-corrections.ts";

// A TAKE-BACK IS MATCHED PHARMACY BY PHARMACY, SO THE MONTH'S OTHER SALES CANNOT HIDE IT.
//
// SoS audit, confirmed high: "Reversals masked by legitimate sales are never detected". The
// reversal detector saw a take-back only through the next month's WHOLE cell for that distributor
// (`neg.cell_units < 0`), so ordinary sales to other pharmacies that month cancelled it.
//
// Measured on production 2026-09-18, every month 2026-01..09:
//   Overseas, Pedia, Qalubeya, Lacto Advanced 2: +145 u in 2026-02, then the same pharmacies took
//     122 u / -32,940.00 EGP back in 2026-03. March's cell nets -35 u, under the old 50% bar: unlisted.
//   Overseas, Pedia, Alex West, Lacto Advanced 1: +109 u in 2026-04, then 61 u / -16,470.00 EGP back
//     in 2026-05. May's cell nets +13 u: nothing showed at all.
//   Five listed pairs were reported at the cell's net instead of the take-back, e.g. Overseas,
//     Gharbia 2 (Mahalla), Saginko, April: 194 u shown, 250 u taken back.
//
// Matching by pharmacy also keeps out what the audit's own count (23 pairs, 206,518.65 EGP, a sum of
// every negative import row) swept in: its lead example is one pharmacy's +200 line posted twice and
// taken back inside May, a same-month correction that leaves both months right.

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

/** SQL with comment lines stripped and whitespace collapsed. */
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** The text of one CTE, from its name to the next top-level CTE or the final select. */
function cte(statements: string, name: string): string {
  const start = statements.indexOf(`${name} as (`);
  assert.ok(start >= 0, `the migration must define the ${name} CTE`);
  const end = statements.indexOf(" ), ", start);
  return statements.slice(start, end < 0 ? undefined : end);
}

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

  // The original whole-cell test survives as the other half of the OR, with its thresholds, so no
  // pair it found is lost.
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

  // The take-back is the SAME pharmacy's return, matched to its OWN purchase the month before, in
  // the same distributor, area and product, and capped at what it bought then.
  const takenBack = cte(statements, "taken_back");
  for (const join of [
    "buy.cl_line = ret.cl_line",
    "buy.cl_dist = ret.cl_dist",
    "buy.cl_area = ret.cl_area",
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

  // A pharmacy's own buys and returns inside one month net FIRST, so a line posted twice and taken
  // back in the same month (the audit's lead example) never counts. A blank code is no identity.
  const clients = cte(statements, "clients");
  assert.ok(
    clients.includes(
      "group by f.period, f.official_line, b.distributor_code, f.area_code, f.product_code, btrim(f.client_code)",
    ),
    "clients must net each pharmacy within its month and cell",
  );
  assert.ok(clients.includes("nullif(btrim(f.client_code), '') is not null"), "blank client codes never match");
  assert.ok(clients.includes("b.status = 'validated'"), "validated batches only, as the rest of the page");
  assert.ok(
    clients.includes("not in ('la003', 'la004', 'ss001')"),
    "the same products are excluded as everywhere else on the page",
  );

  // What the row reports: the pharmacies' take-back when it qualifies, else the cell's net, and the
  // cell's net always in the new last column.
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
  assert.ok(reversal.includes("null::text, neg.cell_units from cells pos"), "reversal_pair returns the cell's net");
  assert.ok(
    /c\.cell_region, null::numeric from closing_cells c/.test(statements) &&
      /origin\.origin_units, null, null::text, null::numeric from \(/.test(statements),
    "net_negative and late_return return NULL for other_net_units",
  );

  // Replacing the function drops its ACL, so the migration must restate it.
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

  // The loader reads the column; the page no longer claims more than its thresholds can.
  assert.ok(LOADER_SOURCE.includes("row.other_net_units"), "the loader must read other_net_units");
  assert.ok(
    !VIEW_SOURCE.includes("Nothing on this page distorts"),
    "the all-clear must not claim nothing distorts the month — only that nothing clears the thresholds",
  );
  assert.ok(VIEW_SOURCE.includes("Smaller ones fall below this page&apos;s thresholds and are not listed."));
}
