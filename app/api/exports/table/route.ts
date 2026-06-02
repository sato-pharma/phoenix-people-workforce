import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildPhoenixTableWorkbook,
  type ExportColumn,
  type ExportRow,
} from "@/lib/export/table-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    // The export only re-formats rows the caller already holds, but it is an
    // admin-surface (dashboard) feature, so gate it behind the same overview read
    // permission as the pages that render the tables. Throws Forbidden -> 403.
    await assertPermission(access, "overview", "read");

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
