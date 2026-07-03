import {
  loadSalesReferenceData,
  type DistributorSalesValidationResult,
  type SalesDistributorOption,
} from "@/lib/sales/monthly-distributor-import";
import {
  computeOfficeAllocation,
  loadOfficeBrickShare,
  loadOfficeNameToCode,
  loadOfficeRegionShare,
  OFFICE_DISTRIBUTOR_CODE,
  persistOfficeAllocation,
  type OfficeMappedProduct,
  type OfficeUnmappedName,
} from "@/lib/sales/office-allocation";
import { parseOfficePivotBuffer } from "@/lib/sales/office-pivot";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";

// Office front door: parse the office pivot, resolve product NAMES → codes via the Office product
// mapping, load the period's contribution base, and compute the allocation. `preview` never writes;
// `commit` persists an Office batch only when fully mapped (fail-closed).

const PERIOD_RE = /^\d{4}-\d{2}$/;

async function buildOfficeAllocation(input: { buffer: ArrayBuffer | Buffer; fileName: string; period: string }) {
  if (!PERIOD_RE.test(input.period)) {
    throw new SalesWorkflowError("invalid_request", "A valid period (YYYY-MM) is required for the office allocation.", 400);
  }

  const [references, nameToCode, pivot] = await Promise.all([
    loadSalesReferenceData({ includeCustomerBricks: false }),
    loadOfficeNameToCode(),
    parseOfficePivotBuffer(input.buffer),
  ]);

  if (pivot.rows.length === 0) {
    throw new SalesWorkflowError("invalid_office_file", "No product rows were found in the office file. Expected a pivot with a product-name column and a units column.", 400);
  }

  const productByCode = new Map(references.products.map((p) => [normalizeCodeKey(p.productCode), p]));
  const mappedByCode = new Map<string, OfficeMappedProduct>();
  const unmappedNames: OfficeUnmappedName[] = [];

  for (const row of pivot.rows) {
    if (!(row.units > 0)) continue; // zero/negative office units contribute nothing — ignore
    const aliasKey = normalizeAliasKey(row.productName);
    const code = aliasKey ? nameToCode.get(aliasKey) : undefined;
    const codeKey = code ? normalizeCodeKey(code) : "";
    const reference = codeKey ? productByCode.get(codeKey) : undefined;
    if (!reference) {
      unmappedNames.push({ productName: row.productName, units: row.units, rowNumber: row.rowNumber });
      continue;
    }
    const existing = mappedByCode.get(codeKey);
    if (existing) existing.units += row.units;
    else mappedByCode.set(codeKey, { productCode: reference.productCode, productName: reference.productName, units: row.units, rowNumber: row.rowNumber });
  }

  const [regionShare, brickShare] = await Promise.all([
    loadOfficeRegionShare(input.period),
    loadOfficeBrickShare(input.period),
  ]);

  const distributor: SalesDistributorOption =
    references.distributors.find((d) => normalizeCodeKey(d.code) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE))
    ?? { code: OFFICE_DISTRIBUTOR_CODE, name: "Marcyrl" };

  return computeOfficeAllocation({
    brickShare,
    distributor,
    fileName: input.fileName,
    mapped: [...mappedByCode.values()],
    period: input.period,
    references,
    regionShare,
    sheetName: pivot.sheetName,
    unmappedNames,
  });
}

function stripRows(result: DistributorSalesValidationResult & { parsedRows: unknown }): DistributorSalesValidationResult {
  const { parsedRows, ...rest } = result;
  void parsedRows;
  return rest as DistributorSalesValidationResult;
}

export async function previewOfficeAllocation(input: { buffer: ArrayBuffer | Buffer; fileName: string; period: string }): Promise<DistributorSalesValidationResult> {
  const result = await buildOfficeAllocation(input);
  return stripRows(result);
}

export async function commitOfficeAllocation(input: { buffer: ArrayBuffer | Buffer; fileName: string; period: string; uploadedBy: string }): Promise<DistributorSalesValidationResult> {
  const result = await buildOfficeAllocation(input);
  if (result.status !== "validated") {
    return stripRows(result); // blocked: surface unmapped names, persist nothing
  }
  const persisted = await persistOfficeAllocation(result, input.uploadedBy);
  return persisted;
}
