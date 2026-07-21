import assert from "node:assert/strict";

import { applyPharmacyLineScope } from "../src/lib/sales/territory/pharmacies.ts";

function row(overrides: Partial<Parameters<typeof applyPharmacyLineScope>[0][number]> = {}) {
  return {
    brick_id: "B64-14",
    client_code: "C1",
    client_name: "El Ezaby Pharmacy",
    official_line: "Anti Infective",
    product_code: "SAG001",
    product_name: "Saginko",
    period: "2026-06",
    units: 10,
    value: 1000,
    scope_total_units: 10,
    scope_total_value: 1000,
    ...overrides,
  };
}

// Defense-in-depth: even though phx_territory_area_pharmacies already filters by
// official_line in SQL, this TS-side re-check must independently drop any row whose line
// doesn't match the viewer's own — a pharmacy that also sells another line's products must
// never leak into this viewer's tree, and a future RPC edit can't silently bypass this.
export function runTerritoryLineFilterTests() {
  const rows = [
    row({ client_code: "C1", official_line: "Anti Infective" }),
    row({ client_code: "C2", official_line: "Pedia" }),
    row({ client_code: "C3", official_line: "anti infective" }), // case/whitespace variant
    row({ client_code: "C4", official_line: "CNS" }),
  ];

  const filtered = applyPharmacyLineScope(rows, "Anti Infective");
  assert.deepEqual(
    filtered.map((r) => r.client_code),
    ["C1", "C3"],
    "keeps only rows whose line matches the viewer's own (case/whitespace-insensitive)",
  );

  assert.deepEqual(applyPharmacyLineScope([], "Anti Infective"), [], "empty input stays empty");
  assert.deepEqual(
    applyPharmacyLineScope([row({ official_line: "Pedia" })], "Anti Infective"),
    [],
    "a single non-matching row is dropped, never widened to pass through",
  );
}
