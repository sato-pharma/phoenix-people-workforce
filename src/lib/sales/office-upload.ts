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
import { assertOfficeProductsOnAllowedLine } from "@/lib/sales/office-distributor";
import { parseOfficePivotBuffer } from "@/lib/sales/office-pivot";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { fileSha256 } from "@/lib/sales/upload-fingerprint";
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

  if (pivot.rows.length === 0 && pivot.badUnitsRows.length === 0) {
    throw new SalesWorkflowError("invalid_office_file", "No product rows were found in the office file. Expected a pivot with a product-name column and a units column.", 400);
  }

  // A named product whose units cell is unreadable used to be silently imported as 0 units, so its
  // office contribution vanished while the upload looked clean. Refuse instead: the numbers must be
  // fixed in the sheet, not quietly zeroed. Fail-closed matches the unmapped-name path below.
  if (pivot.badUnitsRows.length > 0) {
    const sample = pivot.badUnitsRows
      .slice(0, 5)
      .map((b) => `"${b.productName}" (row ${b.rowNumber}: "${b.rawUnits}")`)
      .join(", ");
    throw new SalesWorkflowError(
      "invalid_office_file",
      `${pivot.badUnitsRows.length} office product row(s) have a units value that is not a number and would be dropped as zero. Fix the units column in the sheet, then upload again. Examples: ${sample}.`,
      400,
      { badUnitsRows: pivot.badUnitsRows },
    );
  }

  const productByCode = new Map(references.products.map((p) => [normalizeCodeKey(p.productCode), p]));
  const mappedByCode = new Map<string, OfficeMappedProduct>();
  const unmappedNames: OfficeUnmappedName[] = [];
  // The line each mapped product belongs to, captured here because the reference is already in
  // hand. OfficeMappedProduct is declared in the locked allocation module and is not ours to widen.
  const lineByCode = new Map<string, string>();

  for (const row of pivot.rows) {
    // Negatives are RETURNS and must net against the month's sales for that product, so they reach
    // the allocator instead of being dropped here. A pivot row of -10 against 100 sold now
    // allocates 90; previously it allocated 100 and the 10 stayed on real bricks forever.
    // Zero and non-numeric still contribute nothing.
    if (!Number.isFinite(row.units) || row.units === 0) continue;
    const aliasKey = normalizeAliasKey(row.productName);
    const code = aliasKey ? nameToCode.get(aliasKey) : undefined;
    const codeKey = code ? normalizeCodeKey(code) : "";
    const reference = codeKey ? productByCode.get(codeKey) : undefined;
    if (!reference) {
      unmappedNames.push({ productName: row.productName, units: row.units, rowNumber: row.rowNumber });
      continue;
    }
    lineByCode.set(codeKey, reference.line);
    const existing = mappedByCode.get(codeKey);
    if (existing) existing.units += row.units;
    else mappedByCode.set(codeKey, { productCode: reference.productCode, productName: reference.productName, units: row.units, rowNumber: row.rowNumber });
  }

  // The Office channel is CNS only — the owner's rule, stated again on 2026-09-05. Until now it was
  // enforced NOWHERE: the closing simply declined to show a breakdown for another line, while this
  // upload accepted the product and the locked value-share rule allocated it. Pedia's 2026-01 slice
  // is what that looks like from the outside — Lacto Advanced 1 and 2, 556 units, spread across
  // Pedia's areas and then hidden by the setting that was supposed to forbid them.
  assertOfficeProductsOnAllowedLine(
    [...mappedByCode.values()].map((product) => ({
      line: lineByCode.get(normalizeCodeKey(product.productCode)) ?? "",
      productCode: product.productCode,
      productName: product.productName,
      units: product.units,
    })),
  );

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
  // The fingerprint of the Office workbook itself (REC-069): the same file under another month is refused.
  const persisted = await persistOfficeAllocation({ ...result, fileSha256: fileSha256(input.buffer) }, input.uploadedBy);
  return persisted;
}
