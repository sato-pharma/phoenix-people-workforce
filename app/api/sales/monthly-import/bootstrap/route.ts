import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { learnFromCleanedFile } from "@/lib/sales/normalizer/service";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bootstrap the mapping dictionary from a previously CODED file (raw columns + Phoenix Product ID /
// Brick ID side by side, e.g. the user's existing "customer sales" master) — mines every raw → Phoenix
// pair and saves them as aliases. One upload teaches hundreds of mappings so future raw files auto-code.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "A coded file is required." }, { status: 400 });
    }
    if (!distributorCode) {
      return NextResponse.json({ success: false, error: "Distributor is required." }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_mapping_file",
      emptyMessage: "The file is empty.",
      tooLargeError: "mapping_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The file"),
      unsupportedError: "unsupported_mapping_file_type",
      unsupportedMessage: "Upload the file in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
    }

    const result = await learnFromCleanedFile(distributorCode, file);
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: "source_of_sales_product_aliases",
      entityType: "sales_import_batch",
      newValues: { distributorCode, ...result, source: "mapping_bootstrap" },
      summary: `Mapping bootstrap (${distributorCode}) — ${result.saved} learned from ${result.scannedRows} rows.`,
    });
    return NextResponse.json({
      success: true,
      result,
      message: `${result.saved} mappings learned from ${result.scannedRows} rows (${result.skipped} already known, ${result.invalid} invalid).`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to learn from the file.") },
      { status: 500 },
    );
  }
}
