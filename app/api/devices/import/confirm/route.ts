import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  DEVICE_IMPORT_MAX_ROWS,
  executeDeviceImport,
  parseDeviceImportFile,
} from "@/lib/devices/bulk-import";
import { deviceErrorMessage, getDeviceRegisterData } from "@/lib/devices/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Writes the import.
 *
 * IT TAKES THE FILE AGAIN, AND RE-VALIDATES FROM SCRATCH — it does not trust a preview the client
 * is holding. Two reasons, and the second is the one that matters: a client-held preview can be
 * edited before it is sent back, and the register may have MOVED between the dry run and the
 * commit. Somebody else registering PHX-LAP-0007 in the intervening minute must turn this row into
 * a reported skip, not into a duplicate or a crash. `executeDeviceImport` re-runs the preview
 * itself for exactly that reason.
 *
 * It answers **200 with a per-row report even when some rows failed**, because a bulk write is
 * partial by nature: a 500 naming one bad row would leave the importer unable to tell which of the
 * other 84 landed.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    // `request.formData()` THROWS when the request carries no multipart body at all, before any
    // check on the field — so a caller who forgot the file got a raw
    // "Content-Type was not one of multipart/form-data" instead of a sentence they could act on.
    // Verified against the real handler, not assumed.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "missing_file", message: "Attach the filled-in device import template." },
        { status: 400 },
      );
    }

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
        {
          error: "no_rows",
          // The likeliest way to reach this is the "Walk the fleet" sheet, which arrives with one
          // row per employee and no device on any of them. "No device rows" reads there as a fault
          // in the file rather than as "you have not filled it in yet", so the message says which.
          message:
            "Nothing has been saved. There is no device on any row of this file yet — put an asset tag and a serial number or an IMEI beside the people who are holding something, then choose the file again.",
        },
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

    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const result = await executeDeviceImport(rows, actor);

    // The refreshed register travels back with the report so the page does not have to ask for it
    // separately and briefly show the old counts beside the new outcomes.
    return NextResponse.json({ ...(await getDeviceRegisterData()), importResult: result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "device_import_failed", message: deviceErrorMessage(error) },
      { status: 400 },
    );
  }
}
