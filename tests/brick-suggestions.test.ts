import assert from "node:assert/strict";

import { buildBrickSuggestions, type MappedCustomer, type UnmappedCustomer } from "../src/lib/sales/brick-suggestions.ts";

const mapped = (rows: [name: string, addr: string, brick: string, dist: string, code: string][]): MappedCustomer[] =>
  rows.map(([customerName, address, brickId, distributorCode, customerCode]) => ({ address, brickId, customerCode, customerName, distributorCode }));

const unmapped = (rows: [name: string, addr: string, code: string][]): UnmappedCustomer[] =>
  rows.map(([customerName, address, customerCode]) => ({ address, customerCode, customerName }));

export function runBrickSuggestionsTests() {
  // 1) Cross-distributor carry-over: same name+address mapped under PS → high-confidence for IS upload.
  {
    const out = buildBrickSuggestions(
      unmapped([["El Ezaby Pharmacy", "12 Tahrir St", "IS-900"]]),
      mapped([["EL EZABY PHARMACY", "12 TAHRIR ST", "B1", "PS", "PS-100"]]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].suggestedBrickId, "B1");
    assert.equal(out[0].confidence, "high");
    assert.equal(out[0].matchType, "name+address");
    assert.equal(out[0].sourceDistributorCode, "PS");
  }

  // 2) Name matches two DIFFERENT bricks (a chain across bricks) → ambiguous, no suggestion.
  {
    const out = buildBrickSuggestions(
      unmapped([["Seif Pharmacy", "", "X1"]]), // no address → name-only lookup
      mapped([
        ["SEIF PHARMACY", "Branch A", "B1", "PS", "P1"],
        ["SEIF PHARMACY", "Branch B", "B2", "IS", "I1"],
      ]),
    );
    assert.equal(out.length, 0, "ambiguous name → skipped");
  }

  // 3) Name-only single-brick match (no address on the unmapped row) → low confidence.
  {
    const out = buildBrickSuggestions(
      unmapped([["Nile Pharmacy", "", "X2"]]),
      mapped([["NILE PHARMACY", "5 Nile Rd", "B7", "PS", "P9"]]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].confidence, "low");
    assert.equal(out[0].matchType, "name");
    assert.equal(out[0].suggestedBrickId, "B7");
  }

  // 4) name+address that matches one brick wins even if name-only would be ambiguous.
  {
    const out = buildBrickSuggestions(
      unmapped([["Seif Pharmacy", "Branch A", "X3"]]),
      mapped([
        ["SEIF PHARMACY", "BRANCH A", "B1", "PS", "P1"],
        ["SEIF PHARMACY", "BRANCH B", "B2", "IS", "I1"],
      ]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].suggestedBrickId, "B1", "precise address disambiguates");
    assert.equal(out[0].confidence, "high");
  }

  // 5) No match at all → no suggestion. Unmapped with blank name → skipped.
  {
    const out = buildBrickSuggestions(
      unmapped([["Unknown Co", "Nowhere", "X4"], ["", "addr", "X5"]]),
      mapped([["EL EZABY PHARMACY", "12 TAHRIR ST", "B1", "PS", "P1"]]),
    );
    assert.equal(out.length, 0);
  }

  // 6) Duplicate unmapped rows for the same customer code → one suggestion; high sorts before low.
  {
    const out = buildBrickSuggestions(
      unmapped([
        ["Nile Pharmacy", "", "LOW1"],      // name-only → low
        ["El Ezaby", "12 Tahrir St", "HIGH1"],
        ["El Ezaby", "12 Tahrir St", "HIGH1"], // duplicate code
      ]),
      mapped([
        ["NILE PHARMACY", "5 Nile Rd", "B7", "PS", "P9"],
        ["EL EZABY", "12 TAHRIR ST", "B1", "PS", "P1"],
      ]),
    );
    assert.equal(out.length, 2, "duplicate code de-duped");
    assert.equal(out[0].confidence, "high", "high-confidence sorted first");
    assert.equal(out[0].customerCode, "HIGH1");
    assert.equal(out[1].confidence, "low");
  }
}
