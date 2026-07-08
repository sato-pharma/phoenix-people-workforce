import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RAW_DISTRIBUTOR_PROFILES } from "../src/lib/sales/normalizer/profiles.ts";
import { WEEKLY_DISTRIBUTORS } from "../src/lib/sales/weekly/distributors.ts";

// Every raw distributor profile must be recognizable + codeable: it needs an item column, a
// quantity column, and at least one way to resolve a location (customer code, territory text, or a
// direct brick id). These invariants guard against a profile that would silently fail recognition.
function profileInvariants() {
  const seen = new Set<string>();
  for (const p of RAW_DISTRIBUTOR_PROFILES) {
    const code = p.distributorCode.trim().toUpperCase();
    assert.ok(code, "distributorCode must be non-empty");
    assert.ok(p.distributorName.trim(), `${code}: distributorName must be non-empty`);
    assert.ok(!seen.has(code), `duplicate distributor code: ${code}`);
    seen.add(code);

    assert.ok((p.productColumns ?? []).length > 0, `${code}: needs at least one product column`);
    assert.ok((p.qtyColumns ?? []).length > 0, `${code}: needs at least one quantity column`);

    const hasLocation =
      (p.customerCodeColumns ?? []).length > 0 ||
      (p.territoryColumns ?? []).length > 0 ||
      (p.brickIdColumns ?? []).length > 0;
    assert.ok(hasLocation, `${code}: needs a customer code, territory, or brick id source`);

    assert.ok(p.valueSource === "recompute" || p.valueSource === "sheet", `${code}: invalid valueSource`);
  }
}

// Every weekly-applicable distributor must also have a monthly raw profile (the same distributor is
// uploaded monthly and weekly through the one connected module).
// Exceptions:
//   weeklyOnly   — layout (e.g. transposed matrix) with no monthly flat-file equivalent at all.
//   monthlyCoded — monthly counterpart goes through the coded system channel path
//                  (DIRECT_TEMPLATE / isCodedSystemChannel), not through RAW_DISTRIBUTOR_PROFILES.
function weeklyDistributorsHaveProfiles() {
  const profileCodes = new Set(RAW_DISTRIBUTOR_PROFILES.map((p) => p.distributorCode.toUpperCase()));
  for (const w of WEEKLY_DISTRIBUTORS) {
    if (w.weeklyOnly || w.monthlyCoded) continue;
    assert.ok(profileCodes.has(w.code.toUpperCase()), `weekly distributor ${w.code} has no monthly profile`);
  }
}

// CP (Chimipharm) is a pivot export with NO per-row date column — its period comes from the picker.
// Regression guard for the bug where a phantom dateColumns rejected every CP upload.
function chimipharmPivotHasNoDateColumn() {
  const cp = RAW_DISTRIBUTOR_PROFILES.find((p) => p.distributorCode.toUpperCase() === "CP");
  assert.ok(cp, "CP profile must exist");
  assert.equal((cp!.dateColumns ?? []).length, 0, "CP pivot must declare no date column");
  assert.ok((cp!.territoryColumns ?? []).includes("Area name A"), "CP resolves location via 'Area name A'");
  assert.equal(cp!.valueSource, "recompute", "CP value is recomputed from master price");
}

// EGD Branch (EG-BR): the distributor's export sometimes carries "CARD_DATE", sometimes none at all
// (from 2026-06) — like CP, its period comes from the upload picker either way. Regression guard for
// the bug where a required CARD_DATE column rejected the dateless month's file outright.
function egdBranchHasNoRequiredDateColumn() {
  const egbr = RAW_DISTRIBUTOR_PROFILES.find((p) => p.distributorCode.toUpperCase() === "EG-BR");
  assert.ok(egbr, "EG-BR profile must exist");
  assert.equal((egbr!.dateColumns ?? []).length, 0, "EG-BR must not require a date column");
  assert.ok((egbr!.customerCodeColumns ?? []).includes("TO_COMPANY_ENTITY_CODE"), "EG-BR resolves location via customer code");
}

function retiredDistributorCodesStayOutOfCodePaths() {
  const retiredCodes = ["EP" + "-S", "EP" + "-R"];
  const profileCodes = new Set(RAW_DISTRIBUTOR_PROFILES.map((p) => p.distributorCode.trim().toUpperCase()));
  for (const code of retiredCodes) {
    assert.ok(!profileCodes.has(code), `retired distributor ${code} must not have a raw profile`);
  }

  const guardedFiles = [
    "src/lib/sales/monthly-distributor-import.ts",
    "src/lib/sales/master-data/import-service.ts",
    "scripts/seed-vlookup-master.mjs",
  ];
  for (const file of guardedFiles) {
    const contents = readFileSync(file, "utf8");
    for (const code of retiredCodes) {
      assert.ok(!contents.includes(code), `${file} must not reintroduce retired distributor ${code}`);
    }
  }
}

export function runSalesProfilesTests() {
  profileInvariants();
  weeklyDistributorsHaveProfiles();
  chimipharmPivotHasNoDateColumn();
  egdBranchHasNoRequiredDateColumn();
  retiredDistributorCodesStayOutOfCodePaths();
}
