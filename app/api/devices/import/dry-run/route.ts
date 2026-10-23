import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildDeviceImportPreview,
  DEVICE_IMPORT_MAX_ROWS,
  parseDeviceImportFile,
} from "@/lib/devices/bulk-import";
import {
  recordDeviceImportAttempt,
  recordDeviceImportGateRejection,
} from "@/lib/devices/import-attempt-log";
import { deviceErrorMessage } from "@/lib/devices/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

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
  // The check press is logged too. It writes nothing to the REGISTER, which is the property this
  // route exists for - but whether somebody got as far as checking a file is exactly the question
  // that could not be answered on 2026-09-08, so the attempt itself is recorded.
  let fileName: string | null = null;
  let fileBytes: number | null = null;
  let rowsRead: number | null = null;
  let logAttempt: ((fields: { outcome: string; ready?: number; withProblems?: number; imported?: number; issued?: number; skipped?: number; failed?: number }) => Promise<void>) | null = null;

  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) {
      // Above the permission gate, so this is the one log that has to defend itself - see
      // `recordDeviceImportGateRejection`. A guest writes nothing and a real caller is rate-limited.
      await recordDeviceImportGateRejection(request, "check", "same_origin_rejected");
      return csrfError;
    }

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    // Only after the gate - see the note in `import-attempt-log.ts` on why this is not logged
    // before the permission check.
    // Same expression the confirm route uses. HR ids are stored mixed-case, so the two presses
    // must canonicalise identically or one person appears in the log as two.
    const actor = hrIdForStorage(access.hrId) ?? access.loginId ?? access.role;
    logAttempt = (fields) =>
      recordDeviceImportAttempt({ stage: "check", actor, fileName, fileBytes, rowsRead, ...fields });

    // `request.formData()` THROWS when the request carries no multipart body at all, before any
    // check on the field — so a caller who forgot the file got a raw
    // "Content-Type was not one of multipart/form-data" instead of a sentence they could act on.
    // Verified against the real handler, not assumed.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      await logAttempt?.({ outcome: "missing_file" });
      return NextResponse.json(
        { error: "missing_file", message: "Attach the filled-in device import template." },
        { status: 400 },
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      await logAttempt?.({ outcome: "missing_file" });
      return NextResponse.json(
        { error: "missing_file", message: "Attach the filled-in device import template." },
        { status: 400 },
      );
    }
    fileName = file.name || null;
    fileBytes = file.size;

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "empty_file",
      emptyMessage: "That file is empty.",
      tooLargeError: "device_import_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("The device import file"),
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload the device import template in .xlsx format.",
    });
    if (!validation.ok) {
      await logAttempt?.({ outcome: validation.error });
      return NextResponse.json(
        { error: validation.error, message: validation.message },
        { status: validation.status },
      );
    }

    const rows = await parseDeviceImportFile(await file.arrayBuffer());
    rowsRead = rows.length;

    if (rows.length === 0) {
      await logAttempt?.({ outcome: "no_rows" });
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
      await logAttempt?.({ outcome: "too_many_rows" });
      return NextResponse.json(
        {
          error: "too_many_rows",
          message: `That file has ${rows.length} rows. An import is limited to ${DEVICE_IMPORT_MAX_ROWS} at a time.`,
        },
        { status: 400 },
      );
    }

    const preview = await buildDeviceImportPreview(rows);
    await logAttempt?.({
      outcome: "ok",
      ready: preview.summary.canImport,
      withProblems: preview.summary.withErrors,
    });
    return NextResponse.json(preview);
  } catch (error) {
    if (isForbiddenError(error)) {
      // The gate refused an AUTHENTICATED caller. Previously indistinguishable from a press that
      // never arrived, which is exactly the ambiguity this log exists to remove.
      await recordDeviceImportGateRejection(request, "check", "forbidden");
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }
    // A parse failure is the CALLER's file being wrong, not the server failing — and its message is
    // written to be read by the person who chose the file.
    await logAttempt?.({ outcome: "device_import_dry_run_failed" });
    return NextResponse.json(
      { error: "device_import_dry_run_failed", message: deviceErrorMessage(error) },
      { status: 400 },
    );
  }
}
