import { NextResponse } from "next/server";

import { commitCoachingImport } from "@/lib/coaching/import";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import {
  CoachingApiError,
  jsonError,
  requireCoachingManagementPermission,
} from "@/app/api/coaching/_lib/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await requireCoachingManagementPermission(request, "create");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new CoachingApiError("validation_error", "A coaching workbook (.xlsx) file is required.", 400);
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_coaching_file",
      emptyMessage: "The coaching workbook is empty.",
      tooLargeError: "coaching_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The coaching workbook"),
      unsupportedError: "unsupported_coaching_file_type",
      unsupportedMessage: "Upload the coaching report in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message, success: false },
        { status: validation.status },
      );
    }

    const buffer = await file.arrayBuffer();
    const result = await commitCoachingImport(buffer, access, { sourceFile: file.name });

    const message = `Imported ${result.created.length} report${result.created.length === 1 ? "" : "s"}, archived ${result.archived} resigned-rep evaluation${result.archived === 1 ? "" : "s"}.`;
    return NextResponse.json({ data: result, message, success: true });
  } catch (error) {
    return jsonError(error, "Failed to import coaching reports.");
  }
}
