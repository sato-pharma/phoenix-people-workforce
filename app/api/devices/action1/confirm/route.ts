import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  Action1NotConfiguredError,
  Action1RequestError,
  action1ErrorMessage,
  fetchAction1Endpoints,
  mapAction1Records,
} from "@/lib/devices/action1";
import { DEVICE_IMPORT_MAX_ROWS, executeDeviceImport } from "@/lib/devices/bulk-import";
import {
  importActor,
  recordDeviceImportAttempt,
  recordDeviceImportGateRejection,
} from "@/lib/devices/import-attempt-log";
import { getDeviceRegisterData } from "@/lib/devices/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Writes the pull.
 *
 * IT PULLS FROM ACTION1 AGAIN rather than trusting the preview the browser is holding, exactly as
 * the spreadsheet commit re-reads the file. Two reasons and the second is the one that matters: a
 * client-held preview can be edited before it comes back, and the REGISTER can move in between —
 * somebody registering that serial by hand in the intervening minute has to become a reported skip
 * rather than a duplicate row against one physical machine.
 *
 * NOTHING IS ISSUED TO ANYBODY. Every row this produces carries no holder, so the devices land in
 * stock and the custody record stays a press somebody makes with the machine in front of them. The
 * per-row report still names `issued`, and on this path it is always zero.
 *
 * It answers 200 with a per-row report even when rows failed, for the same reason the file commit
 * does: a bulk write is partial by nature, and a 500 naming one bad endpoint would leave nobody
 * able to tell which of the others landed.
 */
export async function POST(request: Request) {
  let rowsRead: number | null = null;
  let logAttempt:
    | ((fields: {
        outcome: string;
        imported?: number;
        issued?: number;
        skipped?: number;
        failed?: number;
      }) => Promise<void>)
    | null = null;

  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) {
      await recordDeviceImportGateRejection(request, "import", "same_origin_rejected");
      return csrfError;
    }

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    const actor = importActor(access);
    logAttempt = (fields) =>
      recordDeviceImportAttempt({
        stage: "import",
        actor,
        fileName: "Action1 pull",
        fileBytes: null,
        rowsRead,
        ...fields,
      });

    const { records } = await fetchAction1Endpoints();
    const rows = mapAction1Records(records, currentCairoDateOnlyIso());
    rowsRead = rows.length;

    if (rows.length === 0) {
      await logAttempt({ outcome: "no_rows" });
      return NextResponse.json(
        {
          error: "no_rows",
          message: "Nothing has been saved. Action1 has no managed endpoints in this organization.",
        },
        { status: 400 },
      );
    }
    if (rows.length > DEVICE_IMPORT_MAX_ROWS) {
      await logAttempt({ outcome: "too_many_rows" });
      return NextResponse.json(
        {
          error: "too_many_rows",
          message: `Action1 returned ${rows.length} endpoints. A single import is limited to ${DEVICE_IMPORT_MAX_ROWS}.`,
        },
        { status: 400 },
      );
    }

    const result = await executeDeviceImport(rows, actor);
    await logAttempt({
      outcome: "ok",
      imported: result.imported,
      issued: result.issued,
      skipped: result.skipped,
      failed: result.failed,
    });

    return NextResponse.json({ ...(await getDeviceRegisterData()), importResult: result });
  } catch (error) {
    if (isForbiddenError(error)) {
      await recordDeviceImportGateRejection(request, "import", "forbidden");
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }

    const notConfigured = error instanceof Action1NotConfiguredError;
    const status = notConfigured || error instanceof Action1RequestError ? 400 : 502;
    await logAttempt?.({ outcome: notConfigured ? "action1_not_configured" : "action1_unreachable" });
    return NextResponse.json(
      {
        error: notConfigured ? "action1_not_configured" : "action1_unreachable",
        message: action1ErrorMessage(error),
      },
      { status },
    );
  }
}
