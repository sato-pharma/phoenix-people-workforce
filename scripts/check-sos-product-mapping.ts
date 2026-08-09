// Two pre-closing checks over the Source-of-Sales product mapping.
//
// WHY THIS EXISTS. Between 2026-06-25 and 2026-08-09 every Pharma Overseas CNS row was matched
// by ITEM CODE rather than by product name, and two of those codes were wrong: item 7520
// (Rispadex syrup) pointed at Conviban 100 mg, and item 17214 (Tebofortin drops) pointed at the
// 40 mg tablet. 1,298 packs of one molecule were reported as another, every month, for seven
// months. Nothing failed. No total moved — a misfiled unit is still a unit — so neither the
// closing, the matrix, nor the manual cross-check could see it.
//
// Two root causes, both invisible to any existing gate:
//
//   1. A bulk load on 2026-06-25 wrote 23 Overseas item codes in a single second. Two products
//      ended up with TWO codes each (7520+8687 -> Conviban 100, 17212+17214 -> Tebofortine 40)
//      and, as the mirror of that, two products got NO code at all. A code list pasted beside a
//      product list rather than resolved item by item leaves exactly this signature.
//
//   2. A second bulk load on 2026-06-30 wrote 99 name aliases across 14 distributors — every
//      one of them Phoenix's OWN product name ("Conviban 100 mg"), which no distributor prints.
//      resolvers.ts is deliberately name-first; filling the name layer with unmatchable names
//      makes that design inert and silently demotes every row to the code layer.
//
// CHECK 1 catches cause 1 directly: one distributor must not point two item codes at the same
// product. That is legitimate occasionally (an old and a new code for the same SKU), so this
// check REPORTS rather than fails — but every real mis-map found in the incident showed up here.
//
// CHECK 2 catches the CONSEQUENCE, whatever the cause: a product with zero units at a
// distributor that carries the rest of its line. Egypt's largest distributor selling zero
// bottles of Rispadex syrup for seven straight months is not a sales fact, it is a mapping bug.
// This is the check that would have caught the incident in week one.
//
// Both helpers key their maps by NESTED Map, never by a joined string. An earlier revision
// joined on a separator and split it back out; one stray character in that separator silently
// mis-attributed every finding, and it cost a debugging cycle here. Keys stay structured.
//
// Read-only: two SELECTs, no writes.

import { createClient } from "@supabase/supabase-js";

export type AliasRow = { alias: string; distributor_code: string | null; product_code: string };
export type SalesRow = {
  distributor_code: string | null;
  official_line: string | null;
  product_code: string | null;
  qty: number;
};

export type DuplicateCodeFinding = {
  distributorCode: string;
  itemCodes: string[];
  productCode: string;
};

export type ZeroSalesFinding = {
  distributorCode: string;
  distributorPctOfLine: number;
  line: string;
  productCode: string;
  productPctOfLine: number;
  productUnitsElsewhere: number;
};

/** An alias that is only digits is the distributor's item code; anything else is a name. */
export function isItemCode(alias: string): boolean {
  return /^\d+$/.test(alias.trim());
}

/** Fetch-or-create the inner map, so callers never juggle undefined. */
function inner<K, V>(outer: Map<string, Map<K, V>>, key: string): Map<K, V> {
  const found = outer.get(key);
  if (found) return found;
  const created = new Map<K, V>();
  outer.set(key, created);
  return created;
}

/**
 * CHECK 1 — the same product reachable through two or more item codes at one distributor.
 * `IGNORE` is excluded: it is a bucket, and many unrelated codes legitimately land in it.
 */
export function findDuplicateItemCodes(rows: readonly AliasRow[]): DuplicateCodeFinding[] {
  // distributor -> product -> set of item codes
  const byDistributor = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const distributor = (row.distributor_code ?? "").trim();
    const product = (row.product_code ?? "").trim();
    if (!distributor || !product || product.toUpperCase() === "IGNORE") continue;
    if (!isItemCode(row.alias)) continue;
    const products = inner<string, Set<string>>(byDistributor, distributor);
    const codes = products.get(product) ?? new Set<string>();
    codes.add(row.alias.trim());
    products.set(product, codes);
  }

  const out: DuplicateCodeFinding[] = [];
  for (const [distributorCode, products] of byDistributor) {
    for (const [productCode, codes] of products) {
      if (codes.size < 2) continue;
      out.push({ distributorCode, itemCodes: [...codes].sort(), productCode });
    }
  }
  return out.sort(
    (a, b) => a.distributorCode.localeCompare(b.distributorCode) || a.productCode.localeCompare(b.productCode),
  );
}

/**
 * CHECK 2 — a product with ZERO units at a distributor that carries the rest of the line.
 *
 * Both thresholds matter. `minDistributorShare` keeps a tiny distributor from being expected to
 * stock the full range; `minProductShare` keeps a niche SKU from flagging against everyone. A
 * tender-only SKU legitimately shows zero at retail distributors, which is why the defaults are
 * not tighter — this check is a prompt to look, not a verdict.
 */
