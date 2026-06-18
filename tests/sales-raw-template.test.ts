import assert from "node:assert/strict";

import { rawTemplateHeaders } from "../src/lib/sales/raw-template.ts";
import type { DistributorProfile } from "../src/lib/sales/normalizer/types.ts";

// CP pivot: all product columns, first alias of each other group, NO date column.
function cpHeadersMimicRawLayout() {
  const cp = {
    distributorCode: "CP",
    distributorName: "chimipharm",
    productColumns: ["Attribute", "Column1"],
    qtyColumns: ["Value", "Column2", "Qty"],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: [],
    customerCodeColumns: ["Customer", "كود"],
    customerNameColumns: ["Customer Name"],
    territoryColumns: ["Area name A"],
    discountColumns: ["Discount%"],
  } as unknown as DistributorProfile;
  assert.deepEqual(rawTemplateHeaders(cp), [
    "Attribute",
    "Column1",
    "Value",
    "Customer",
    "Customer Name",
    "Area name A",
    "Discount%",
  ]);
}

// A distributor with a date column includes it; fallback alias groups contribute only the first.
function psHeadersIncludeDate() {
  const ps = {
    distributorCode: "PS",
    distributorName: "Overseas",
    productColumns: ["Item Code", "Item Name"],
    qtyColumns: ["Qty"],
    valueColumns: ["Net"],
    valueSource: "recompute",
    dateColumns: ["Date", "Invoice Date"],
    customerCodeColumns: ["Client Code", "Main Customer Code"],
    customerNameColumns: ["Client Name"],
    discountColumns: [],
  } as unknown as DistributorProfile;
  assert.deepEqual(rawTemplateHeaders(ps), [
    "Item Code",
    "Item Name",
    "Qty",
    "Date",
    "Client Code",
    "Client Name",
  ]);
}

// Headers are de-duplicated when the same raw column appears in more than one group.
function headersAreDeduped() {
  const p = {
    distributorCode: "X",
    distributorName: "X",
    productColumns: ["Col"],
    qtyColumns: ["Col"],
    valueSource: "recompute",
    dateColumns: [],
    customerCodeColumns: ["Cust"],
  } as unknown as DistributorProfile;
  assert.deepEqual(rawTemplateHeaders(p), ["Col", "Cust"]);
}

export function runSalesRawTemplateTests() {
  cpHeadersMimicRawLayout();
  psHeadersIncludeDate();
  headersAreDeduped();
}
