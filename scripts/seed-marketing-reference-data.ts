import path from "node:path";

import { seedMarketingReferenceData } from "@/lib/marketing-requests/reference-importer";

const projectRoot = process.cwd();

function resolveInputPath(value: string | undefined, fallback: string) {
  return path.resolve(projectRoot, value?.trim() || fallback);
}

const productsPath = resolveInputPath(
  process.env.MARKETING_PRODUCTS_XLSX,
  "phoenix products.xlsx",
);
const pharmacyDatabasePath = resolveInputPath(
  process.env.MARKETING_PHARMACY_DATABASE_XLSX,
  "Phoenix Pharmacy Database.xlsx",
);

const result = await seedMarketingReferenceData({
  pharmacyDatabasePath,
  productsPath,
});

console.log(JSON.stringify(result, null, 2));
