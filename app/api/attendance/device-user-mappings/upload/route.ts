import { NextResponse } from "next/server";

import { getAttendanceDeviceUserMappingDashboard } from "@/lib/attendance/device-user-mapping";
import { importDeviceMappingsFromWorkbook } from "@/lib/attendance/device-user-mapping-template";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const xlsxValidation = {
  allowedExtensions: [".xlsx"],
  allowedMimeTypes: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
} as const;

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "file_required", message: "Upload the populated attendance device mapping .xlsx template." },
        { status: 400 },
      );
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxValidation,
      tooLargeMessage: spreadsheetTooLargeMessage("Attendance device mapping file"),
      unsupportedMessage: "Upload the Phoenix attendance device mapping .xlsx template.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: validation.status },
      );
    }

    const importResult = await importDeviceMappingsFromWorkbook(file);
    const dashboard = await getAttendanceDeviceUserMappingDashboard();
    return NextResponse.json({ ...importResult, dashboard });
  } catch (error) {
    return apiResponse(error, "Attendance device mapping template upload failed.");
  }
}
