import { NextResponse } from "next/server";

import { type MonitoringEventSort, getAdminMonitoringStats } from "@/lib/admin/service";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function coerceMonitoringPageSize(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 20;
  const safe = Math.floor(parsed);
  if (safe <= 0) return 20;
  return safe;
}

function coerceMonitoringSort(value: string | null): MonitoringEventSort {
  return value === "oldest" ? "oldest" : "newest";
}

function toCsvCell(value: string | null | undefined) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value).replace(/"/g, "\"\"");
  return /[",\r\n]/.test(stringValue) ? `"${stringValue}"` : stringValue;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!await canAccess(access, "admin", "read") && !await canAccess(access, "overview", "read")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const url = new URL(request.url);
    const pageSize = coerceMonitoringPageSize(url.searchParams.get("pageSize"));
    const result = await getAdminMonitoringStats({
      entityType: url.searchParams.get("type") ?? undefined,
      page: 1,
      pageSize,
      search: url.searchParams.get("search") ?? undefined,
      sort: coerceMonitoringSort(url.searchParams.get("sort")),
      fetchAll: true,
      maxPageSize: 5000,
    });

    const rows = result.recentEvents.rows;
    const headers = [
      "HR ID",
      "Employee Name",
      "Employee Login",
      "Event Type",
      "Summary",
      "Timestamp",
    ];
    const csv = [headers.map(toCsvCell), ...rows.map((row) => [
      row.actorHrId,
      row.actorName ?? row.actor,
      row.actorLoginId,
      row.entityType,
      row.summary,
      row.createdAt,
    ].map(toCsvCell))]
      .map((row) => row.join(","))
      .join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="monitoring-security-activity-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to export monitoring security activity." },
      { status: 500 },
    );
  }
}
