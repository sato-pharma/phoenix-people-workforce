import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { buildSiExportWorkbook, isSiExportTable } from "@/lib/sales/intelligence/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-side XLSX export. It re-resolves the caller's scope and re-loads the rows through the
// scoped loaders — it NEVER trusts client-supplied rows — so the exclusion of restricted products
// and the line/region scope cannot be bypassed by a tampered request body.

type ExportBody = { table?: string; period?: string | null; includeRestricted?: boolean };

function fileName(table: string, period: string | null) {
  const slug = `${table}-${period ?? "all"}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return `phoenix-sales-intelligence-${slug}.xlsx`;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "export");

    const body = (await request.json().catch(() => ({}))) as ExportBody;
    if (!isSiExportTable(body.table)) {
      return NextResponse.json({ success: false, error: "Unknown export table." }, { status: 400 });
    }
    const period = !body.period || body.period === "all" ? null : body.period;
    // includeRestricted is honoured ONLY for CEO/Super Admin (resolveSalesAccessScope enforces it).
    const scope = await resolveSalesAccessScope(access, { includeRestricted: body.includeRestricted === true });

    const buffer = await buildSiExportWorkbook(body.table, period, scope);
    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName(body.table, period)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 },
    );
  }
}
