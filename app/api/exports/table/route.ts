import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildPhoenixTableWorkbook,
  type ExportColumn,
  type ExportRow,
} from "@/lib/export/table-workbook";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import {
  readTableExportBody,
  TABLE_EXPORT_BODY_TOO_LARGE_MESSAGE,
  TABLE_EXPORT_RATE_LIMIT_SCOPE,
  tableExportBodyTooLarge,
  tableExportRowCapMessage,
} from "@/lib/http/table-export-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The workbook is built in memory in one pass; a large table can take tens of seconds. Give it
// explicit headroom instead of the platform default so it isn't killed mid-build. (The CRM master
// export no longer uses this route — it streams its own workbook via /api/admin/crm/master-export —
// but other admin tables still POST their rendered rows here.)
export const maxDuration = 300;

// Generic, reusable export endpoint. Any admin table can POST its already-rendered
// columns + rows and receive a premium Phoenix-styled .xlsx back. It only formats
// client-provided data (the rows the user already sees), so it requires a signed-in
// session but no extra resource permission.
//
// LIMITED SINCE 2026-10-26 (src/lib/http/table-export-limits.ts): 10 exports a minute per person, a
// body of at most 10 MB (a declared size over it is refused before the body is read), and at most
// 20,000 rows in one export. Each refusal says what happened and what to do.

type ExportPayload = {
  title?: string;
  subtitle?: string;
  sheetName?: string;
  columns?: ExportColumn[];
  rows?: ExportRow[];
  template?: "outstation_expenses";
};

function fileName(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "export";
  return `phoenix-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function tooLarge(message: string) {
  return NextResponse.json({ error: "too_large", message }, { status: 413 });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    // Refused before the body is read and before anyone is looked up.
    if (tableExportBodyTooLarge(request.headers.get("content-length"))) {
      return tooLarge(TABLE_EXPORT_BODY_TOO_LARGE_MESSAGE);
    }

    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: TABLE_EXPORT_RATE_LIMIT_SCOPE });

    const body = await readTableExportBody(request);
    if (!body.ok) {
      return NextResponse.json({ error: body.error, message: body.message }, { status: body.status });
    }
    const payload = (body.payload ?? {}) as ExportPayload;
    if (!Array.isArray(payload.columns) || payload.columns.length === 0) {
      return NextResponse.json({ error: "No columns to export." }, { status: 400 });
    }

    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const rowCapMessage = tableExportRowCapMessage(rows.length);
    if (rowCapMessage) return tooLarge(rowCapMessage);

    const title = (payload.title || "Phoenix Export").toString();
    const buffer = await buildPhoenixTableWorkbook({
      title,
      subtitle: payload.subtitle,
      sheetName: payload.sheetName,
      columns: payload.columns,
      rows,
      template: payload.template,
    });

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName(title)}"`,
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
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: clientSafeErrorMessage(error, "Export failed.") },
      { status: 500 },
    );
  }
}
