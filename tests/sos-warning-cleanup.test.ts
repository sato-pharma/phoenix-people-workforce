import assert from "node:assert/strict";

import {
  buildSourceOfSalesWarningExport,
  revalidateSourceOfSalesWarningRow,
  summarizeRevalidation,
  type SourceOfSalesReferenceData,
  type SourceOfSalesWarningRow,
} from "../src/lib/sales/source-of-sales-warning-cleanup.ts";

const references: SourceOfSalesReferenceData = {
  areas: [
    { areaCode: "CA1", areaName: "Cairo One", regionCode: "CA" },
  ],
  bricks: [
    { areaCode: "CA1", brickId: "BR-1", regionCode: "CA" },
  ],
  distributors: [
    { distributorCode: "IS", distributorName: "Ibn Sina" },
  ],
  products: [
    { line: "Pedia", productCode: "LA003", productName: "Lacto Basic 1" },
  ],
  regions: [
    { regionCode: "CA", regionName: "Cairo" },
  ],
};

function warningRow(overrides: Partial<SourceOfSalesWarningRow>): SourceOfSalesWarningRow {
  return {
    areaCode: "CA1",
    areaName: "Cairo One",
    brickId: "BR-1",
    clientCode: "C-1",
    clientName: "Customer One",
    distributorCode: "IS",
    id: 1,
    invoicePeriod: "2026-05",
    productCode: "LA003",
    productName: "Wrong Lacto Name",
    rawRow: {},
    regionCode: "CA",
    regionName: "Cairo",
    rowNumber: 2,
    validationIssues: [
      {
        field: "Product Name",
        message: "Product Name is different from the product source table (Lacto Basic 1) for Product Code LA003. Official product reference is used.",
        severity: "warning",
        value: "Wrong Lacto Name",
      },
    ],
    ...overrides,
  };
}

export function runSosWarningCleanupTests() {
  const grouped = buildSourceOfSalesWarningExport([
    warningRow({ id: 1 }),
    warningRow({ id: 2 }),
    warningRow({
      areaCode: "AB3",
      areaName: "Alex West",
      id: 3,
      validationIssues: [
        {
          field: "Area ID",
          message: "Area Code AB3 is not in the area source-of-truth table. Uploaded code is kept for allocation.",
          severity: "warning",
          value: "AB3",
        },
      ],
    }),
  ]);

  assert.equal(grouped.summaryRows.length, 2, "warnings must group by category/field/message/distributor/period");
  assert.equal(grouped.productNameRows.length, 1, "product-name warnings must be grouped into the correction sheet");
  assert.equal(grouped.productNameRows[0].count, 2);
  assert.equal(grouped.productNameRows[0].cleanup_policy, "trusted_product_code_wins");
  assert.equal(grouped.productNameRows[0].uploaded_product_name, "Wrong Lacto Name");
  assert.equal("approved_action" in grouped.productNameRows[0], false, "product-name alias rows are audit-only, not correction actions");
  assert.equal(grouped.areaRows.length, 1, "area warnings must be grouped into the area correction sheet");
  assert.equal(grouped.areaRows[0].area_code, "AB3");

  const trustedCodeAlias = revalidateSourceOfSalesWarningRow(warningRow({}), references);
  assert.equal(trustedCodeAlias.validationState, "valid", "trusted product code makes distributor product-name aliases valid");
  assert.deepEqual(trustedCodeAlias.validationIssues, []);

  const validAfterFix = revalidateSourceOfSalesWarningRow(warningRow({ productName: "Lacto Basic 1" }), references);
  assert.equal(validAfterFix.validationState, "valid", "row becomes valid only when all warnings are resolved");
  assert.deepEqual(validAfterFix.validationIssues, []);

  const missingArea = revalidateSourceOfSalesWarningRow(warningRow({ areaCode: "AB3", productName: "Lacto Basic 1" }), references);
  assert.equal(missingArea.validationState, "warning");
  assert.match(String(missingArea.validationIssues[0].message), /Area Code AB3/);

  assert.deepEqual(summarizeRevalidation([trustedCodeAlias, validAfterFix, missingArea]), {
    total: 3,
    valid: 2,
    warning: 1,
  });
}
