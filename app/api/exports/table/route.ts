import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildPhoenixTableWorkbook,
  type ExportColumn,
  type ExportRow,
} from "@/lib/export/table-workbook";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

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

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const payload = (await request.json()) as ExportPayload;
    if (!Array.isArray(payload.columns) || payload.columns.length === 0) {
      return NextResponse.json({ error: "No columns to export." }, { status: 400 });
    }

    const title = (payload.title || "Phoenix Export").toString();
    const buffer = await buildPhoenixTableWorkbook({
      title,
      subtitle: payload.subtitle,
      sheetName: payload.sheetName,
      columns: payload.columns,
      rows: Array.isArray(payload.rows) ? payload.rows : [],
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
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 },
    );
  }
}
