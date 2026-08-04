import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateCustomerRows, type CustomerRow } from "../src/lib/sales/sos-dashboard.ts";

// "Top Customers" is fed by phx_exec_customers, which the dashboard calls ONCE PER SELECTED MONTH
// and then flattens. The brick panel aggregates that flat list before ranking; the customer panel
// did not, so a customer who bought in N of the selected months held N of the 15 visible rows.
//
// Production, 2026-06 + 2026-07: 19,178 flattened rows over 16,248 distinct (client, distributor)
// pairs. Customer 0001571865/PS (184,140.00, truly #3) showed as 132,570.00 at rank 5 plus
// 51,570.00 at rank 16, and 0001577318/PS (65,801.25) and 0001582319/PS (64,911.38) were pushed off
// the panel entirely. Over all 7 available months only 11 DISTINCT customers held the 15 rows and
// the top-10 share read 4,864,637.25 instead of 6,000,207.30 — understated by 18.9%.
//
// The composite key is not a new idea here: summary.customerCount already keyed a Set on
// `${distributorCode}::${clientCode}`. It was simply never applied to the ranking.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function customer(overrides: Partial<CustomerRow>): CustomerRow {
  return {
    areaCode: "AR1",
    clientCode: "0001571865",
    clientName: "Pharmacy",
    distributorCode: "PS",
    regionCode: "RG1",
    units: 1,
    value: 0,
    ...overrides,
  };
}

/** The ranking the panel performs on whatever row set it is handed. */
const rank = (rows: CustomerRow[]) => [...rows].sort((left, right) => right.value - left.value);

