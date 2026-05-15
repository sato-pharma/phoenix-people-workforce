import { NextResponse } from "next/server";

import { AUDIT_MODULES, AUDIT_SOURCE_TABLES, getAuditLogs } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (!await canAccess(access, "admin", "read")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const url = new URL(request.url);
    const filter = {
      actor: url.searchParams.get("actor") || null,
      action: url.searchParams.get("action") || null,
      entityId: url.searchParams.get("entityId") || null,
      entityType: url.searchParams.get("entityType") || null,
      dateFrom: url.searchParams.get("dateFrom") || null,
      dateTo: url.searchParams.get("dateTo") || null,
      module: AUDIT_MODULES.find((module) => module === url.searchParams.get("module")) ?? null,
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: Number(url.searchParams.get("pageSize") ?? "50"),
      source: AUDIT_SOURCE_TABLES.find((source) => source === url.searchParams.get("source")) ?? null,
      status: url.searchParams.get("status") || null,
    };

    const result = await getAuditLogs(filter);
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load audit logs." },
      { status: 500 },
    );
  }
}
