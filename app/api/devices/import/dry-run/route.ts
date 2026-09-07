import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildDeviceImportPreview,
  DEVICE_IMPORT_MAX_ROWS,
  parseDeviceImportFile,
} from "@/lib/devices/bulk-import";
import { deviceErrorMessage } from "@/lib/devices/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What WOULD happen, without anything happening.
 *
 * It writes nothing at all, which is why it is worth a route of its own: an asset register is
 * evidence, and the cheapest moment to catch a serial in the IMEI column or a duplicate asset tag
 * is before 85 rows are written, not after.
 *
 * A POST, not a GET, because it carries a file — and CSRF-guarded for the same reason every other
 * mutation-shaped route here is, even though this one mutates nothing: it reads the whole employee
 * directory to resolve holders, and that is not a payload a cross-origin page should be able to
 * make a logged-in browser fetch.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Attach the filled-in device import template." },
        { status: 400 },
      );
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "empty_file",
      emptyMessage: "That file is empty.",
      tooLargeError: "device_import_file_too_large",
      tooLargeMessage: "The device import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload the device import template in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: validation.status },
      );
    }

    const rows = await parseDeviceImportFile(await file.arrayBuffer());

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "no_rows", message: "That file has no device rows in it." },
        { status: 400 },
      );
    }
    if (rows.length > DEVICE_IMPORT_MAX_ROWS) {
      return NextResponse.json(
        {
          error: "too_many_rows",
          message: `That file has ${rows.length} rows. An import is limited to ${DEVICE_IMPORT_MAX_ROWS} at a time.`,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(await buildDeviceImportPreview(rows));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }
    // A parse failure is the CALLER's file being wrong, not the server failing — and its message is
    // written to be read by the person who chose the file.
    return NextResponse.json(
      { error: "device_import_dry_run_failed", message: deviceErrorMessage(error) },
      { status: 400 },
    );
  }
}
