import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  importWeeklyPosRegionMappingWorkbook,
  loadWeeklyPosRegionMappingAdmin,
} from "@/lib/sales/weekly/pos-region-mappings";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const data = await loadWeeklyPosRegionMappingAdmin("PS");
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return mapError(error, "Failed to load POS region mappings.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "POS region mapping XLSX is required." }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_pos_region_mapping_file",
      tooLargeMessage: spreadsheetTooLargeMessage("POS region mapping workbook"),
      unsupportedMessage: "Upload the completed POS region mapping workbook as .xlsx.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, error: validation.message, code: validation.error },
        { status: validation.status },
      );
    }

    const actorId = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    const result = await importWeeklyPosRegionMappingWorkbook({ actorId, file });
    const data = await loadWeeklyPosRegionMappingAdmin("PS");
    const blocked = result.blockedRows.length > 0;
    return NextResponse.json(
      {
        success: !blocked,
        data,
        result,
        error: blocked ? "Mapping import has invalid rows. Fix them and upload again." : undefined,
        message: blocked
          ? "Mapping import blocked."
          : `${result.inserted} added, ${result.updated} updated, ${result.skipped} skipped.`,
      },
      { status: blocked ? 400 : 200 },
    );
  } catch (error) {
    return mapError(error, "Failed to import POS region mappings.");
  }
}

function mapError(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}
