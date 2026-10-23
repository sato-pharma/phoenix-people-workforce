import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { importSosTerritoryMappingWorkbook } from "@/lib/sales/sos-mapping-templates";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const formData = await request.formData();
    const formFile = formData.get("file");
    const file = formFile instanceof File ? formFile : null;
    if (!file) {
      return NextResponse.json({ success: false, error: "A territory mapping file is required." }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_mapping_file",
      emptyMessage: "The territory mapping file is empty.",
      tooLargeError: "mapping_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The territory mapping file"),
      unsupportedError: "unsupported_mapping_file_type",
      unsupportedMessage: "Upload the territory mapping in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
    }

    const actorId = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importSosTerritoryMappingWorkbook({ file, actorId });
    const blocked = result.blockedRows.length > 0;
    const hardFail = blocked && result.saved === 0;

    return NextResponse.json(
      {
        success: !hardFail,
        result,
        error: hardFail ? "No rows could be imported. Fix the listed rows and re-upload." : undefined,
        message: blocked
          ? `${result.saved} mapping(s) saved — ${result.blockedRows.length} row(s) need fixing (see below).`
          : `${result.saved} mappings saved, ${result.skipped} skipped.`,
      },
      { status: hardFail ? 400 : 200 },
    );
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to import the territory mapping.") },
      { status: 500 },
    );
  }
}
