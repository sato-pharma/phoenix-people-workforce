import assert from "node:assert/strict";
import path from "node:path";

import {
  normalizeMarketingLookupKey,
  parseMarketingReferenceWorkbooks,
  reconcileProductCodesWithSalesCatalog,
  type MarketingProductSeed,
} from "@/lib/marketing-requests/reference-importer";

export async function runMarketingReferenceImporterTests() {
  const parsed = await parseMarketingReferenceWorkbooks({
    pharmacyDatabasePath: path.resolve("Phoenix Pharmacy Database.xlsx"),
    productsPath: path.resolve("phoenix products.xlsx"),
  });

  assert.equal(parsed.summary.products, 21);
  assert.equal(parsed.summary.pharmacyCodeReferences, 20097);
  assert.equal(parsed.summary.skippedPharmacyRows, 5);
  assert.equal(parsed.summary.skippedProductRows, 0);
  assert.equal(parsed.summary.distributors, 12);
  assert.equal(parsed.summary.duplicateDistributorCodePairs, 488);

  const saginko = parsed.products.find((product) =>
    normalizeMarketingLookupKey(product.productName).includes("saginko"),
  );
  assert.ok(saginko, "Saginko should be parsed from the product workbook.");
  assert.equal(saginko?.line, "Anti infective");
  assert.ok((saginko?.factoryPrice ?? 0) > 0);

  const ibnSina = parsed.distributors.find(
    (distributor) => distributor.normalizedName === "ibn sina",
  );
  assert.ok(ibnSina, "Ibn Sina should be normalized as a distributor.");
  assert.equal(ibnSina?.distributorCode, "DST_IBN_SINA");

  const firstReference = parsed.pharmacyCodeReferences[0];
  assert.equal(firstReference.sourceFile, "Phoenix Pharmacy Database.xlsx");
  assert.equal(firstReference.sourceRow, 2);
  assert.equal(firstReference.rawDistributorName, "EGD");
  assert.equal(firstReference.normalizedDistributorName, "egd");
  assert.equal(firstReference.rawPharmacyCode, "24417");

  /* ---------------------------------------------------------------------- */
  /* Product-code reconciliation: sales is the reference for product codes. */
  /* ---------------------------------------------------------------------- */

  const seed = (overrides: Partial<MarketingProductSeed>): MarketingProductSeed => ({
    active: true,
    factoryPrice: 10,
    family: null,
    line: "Anti infective",
    normalizedName: "saginko",
    productCode: "MKT_PRD0016",
    productName: "Saginko",
    sourceCompany: null,
    sourceFile: "phoenix products.xlsx",
    ...overrides,
  });

  const reconciled = reconcileProductCodesWithSalesCatalog(
    [
      seed({}), // exact name + line match
      seed({
        line: "CNS",
        normalizedName: "tebofrtin drops",
        productCode: "MKT_PRD0001",
        productName: "Tebofrtin drops",
      }), // known spelling-drift alias match
      seed({
        line: "Pedia",
        normalizedName: "some future product",
        productCode: "MKT_PRD0099",
        productName: "Some Future Product",
      }), // no sales match yet
    ],
    [
      { line: "Anti infective", normalizedName: "saginko", productCode: "SA001" },
      { line: "CNS", normalizedName: "tebofotin drops", productCode: "TE001" },
    ],
  );
  assert.equal(reconciled[0].productCode, "SA001", "exact name+line match takes the sales product_code");
  assert.equal(reconciled[1].productCode, "TE001", "a known name-drift alias still resolves to the sales product_code");
  assert.equal(reconciled[2].productCode, "MKT_PRD0099", "a product with no sales match keeps its generated code");
}