export function runSosTopCustomersAggregationTests() {
  // ── One customer, one row, however many months are selected ─────────────────
  {
    // Newest month first, exactly as fetchGeo flattens selectedPeriods (sorted descending).
    const flattened = [
      customer({ clientCode: "0001571865", units: 60, value: 132570 }),
      customer({ clientCode: "0001571865", units: 24, value: 51570 }),
    ];
    const aggregated = aggregateCustomerRows(flattened);

    assert.equal(aggregated.length, 1, "two selected months of one customer are one customer, not two ranked rows");
    assert.equal(
      aggregated[0]?.value,
      184140,
      "the customer's revenue is the sum of the selected months — 132,570 + 51,570 is their real spend, and is what the owner ranks them by",
    );
    assert.equal(aggregated[0]?.units, 84, "units aggregate alongside value, or the panel's price-per-unit reads wrong");
  }

  // ── The split reordered the panel and evicted genuine top-15 customers ──────
  {
    const flattened = [
      customer({ clientCode: "0001571865", value: 132570 }),
      customer({ clientCode: "0001571865", value: 51570 }),
      customer({ clientCode: "0001558912", value: 162000 }),
      customer({ clientCode: "0001577318", value: 65801.25 }),
    ];

    assert.deepEqual(
      rank(flattened).map((row) => row.value),
      [162000, 132570, 65801.25, 51570],
      "documents the defect: ranking the flattened rows hides the biggest customer behind a smaller one and spends two rows on him",
    );

    const after = rank(aggregateCustomerRows(flattened));
    assert.deepEqual(
      after.map((row) => row.clientCode),
      ["0001571865", "0001558912", "0001577318"],
      "aggregated, the true #1 leads and the row his duplicate consumed goes back to a real customer",
    );
    assert.deepEqual(
      after.map((row) => row.value),
      [184140, 162000, 65801.25],
      "every visible customer must be shown at their full multi-month value",
    );
  }

  // ── client_code is NOT unique across distributors ───────────────────────────
  {
    const aggregated = aggregateCustomerRows([
      customer({ clientCode: "1011654", distributorCode: "RM", value: 100 }),
      customer({ clientCode: "1011654", distributorCode: "PS", value: 40 }),
    ]);

    assert.equal(
      aggregated.length,
      2,
      "two distributors reuse the same client_code for two different pharmacies — keying on the code alone merges strangers' sales",
    );
    assert.deepEqual(
      rank(aggregated).map((row) => row.value),
      [100, 40],
      "neither pharmacy may absorb the other's revenue",
    );
  }

  // ── Display fields come from the newest month that actually has them ────────
  {
    const aggregated = aggregateCustomerRows([
      customer({ clientName: "El Ezaby Nasr City", regionCode: "RG9", value: 10 }),
      customer({ clientName: "El Ezaby", regionCode: "RG1", value: 5 }),
    ]);
    assert.equal(
      aggregated[0]?.clientName,
      "El Ezaby Nasr City",
      "rows arrive newest-first, so the newest label the RPC resolved is the one the panel shows",
    );
    assert.equal(aggregated[0]?.regionCode, "RG9", "a customer that moved region must display where they are now, not where they were");
  }

  {
    const aggregated = aggregateCustomerRows([
      customer({ areaCode: "", clientName: "", regionCode: "", value: 10 }),
      customer({ areaCode: "AR7", clientName: "El Ezaby", regionCode: "RG3", value: 5 }),
    ]);
    assert.equal(aggregated[0]?.clientName, "El Ezaby", "a blank name on the newest month must not blank out a name an earlier month supplied");
    assert.equal(aggregated[0]?.regionCode, "RG3", "same for region — the panel would otherwise show an empty column for a real customer");
    assert.equal(aggregated[0]?.areaCode, "AR7", "same for area");
  }

  // ── Wiring: the panel must rank the aggregated set, not the raw rows ────────
  // This is the half that regressed. aggregateCustomerRows can be perfect while the dashboard still
  // ranks customerRows, and the BI workbook export reads the very same topCustomers.
  {
    const dashboard = stripComments(read("src/lib/sales/sos-dashboard.ts"));

    assert.match(
      dashboard,
      /const aggregatedCustomers = aggregateCustomerRows\(customerRows\)/,
      "the dashboard must collapse the per-period customer rows before it ranks them",
    );
    assert.match(
      dashboard,
      /const sortedCustomers = \[\.\.\.aggregatedCustomers\]\.sort/,
      "topCustomers and customerTop10Share both read sortedCustomers, so it must be built from the aggregated set",
    );
    assert.ok(
      !/\[\.\.\.customerRows\]\.sort/.test(dashboard),
      "ranking customerRows directly is the defect: one customer then occupies one row per selected month",
    );
    assert.match(
      dashboard,
      /customerCount: aggregatedCustomers\.length/,
      "the customer count and the ranking must agree on what one customer is",
    );
    // The "newest month wins" display rule above is not self-enforcing: it holds only because
    // fetchGeo maps over selectedPeriods and selectedPeriods is sorted DESCENDING. Flip that sort
    // and every customer keeps their OLDEST name/region/area — the values stay right, so nothing
    // else in the suite would notice. Pin the invariant the aggregation silently depends on.
    assert.match(
      dashboard,
      /const selectedPeriods = [\s\S]{0,200}?\.sort\(\(left, right\) => right\.localeCompare\(left\)\)/,
      "selectedPeriods must stay newest-first, or the aggregated customer rows display the oldest month's name, region and area",
    );
  }

  // ── The capped Customer Directory list must not be reported as a count ──────
  {
    const workspace = stripComments(read("src/components/sales/customer-directory-workspace.tsx"));

    assert.ok(
      !/<AdminInsightChip>Customers: \{formatNumber\(customers\.length\)\}<\/AdminInsightChip>/.test(workspace),
      "the fetched page is capped at 2,000 rows, so its length is a display limit and never the number of customers",
    );
    assert.match(
      workspace,
      /result\?\.truncated\s*\n?\s*\?\s*`Customers: \$\{formatNumber\(customers\.length\)\}\+ \(list capped\)`/,
      "when the server truncated the list the chip must say so rather than present the cap as a figure",
    );
  }
}
