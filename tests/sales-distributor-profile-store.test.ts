import assert from "node:assert/strict";

import { validateDistributorProfileInput, type DistributorProfileInput } from "../src/lib/sales/distributor-profile-admin.ts";
import { dbRowToEditable, dbRowToProfile, mergeProfilesByCode, type DbProfileRow } from "../src/lib/sales/normalizer/distributor-profile-store.ts";
import type { DistributorProfile } from "../src/lib/sales/normalizer/types.ts";

// Phase 6 — monthly editable distributor profiles: the pure merge + mapping + validation building
// blocks (the DB read/cache is integration-only and not exercised here).

function codeProfile(code: string, name: string): DistributorProfile {
  return { distributorCode: code, distributorName: name, productColumns: ["P"], qtyColumns: ["Q"], valueSource: "recompute" };
}

function dbRow(over: Partial<DbProfileRow> = {}): DbProfileRow {
  return {
    distributor_code: "EG-BR",
    distributor_name: "EGD Branch (edited)",
    product_code_columns: ["ITEM_CODE"],
    product_name_columns: ["ITEM_NAME_ENG"],
    qty_columns: ["QTY"],
    customer_code_columns: ["TO_COMPANY_ENTITY_CODE"],
    date_columns: ["CARD_DATE"],
    area_id_columns: [],
    brick_id_columns: [],
    value_source: "recompute",
    region_only: false,
    ...over,
  };
}

function mergePrecedence_dbWinsAndNewAppears() {
  const code = [codeProfile("PS", "Pharma Soft"), codeProfile("EG-BR", "EGD Branch")];
  const db = [dbRowToProfile(dbRow())!, dbRowToProfile(dbRow({ distributor_code: "NEW-D", distributor_name: "Brand New" }))!];
  const merged = mergeProfilesByCode(code, db);
  // DB row wholly overrides the code EG-BR (name comes from the DB row)
  const egbr = merged.find((p) => p.distributorCode === "EG-BR");
  assert.equal(egbr?.distributorName, "EGD Branch (edited)");
  assert.deepEqual(egbr?.productCodeColumns, ["ITEM_CODE"]);
  // untouched code distributor remains
  assert.ok(merged.some((p) => p.distributorCode === "PS" && p.distributorName === "Pharma Soft"));
  // DB-only distributor is added
  assert.ok(merged.some((p) => p.distributorCode === "NEW-D"));
  assert.equal(merged.length, 3);
}

function dbRowToProfile_rebuildsEngineFields() {
  const p = dbRowToProfile(dbRow({ value_source: "sheet", value_columns: ["VAL"], area_id_columns: ["GOV"] }))!;
  assert.deepEqual(p.productColumns, ["ITEM_CODE", "ITEM_NAME_ENG"]); // code-then-name
  assert.deepEqual(p.productCodeColumns, ["ITEM_CODE"]);
  assert.deepEqual(p.productNameColumns, ["ITEM_NAME_ENG"]);
  assert.deepEqual(p.territoryColumns, ["GOV"]); // area_id → territory
  assert.equal(p.valueSource, "sheet");
}

function dbRowToEditable_mapsAllFieldsAndIsCustom() {
  const e = dbRowToEditable(dbRow());
  assert.equal(e.isCustom, true);
  assert.equal(e.distributorName, "EGD Branch (edited)");
  assert.deepEqual(e.fields.productCodeColumns, ["ITEM_CODE"]);
  assert.deepEqual(e.fields.customerCodeColumns, ["TO_COMPANY_ENTITY_CODE"]);
  assert.deepEqual(e.fields.dateColumns, ["CARD_DATE"]);
}

function validation_requiresMinimumColumns() {
  const base: DistributorProfileInput = {
    distributorCode: "X", distributorName: "X Dist", valueSource: "recompute", regionOnly: false,
    fields: { productCodeColumns: ["C"], productNameColumns: [], qtyColumns: ["Q"], branchCodeColumns: [], branchNameColumns: [], bonusColumns: [], valueColumns: [], discountColumns: [], dateColumns: [], customerCodeColumns: ["CC"], customerNameColumns: [], customerAddressColumns: [], areaIdColumns: [], areaNameColumns: [], brickIdColumns: [], brickNameColumns: [], regionColumns: [] },
  };
  assert.equal(validateDistributorProfileInput(base).ok, true);
  // missing product
  assert.equal(validateDistributorProfileInput({ ...base, fields: { ...base.fields, productCodeColumns: [], productNameColumns: [] } }).ok, false);
  // missing qty
  assert.equal(validateDistributorProfileInput({ ...base, fields: { ...base.fields, qtyColumns: [] } }).ok, false);
  // missing location (no customer/area/brick)
  assert.equal(validateDistributorProfileInput({ ...base, fields: { ...base.fields, customerCodeColumns: [] } }).ok, false);
  // sheet value source needs a value column
  assert.equal(validateDistributorProfileInput({ ...base, valueSource: "sheet" }).ok, false);
  assert.equal(validateDistributorProfileInput({ ...base, valueSource: "sheet", fields: { ...base.fields, valueColumns: ["V"] } }).ok, true);
  // blank code rejected
  assert.equal(validateDistributorProfileInput({ ...base, distributorCode: "  " }).ok, false);
}

export function runDistributorProfileStoreTests() {
  mergePrecedence_dbWinsAndNewAppears();
  dbRowToProfile_rebuildsEngineFields();
  dbRowToEditable_mapsAllFieldsAndIsCustom();
  validation_requiresMinimumColumns();
}
