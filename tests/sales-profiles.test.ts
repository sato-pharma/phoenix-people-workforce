import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dedicatedCodedTemplateKeys } from "../src/lib/sales/monthly-distributor-import.ts";
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

// Ibn Sina is THREE feeds, not one — IS (outsourced), IS-S (Sato Pharma / PAS) and IS-L (LACTO MISR
// EG) — by the owner's ruling of 2026-10-13, and his follow-up the same day was that it be wired
// "every where in mapping and upload and normalizer and every where". So each of the three must reach
// the MONTHLY lane the same way: a raw profile with Ibn Sina's own column set, a dedicated coded
// template, and — for IS-L alone, the one code the owner's distributor-master file does not carry — a
// SYSTEM_DISTRIBUTORS line, without which the next add-only master import plus a data reset would drop
// it out of the Upload Sales dropdown (exactly how "Direct" vanished after the 2026-06-08 reset).
function everyIbnSinaFeedIsWiredMonthly() {
  const feeds = ["IS", "IS-S", "IS-L"];
  const profileByCode = new Map(
    RAW_DISTRIBUTOR_PROFILES.map((p) => [p.distributorCode.trim().toUpperCase(), p]),
  );
  const expectedTemplateKey: Record<string, string> = {
    IS: "ibn_sina_is",
    "IS-S": "ibn_sina_sato_iss",
    "IS-L": "ibn_sina_lacto_isl",
  };

  for (const code of feeds) {
    const profile = profileByCode.get(code);
    assert.ok(profile, `Ibn Sina feed ${code} has no raw monthly profile`);
    // Ibn Sina's export shape is the same workbook for every supplier, so all three read the same
    // columns. A feed that drifts off them would silently stop recognizing Ibn Sina's own sheet.
    assert.deepEqual(profile!.productCodeColumns, ["Item Code"], `${code}: product code column`);
    assert.deepEqual(profile!.qtyColumns, ["Quantity"], `${code}: paid-units column`);
    assert.deepEqual(profile!.customerCodeColumns, ["Client Code"], `${code}: customer code column`);
    assert.deepEqual(profile!.territoryColumns, ["Brick Name"], `${code}: territory column`);
    assert.equal(profile!.valueSource, "recompute", `${code}: value is recomputed at factory price`);

    // Asked of the registry itself, not of the file's text: a template that is DEFINED but never
    // registered in DISTRIBUTOR_SALES_TEMPLATES would satisfy a source-text assertion while every
    // coded sheet for that feed silently fell through to the generic "Normalized coded sheet".
    assert.deepEqual(
      dedicatedCodedTemplateKeys(code),
      [expectedTemplateKey[code]],
      `Ibn Sina feed ${code} has no dedicated coded template registered in DISTRIBUTOR_SALES_TEMPLATES`,
    );
  }

  // IS and IS-S come from the owner's uploaded distributor master; IS-L is code-defined, so only it
  // belongs in SYSTEM_DISTRIBUTORS.
  const systemChannels = readFileSync("src/lib/sales/master-data/import-service.ts", "utf8");
  assert.ok(
    systemChannels.includes('distributor_code: "IS-L"'),
    "IS-L must stay in SYSTEM_DISTRIBUTORS — a master import plus a reset would otherwise drop it",
  );
  assert.ok(
    systemChannels.includes('normalized_distributor_name: "ibn sina-lacto"'),
    "IS-L's SYSTEM_DISTRIBUTORS row must carry the normalized name the DB row holds",
  );
  // El Ezaby (EZB, owner 2026-11-10) is not in the owner's distributor master either.
  assert.ok(
    systemChannels.includes('{ distributor_code: "EZB", distributor_name: "El Ezaby", normalized_distributor_name: "el ezaby" }'),
    "El Ezaby must stay in SYSTEM_DISTRIBUTORS — a master import plus a reset would otherwise drop it",
  );

  // And the weekly registry must NOT call IS-L weeklyOnly any more: that flag means "no monthly import
  // at all", and it is what exempts a code from weeklyDistributorsHaveProfiles() above.
  const isl = WEEKLY_DISTRIBUTORS.find((w) => w.code.toUpperCase() === "IS-L");
  assert.ok(isl, "IS-L must be in the weekly distributor registry");
  assert.ok(!isl!.weeklyOnly, "IS-L is no longer weeklyOnly — it has a monthly profile and template");
}

export function runSalesProfilesTests() {
  profileInvariants();
  weeklyDistributorsHaveProfiles();
  chimipharmPivotHasNoDateColumn();
  egdBranchHasNoRequiredDateColumn();
  retiredDistributorCodesStayOutOfCodePaths();
  everyIbnSinaFeedIsWiredMonthly();
}
