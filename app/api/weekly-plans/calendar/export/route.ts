// Planning Calendar — XLSX export. READ-ONLY. Builds a two-sheet workbook (per-user summary +
// detailed plans grouped by user) from the shared planning calendar for the requested month.
// Gated to SFE Manager and Super Admin ONLY (canExportPlanningCalendar) — the Export button on the
// page is UX; this server check is the security boundary. The data is re-queried here via the same
// service the calendar renders from (never trusted from the client), so the file can never contain
// more than the caller's own scoped, on-screen calendar.
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { canExportPlanningCalendar, type PlanningCalendarPlanItem } from "@/lib/weekly-planning/calendar";
import {
  buildPlanningCalendarWorkbook,
  planningCalendarExportFileName,
} from "@/lib/weekly-planning/calendar-export";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampMonth(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : fallback;
}

function clampYear(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.role) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (!canExportPlanningCalendar(access.role)) {
      return NextResponse.json({ error: "Forbidden: Planning calendar export" }, { status: 403 });
    }

    const url = new URL(request.url);
    const now = new Date();
    const year = clampYear(url.searchParams.get("year"), now.getUTCFullYear());
    const month = clampMonth(url.searchParams.get("month"), now.getUTCMonth() + 1);

    // Re-query server-side using the same service the calendar renders from. This re-asserts
    // weekly_plans:read and applies the caller's own role/line visibility scope, so the exported
    // workbook matches exactly what they see on screen for the month.
    const workspace = await getSharedPlanningCalendarWorkspace(access, year, month);
    const planItems = workspace.items.filter(
      (item): item is PlanningCalendarPlanItem => item.source === "plan",
    );

    const buffer = await buildPlanningCalendarWorkbook({ items: planItems, year, month });

    // Who pulled the company planning picture, for which month — mirrors the Business Review export.
    // Best-effort (writeAuditLog never throws); the download still proceeds if the row can't be written.
    await writeAuditLog({
      actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      entityId: `${year}-${String(month).padStart(2, "0")}`,
      entityType: "planning_calendar_export",
      newValues: {
        year,
        month,
        planCount: planItems.length,
        ownerCount: workspace.summary.submittedOwnerCount,
        conflictCount: workspace.summary.conflictCount,
      },
      summary: `Planning calendar exported (${year}-${String(month).padStart(2, "0")}, ${planItems.length} plan rows).`,
    });

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="${planningCalendarExportFileName(year, month)}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logError("planning-calendar.export failed", { error });
    return NextResponse.json({ error: "Failed to generate the export" }, { status: 500 });
  }
}
