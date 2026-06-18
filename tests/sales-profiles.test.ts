import assert from "node:assert/strict";

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
function weeklyDistributorsHaveProfiles() {
  const profileCodes = new Set(RAW_DISTRIBUTOR_PROFILES.map((p) => p.distributorCode.toUpperCase()));
  for (const w of WEEKLY_DISTRIBUTORS) {
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

export function runSalesProfilesTests() {
  profileInvariants();
  weeklyDistributorsHaveProfiles();
  chimipharmPivotHasNoDateColumn();
}
