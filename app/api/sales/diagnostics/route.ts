import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { RESTRICTED_PRODUCT_CODES, canViewRestrictedProducts } from "@/lib/sales/access-scope";
import { diagnoseWorkbook } from "@/lib/sales/diagnostics";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only troubleshooting: detect distributor + analyze coverage WITHOUT importing anything.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const form = await request.formData();
    const file = form.get("file");
    const distributor = String(form.get("distributor") ?? "").trim();
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "A file is required." }, { status: 400 });

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_sales_file", emptyMessage: "The sheet is empty.",
      tooLargeError: "sales_file_too_large", tooLargeMessage: "The sheet exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_sales_file_type", unsupportedMessage: "Upload an .xlsx file.",
    });
    if (!validation.ok) return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });

    // Confidential products (LA003/LA004/SS001) are stripped from the diagnostic breakdown/preview
    // for every role except CEO / Super Admin — this troubleshooting tool must not leak them either.
    const excludeProductCodes = canViewRestrictedProducts(access.role) ? [] : [...RESTRICTED_PRODUCT_CODES];
    const result = await diagnoseWorkbook(file, distributor || undefined, excludeProductCodes);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Diagnostics failed." }, { status: 500 });
  }
}