export function findZeroSalesGaps(
  rows: readonly SalesRow[],
  options: { minDistributorShare?: number; minProductShare?: number } = {},
): ZeroSalesFinding[] {
  const minDistributorShare = options.minDistributorShare ?? 0.02;
  const minProductShare = options.minProductShare ?? 0.01;

  // line -> distributor -> product -> units
  const byLine = new Map<string, Map<string, Map<string, number>>>();
  const lineUnits = new Map<string, number>();
  const distUnits = new Map<string, Map<string, number>>();
  const prodUnits = new Map<string, Map<string, number>>();

  const bump = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);

  for (const row of rows) {
    const line = (row.official_line ?? "").trim();
    const distributor = (row.distributor_code ?? "").trim();
    const product = (row.product_code ?? "").trim();
    if (!line || !distributor || !product || product.toUpperCase() === "IGNORE") continue;
    const qty = Number(row.qty) || 0;

    const distributors = inner<string, Map<string, number>>(byLine, line);
    const products = distributors.get(distributor) ?? new Map<string, number>();
    products.set(product, (products.get(product) ?? 0) + qty);
    distributors.set(distributor, products);

    lineUnits.set(line, (lineUnits.get(line) ?? 0) + qty);
    bump(inner<string, number>(distUnits, line), distributor, qty);
    bump(inner<string, number>(prodUnits, line), product, qty);
  }

  const out: ZeroSalesFinding[] = [];
  for (const [line, distributors] of byLine) {
    const total = lineUnits.get(line) ?? 0;
    if (total <= 0) continue;
    const perDistributor = distUnits.get(line) ?? new Map<string, number>();
    const perProduct = prodUnits.get(line) ?? new Map<string, number>();

    for (const distributor of distributors.keys()) {
      const dUnits = perDistributor.get(distributor) ?? 0;
      if (dUnits < minDistributorShare * total) continue;
      const sold = distributors.get(distributor) ?? new Map<string, number>();

      for (const [product, pUnits] of perProduct) {
        if (pUnits < minProductShare * total) continue;
        // Zero means BOTH "no row at all" and "rows that net to nothing" — a returns-only month
        // reads exactly like a missing mapping, and both deserve the same second look.
        if ((sold.get(product) ?? 0) !== 0) continue;
        out.push({
          distributorCode: distributor,
          distributorPctOfLine: Math.round((1000 * dUnits) / total) / 10,
          line,
          productCode: product,
          productPctOfLine: Math.round((1000 * pUnits) / total) / 10,
          productUnitsElsewhere: Math.round(pUnits),
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.line.localeCompare(b.line) ||
      b.productUnitsElsewhere - a.productUnitsElsewhere ||
      a.distributorCode.localeCompare(b.distributorCode),
  );
}

function projectRef(url: string | undefined): string {
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? "");
  return m ? m[1] : "unknown";
}

/** PostgREST caps a response at 1000 rows; the fact table is far larger, so page explicitly. */
async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await run(from, from + page - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < page) return out;
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }
  const supabase = createClient(url, key);
  console.log(`[sos-mapping] target project ref: ${projectRef(url)}`);

  const aliases = await fetchAll<AliasRow>((from, to) =>
    supabase
      .from("source_of_sales_product_aliases")
      .select("alias,distributor_code,product_code")
      .eq("active", true)
      .range(from, to),
  );
  const sales = await fetchAll<SalesRow>((from, to) =>
    supabase
      .from("source_of_sales_import_rows")
      .select("distributor_code,official_line,product_code,qty")
      .range(from, to),
  );
  console.log(`[sos-mapping] read ${aliases.length} active aliases and ${sales.length} imported rows`);

  const duplicates = findDuplicateItemCodes(aliases);
  console.log(
    `\n[sos-mapping] CHECK 1 — one distributor, two item codes on the same product: ${duplicates.length} case(s)`,
  );
  for (const d of duplicates) {
    console.log(`   ${d.distributorCode.padEnd(8)} ${d.productCode.padEnd(8)} codes: ${d.itemCodes.join(", ")}`);
  }
  if (duplicates.length) {
    console.log("   Legitimate when a distributor genuinely re-coded an SKU. NOT legitimate when the two codes");
    console.log("   are adjacent numbers or belong to different pack forms — that is how Rispadex syrup became");
    console.log("   Conviban 100. Check each pair against the distributor's own item list before a closing.");
  }

  const gaps = findZeroSalesGaps(sales);
  console.log(
    `\n[sos-mapping] CHECK 2 — product with zero units at a distributor that carries the line: ${gaps.length} case(s)`,
  );
  for (const g of gaps) {
    console.log(
      `   ${g.line.padEnd(14)} ${g.distributorCode.padEnd(8)} ${g.productCode.padEnd(8)} ` +
        `distributor ${String(g.distributorPctOfLine).padStart(5)}% of line, product ${String(g.productPctOfLine).padStart(5)}% ` +
        `(${g.productUnitsElsewhere} units sold elsewhere)`,
    );
  }
  if (gaps.length) {
    console.log("   A tender-only SKU legitimately shows zero at retail distributors. Anything else is a mapping");
    console.log("   bug until proven otherwise — a real distributor does not sell zero of a product it stocks.");
  }

  console.log(
    `\n[sos-mapping] done — ${duplicates.length} duplicate-code case(s), ${gaps.length} zero-sales case(s). ` +
      "Report only; nothing fails the build.",
  );
}

// Only run when invoked directly, so tests can import the pure helpers above.
if (process.argv[1] && /check-sos-product-mapping\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[sos-mapping] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
