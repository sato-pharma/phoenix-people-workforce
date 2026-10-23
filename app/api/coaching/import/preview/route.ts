import { NextResponse } from "next/server";

import { previewCoachingImport } from "@/lib/coaching/import";
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
    await requireCoachingManagementPermission(request, "create");

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
    const preview = await previewCoachingImport(buffer);

    return NextResponse.json({ data: preview, fileName: file.name, success: true });
  } catch (error) {
    return jsonError(error, "Failed to preview coaching import.");
  }
}
