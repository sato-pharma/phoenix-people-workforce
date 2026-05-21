import assert from "node:assert/strict";
import path from "node:path";

import {
  normalizeMarketingLookupKey,
  parseMarketingReferenceWorkbooks,
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
}
