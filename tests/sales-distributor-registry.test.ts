import assert from "node:assert/strict";

import {
  buildSalesDistributorEntries,
  isWeeklyDistributor,
  summarizeProfile,
} from "../src/lib/sales/distributor-registry.ts";
import type { DistributorProfile } from "../src/lib/sales/normalizer/types.ts";

function mergeUnifiesAllSources() {
  const master = [
    { code: "PS", name: "Overseas" },
    { code: "CP", name: "Chimipharm" },
  ];
  const profiled = new Set(["PS", "CP", "XX"]);
  const entries = buildSalesDistributorEntries(master, profiled);
  const byCode = new Map(entries.map((e) => [e.code, e]));

  // PS: monthly profile + weekly (Overseas ships separate sales/stock files).
  const ps = byCode.get("PS")!;
  assert.equal(ps.monthlySupported, true);
  assert.equal(ps.weeklySupported, true);
  assert.equal(ps.weeklyCadence, "weekly");
  assert.equal(ps.separateSalesStockFiles, true);

  // CP: monthly only (Chimipharm is not a weekly distributor).
  const cp = byCode.get("CP")!;
  assert.equal(cp.monthlySupported, true);
  assert.equal(cp.weeklySupported, false);
  assert.equal(cp.weeklyCadence, null);

  // XX: profiled but not in master → still listed, monthly-supported.
  const xx = byCode.get("XX")!;
  assert.equal(xx.monthlySupported, true);
  assert.equal(xx.weeklySupported, false);

  // EG is weekly-only here (not in master/profiled) but must still surface from the weekly registry.
  const eg = byCode.get("EG")!;
  assert.ok(eg, "weekly-only distributors must still appear");
  assert.equal(eg.weeklySupported, true);
  assert.equal(eg.monthlySupported, false);

  // Sorted by name.
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
}

function summarizeProfileFlagsMissingDate() {
  const cpLike = {
    distributorCode: "CP",
    distributorName: "chimipharm",
    productColumns: ["Attribute"],
    qtyColumns: ["Value"],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: [],
    customerCodeColumns: ["Customer"],
    customerNameColumns: ["Customer Name"],
    territoryColumns: ["Area name A"],
    discountColumns: ["Discount%"],
  } as unknown as DistributorProfile;
  const cp = summarizeProfile(cpLike);
  assert.equal(cp.hasDateColumn, false, "CP pivot has no date column → period picker required");
  assert.equal(cp.valueSource, "recompute");
  assert.deepEqual(cp.territoryColumns, ["Area name A"]);

  const psLike = {
    distributorCode: "PS",
    distributorName: "Overseas",
    productColumns: ["Item Code", "Item Name"],
    qtyColumns: ["Qty"],
    valueColumns: ["Net"],
    valueSource: "recompute",
    dateColumns: ["Date"],
    customerCodeColumns: ["Client Code"],
    customerNameColumns: ["Client Name"],
    territoryColumns: [],
    discountColumns: [],
  } as unknown as DistributorProfile;
  assert.equal(summarizeProfile(psLike).hasDateColumn, true);
}

function weeklyApplicabilityIsCaseInsensitive() {
  assert.equal(isWeeklyDistributor("PS"), true);
  assert.equal(isWeeklyDistributor("ps"), true);
  assert.equal(isWeeklyDistributor("CP"), false);
  assert.equal(isWeeklyDistributor(""), false);
}

export function runSalesDistributorRegistryTests() {
  mergeUnifiesAllSources();
  summarizeProfileFlagsMissingDate();
  weeklyApplicabilityIsCaseInsensitive();
}
