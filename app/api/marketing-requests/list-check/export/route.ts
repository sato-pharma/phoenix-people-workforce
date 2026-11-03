import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { afterResponse } from "@/lib/http/after-response";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage, forbiddenError } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";
import { loadListCheckBoard } from "@/lib/marketing-requests/crm-list-check-board-service";
import { buildListCheckWorkbook, listCheckFilename } from "@/lib/marketing-requests/crm-list-check-export";
import { canReadListCheckBoard } from "@/lib/marketing-requests/crm-list-check-rules";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The Excel copy of the doctor-list check, behind the board's own role predicate. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canReadListCheckBoard(access.role)) {
      throw forbiddenError("You do not have access to the doctor-list check.");
    }

    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:marketing:list-check",
    });

    const board = await loadListCheckBoard(access);
    const workbook = await buildListCheckWorkbook(board);
    const buffer = await workbook.xlsx.writeBuffer();
    // Doctors, reps and money leave the building, so the fact that the file was taken is recorded.
    await afterResponse("marketing_list_check_export_audit", () =>
      writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: null,
        entityType: "marketing_list_check_export",
        summary: `Exported the Doctor-List Check (${board.rows.length} rows)`,
      }),
    );
    return new NextResponse(buffer instanceof ArrayBuffer ? buffer : Buffer.from(buffer), {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="${listCheckFilename(board.generatedAtIso)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to the doctor-list check." }, { status: 403 });
    }
    return NextResponse.json(
      { error: "marketing_list_check_export_failed", message: clientSafeErrorMessage(error, "The doctor-list check export failed.") },
      { status: 500 },
    );
  }
}
