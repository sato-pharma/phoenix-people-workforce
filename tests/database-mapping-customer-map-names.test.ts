import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MASTER_DEFINITIONS } from "../src/lib/sales/master-data/definitions.ts";
import {
  buildCustomerMapNameIndex,
  customerMapNames,
  CUSTOMER_MAP_NAME_COLUMNS,
} from "../src/lib/sales/master-data/customer-map-names.ts";

/**
 * Sales → Database Mapping → Distributor Mapping → Customer map shows NAMES, never codes (owner
 * rule: human-readable names in the UI). Measured on production on 2026-09-18, a Sofico row read
 * "B193-1 · Area D14 · Region D1 · Distributor SF": the brick, area, region and distributor were all
 * raw codes. The crosswalk row carries only codes, and the workbook export must keep them because
 * the import matches on them, so the SCREEN resolves each code against the master rows the page
 * already holds. A code the master does not know still shows, flagged, so a broken mapping stays
 * visible instead of going blank.
 */

const VALIDATION = "src/components/sales/database-validation-tab.tsx";
const WORKSPACE = "src/components/sales/database-mapping-workspace.tsx";

export function runDatabaseMappingCustomerMapNamesTests() {
  // Every name column the resolver reads is a real column of that master.
  for (const [master, [codeColumn, nameColumn]] of Object.entries(CUSTOMER_MAP_NAME_COLUMNS)) {
    const def = MASTER_DEFINITIONS[master as keyof typeof MASTER_DEFINITIONS];
    assert.equal(def.keyColumn, codeColumn, `${def.label}: the resolver keys on "${codeColumn}", but the master's key is "${def.keyColumn}".`);
    assert.ok(def.columns.some((c) => c.key === nameColumn), `${def.label}: the resolver reads "${nameColumn}", which is not a column of this master.`);
  }

  const index = buildCustomerMapNameIndex({
    areas: [{ area_code: "D14", area_name: "Tanta", active: true }],
    bricks: [
      { brick_id: "B193-1", brick_name: "Tanta El Bahr St", active: true },
      // A retired brick still names its customers: the page loads inactive rows too.
      { brick_id: "B200-2", brick_name: "Old Mahalla", active: false },
    ],
    distributors: [{ distributor_code: "SF", distributor_name: "sofico", active: true }],
    regions: [{ region_code: "D1", region_name: "Delta (1)", active: true }],
  });

  // The production row that read as four codes now reads as four names.
  const sofico = customerMapNames(index, { areaCode: "D14", brickId: "B193-1", distributorCode: "SF", regionCode: "D1" });
  assert.deepEqual(
    [sofico.brick, sofico.area, sofico.region, sofico.distributor],
    [
      { name: "Tanta El Bahr St", resolved: true },
      { name: "Tanta", resolved: true },
      { name: "Delta (1)", resolved: true },
      { name: "sofico", resolved: true },
    ],
    "B193-1 · D14 · D1 · SF must read as the brick, area, region and distributor names",
  );

  // The same normalisation the importer uses: case, padding and Arabic-Indic digits all match.
  assert.equal(customerMapNames(index, { areaCode: " d14 ", brickId: "b١٩٣-١", distributorCode: "sf", regionCode: "d1" }).brick.name, "Tanta El Bahr St");
  assert.equal(customerMapNames(index, { areaCode: "", brickId: "B200-2", distributorCode: "", regionCode: "" }).brick.name, "Old Mahalla", "an inactive brick still resolves");

  // A code the master does not know shows AS the code, flagged. Never blank, never a guess.
  const orphan = customerMapNames(index, { areaCode: "ZZ9", brickId: "B999-9", distributorCode: "SF", regionCode: "D1" });
  assert.deepEqual(orphan.brick, { name: "B999-9", resolved: false }, "an unknown brick shows its code, flagged as not in the master");
  assert.deepEqual(orphan.area, { name: "ZZ9", resolved: false });
  // No code at all is a plain dash, and is not flagged: there is nothing to resolve.
  assert.deepEqual(customerMapNames(index, { areaCode: "", brickId: "", distributorCode: "", regionCode: "" }).area, { name: "—", resolved: true });

  // The screen renders the resolved names, never the raw codes.
  const validation = readFileSync(VALIDATION, "utf8");
  for (const raw of ["{customer.brickId", "{customer.areaCode", "{customer.regionCode", "{customer.distributorCode"]) {
    assert.ok(!validation.includes(raw), `${VALIDATION}: the customer map renders a raw code again (${raw}). Show the name from customerMapNames.`);
  }
  assert.equal((validation.match(/const names = customerMapNames\(nameIndex, c\);/g) ?? []).length, 2, `${VALIDATION}: both the desktop rows and the mobile cards resolve names.`);
  assert.match(validation, /not in the master/, `${VALIDATION}: an unresolved code must stay visible and flagged.`);

  const workspace = readFileSync(WORKSPACE, "utf8");
  assert.match(workspace, /buildCustomerMapNameIndex\(rowsByMaster\)/, `${WORKSPACE}: the name index must come from the master rows the page holds.`);
  assert.match(workspace, /<DatabaseValidationTab headerGrid=\{initialHeaderGrid\} nameIndex=\{customerMapNameIndex\} \/>/, `${WORKSPACE}: the Distributor Mapping tab must receive the name index.`);
}
