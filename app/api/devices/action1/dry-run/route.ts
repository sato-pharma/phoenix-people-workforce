import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  Action1NotConfiguredError,
  Action1RequestError,
  action1ErrorMessage,
  action1KeySample,
  fetchAction1Endpoints,
  mapAction1Records,
} from "@/lib/devices/action1";
import { buildDeviceImportPreview, DEVICE_IMPORT_MAX_ROWS } from "@/lib/devices/bulk-import";
import {
  importActor,
  recordDeviceImportAttempt,
  recordDeviceImportGateRejection,
} from "@/lib/devices/import-attempt-log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a pull from Action1 WOULD register, without registering anything.
 *
 * The same two-press shape as the spreadsheet import, for the same reason: an asset register is
 * evidence, and the cheapest moment to notice that every machine came back without a serial is
 * before 40 rows are written. It differs in only one way, and the difference is the point — there
 * is no file, so there is nothing to fill in and nothing to get wrong on the way in.
 *
 * A POST despite writing nothing, matching the file dry run: it reads the whole employee directory
 * to resolve holders and it makes an outbound call on the company's Action1 credentials, neither of
 * which a cross-origin page should be able to make a logged-in browser do.
 *
 * `action1` on the response carries what the pull saw — the organization, the endpoint count and
 * the field vocabulary. That last one is not decoration: the mapping was written without live
 * credentials, so the first real pull is where the true key spellings become visible.
 */
export async function POST(request: Request) {
  let rowsRead: number | null = null;
  let logAttempt:
    | ((fields: { outcome: string; ready?: number; withProblems?: number }) => Promise<void>)
    | null = null;

  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) {
      await recordDeviceImportGateRejection(request, "check", "same_origin_rejected");
      return csrfError;
    }

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "import");

    // Same canonicalisation as both spreadsheet routes. HR ids are stored mixed-case, so a
    // different expression here would file one person's presses under two actors.
    const actor = importActor(access);
    logAttempt = (fields) =>
      recordDeviceImportAttempt({
        stage: "check",
        actor,
        // There is no file. The name is what the audit row has to read as a year from now, so it
        // says where the rows came from rather than leaving a blank that looks like a lost filename.
        fileName: "Action1 pull",
        fileBytes: null,
        rowsRead,
        ...fields,
      });

    const { organizationId, records } = await fetchAction1Endpoints();
    const rows = mapAction1Records(records, currentCairoDateOnlyIso());
    rowsRead = rows.length;

    if (rows.length === 0) {
      await logAttempt({ outcome: "no_rows" });
      return NextResponse.json(
        {
          error: "no_rows",
          message:
            "Action1 answered, but it has no managed endpoints in this organization yet. Install " +
            "the Action1 agent on the machine, wait for it to report in, then pull again.",
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

    const preview = await buildDeviceImportPreview(rows);
    await logAttempt({
      outcome: "ok",
      ready: preview.summary.canImport,
      withProblems: preview.summary.withErrors,
    });

    return NextResponse.json({
      ...preview,
      action1: {
        endpointsSeen: records.length,
        fieldsSeen: action1KeySample(records),
        organizationId,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      await recordDeviceImportGateRejection(request, "check", "forbidden");
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import devices." },
        { status: 403 },
      );
    }

    // Not connected yet is a SETUP state, not a fault, and it answers with the two lines that fix
    // it rather than with a 500 that reads as Phoenix being broken.
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
