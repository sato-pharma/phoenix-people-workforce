import { strict as assert } from "node:assert";

import {
  findDuplicateItemCodes,
  findZeroSalesGaps,
  isItemCode,
  type AliasRow,
  type SalesRow,
} from "../scripts/check-sos-product-mapping.ts";

// The fixtures below are the real 2026-06-25 -> 2026-08-09 incident, trimmed. Pharma Overseas
// (PS) had item 7520 (Rispadex syrup) and item 8687 (Conviban 100) both pointing at CO004, so
// 1,298 packs of Rispadex syrup were reported as Conviban 100 for seven months while RI003 sat
// at exactly zero. Both checks must fire on this shape.

function overseasAliases(): AliasRow[] {
  return [
    { alias: "7520", distributor_code: "PS", product_code: "CO004" },  // really Rispadex syrup
    { alias: "8687", distributor_code: "PS", product_code: "CO004" },  // really Conviban 100
    { alias: "17212", distributor_code: "PS", product_code: "TE003" }, // really the 40 mg tablet
    { alias: "17214", distributor_code: "PS", product_code: "TE003" }, // really the drops
    { alias: "9310", distributor_code: "PS", product_code: "CO003" },
    { alias: "Conviban 100 mg", distributor_code: "PS", product_code: "CO004" },
  ];
}

export function runSosProductMappingCheckTests() {
  // ---- isItemCode: only digits are the distributor's code; a name never is ----
  assert.equal(isItemCode("7520"), true);
  assert.equal(isItemCode(" 17214 "), true, "surrounding whitespace must not hide an item code");
  assert.equal(isItemCode("Conviban 100 mg"), false);
  assert.equal(isItemCode("رسبادكس  شراب 100 مللى"), false, "an Arabic product name is not an item code");

  // ---- CHECK 1 ----
  const dupes = findDuplicateItemCodes(overseasAliases());
  assert.equal(dupes.length, 2, "both doubled products must be reported, not just the first");

  const conviban = dupes.find((d) => d.productCode === "CO004");
  assert.ok(conviban, "the Conviban 100 pair that hid Rispadex syrup must be found");
  assert.deepEqual(conviban.itemCodes, ["7520", "8687"], "both item codes must be named so they can be checked against the distributor's list");
  assert.equal(conviban.distributorCode, "PS");

  const tebo = dupes.find((d) => d.productCode === "TE003");
  assert.ok(tebo, "the Tebofortine 40 pair that hid the drops must be found");
  assert.deepEqual(tebo.itemCodes, ["17212", "17214"]);

  // A single code per product is the normal case and must stay silent.
  assert.equal(
    findDuplicateItemCodes([{ alias: "9310", distributor_code: "PS", product_code: "CO003" }]).length,
    0,
    "one item code on one product is correct and must not be reported",
  );

  // IGNORE is a bucket — dozens of unrelated codes land in it by design.
  assert.equal(
    findDuplicateItemCodes([
      { alias: "13512", distributor_code: "PS", product_code: "IGNORE" },
      { alias: "19295", distributor_code: "PS", product_code: "IGNORE" },
    ]).length,
    0,
    "the IGNORE bucket legitimately holds many codes and must never be flagged",
  );

  // The same code at two different distributors is not a duplicate — aliases are per-distributor.
  assert.equal(
    findDuplicateItemCodes([
      { alias: "10409", distributor_code: "EG", product_code: "RI002" },
      { alias: "10409", distributor_code: "EG-HOS", product_code: "RI002" },
    ]).length,
    0,
    "one code shared by two distributors is not the failure this check looks for",
  );

  // Name aliases must not be mistaken for codes, or every distributor would look duplicated.
  assert.equal(
    findDuplicateItemCodes([
      { alias: "Conviban 100 mg", distributor_code: "PS", product_code: "CO004" },
      { alias: "كونفيبان 100 مجم 20 قرص", distributor_code: "PS", product_code: "CO004" },
    ]).length,
    0,
    "two NAMES for one product is exactly what the mapping is for — only item codes count here",
  );

  // ---- CHECK 2 ----
  // A CNS line where PS carries 22% of the volume but shows zero Rispadex syrup.
  const cns: SalesRow[] = [
    { distributor_code: "PS", official_line: "CNS", product_code: "CO004", qty: 14766 },
    { distributor_code: "PS", official_line: "CNS", product_code: "TE003", qty: 34594 },
    { distributor_code: "IS", official_line: "CNS", product_code: "RI003", qty: 16482 },
    { distributor_code: "IS", official_line: "CNS", product_code: "TE003", qty: 30000 },
    { distributor_code: "MC", official_line: "CNS", product_code: "TE003", qty: 137 },
  ];
  const gaps = findZeroSalesGaps(cns);
  const overseasSyrup = gaps.find((g) => g.distributorCode === "PS" && g.productCode === "RI003");
  assert.ok(overseasSyrup, "a distributor carrying a fifth of the line with ZERO of a product must be reported");
  assert.equal(overseasSyrup.line, "CNS");
  assert.equal(overseasSyrup.productUnitsElsewhere, 16482, "the report must quantify what the product sells elsewhere");
  assert.ok(overseasSyrup.distributorPctOfLine > 20, "the distributor's share of the line is what makes a zero implausible");

  // MEC holds 137 of ~96k units — far too small to be expected to stock the range.
  assert.equal(
    gaps.some((g) => g.distributorCode === "MC"),
    false,
    "a distributor with a fraction of a percent of the line must not be flagged for gaps",
  );

  // A niche SKU must not flag against every distributor that does not carry it.
  const withNiche: SalesRow[] = [
    ...cns,
    { distributor_code: "IS", official_line: "CNS", product_code: "RI001", qty: 40 },
  ];
  assert.equal(
    findZeroSalesGaps(withNiche).some((g) => g.productCode === "RI001"),
    false,
    "a tender-only SKU is below the product-share floor and must stay quiet",
  );

  // Rows that net to zero are as suspicious as no rows at all — a returns-only month reads the same.
  const netsToZero: SalesRow[] = [
    ...cns,
    { distributor_code: "PS", official_line: "CNS", product_code: "RI003", qty: 5 },
    { distributor_code: "PS", official_line: "CNS", product_code: "RI003", qty: -5 },
  ];
  assert.ok(
    findZeroSalesGaps(netsToZero).some((g) => g.distributorCode === "PS" && g.productCode === "RI003"),
    "units that cancel to zero must still be reported — the product still shows nothing sold",
  );

  // Lines are independent: a Pedia gap must not be judged against CNS volumes.
  const twoLines: SalesRow[] = [
    ...cns,
    { distributor_code: "IS-S", official_line: "Pedia", product_code: "GU001", qty: 10421 },
    { distributor_code: "EP-PHS", official_line: "Pedia", product_code: "LA001", qty: 38783 },
    { distributor_code: "EP-PHS", official_line: "Pedia", product_code: "GU001", qty: 5000 },
  ];
  const pedia = findZeroSalesGaps(twoLines).filter((g) => g.line === "Pedia");
  assert.ok(
    pedia.some((g) => g.distributorCode === "IS-S" && g.productCode === "LA001"),
    "the Pedia gap must be found using Pedia volumes, not diluted by the much larger CNS line",
  );
  assert.equal(
    pedia.some((g) => g.line !== "Pedia"),
    false,
    "findings must be scoped to their own line",
  );
}
