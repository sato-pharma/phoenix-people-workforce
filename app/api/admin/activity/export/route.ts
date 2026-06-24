import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { buildActivityRange, getActivityUserSummaries } from "@/lib/activity/service";
import { buildPhoenixTableWorkbook, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLUMNS: ExportColumn[] = [
  { key: "name", label: "Employee" },
  { key: "role", label: "Role" },
  { key: "team", label: "Team / Region" },
  { key: "sessions", label: "Logins", numeric: true },
  { key: "sessionMinutes", label: "Logged-in Min", numeric: true },
  { key: "activeMinutes", label: "Active Min", numeric: true },
  { key: "pageViews", label: "Page Views", numeric: true },
  { key: "distinctModules", label: "Modules", numeric: true },
  { key: "topModule", label: "Top Module" },
  { key: "engagementScore", label: "Engagement", numeric: true },
  { key: "engagementBand", label: "Band" },
  { key: "lastSeen", label: "Last Seen" },
];

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }
    await assertPermission(access, "user_activity", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:activity" });

    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? "7");
    const range = buildActivityRange(days);
    const summaries = await getActivityUserSummaries(range);

    const rows: ExportRow[] = summaries.map((user) => ({
      name: user.name,
      role: user.role,
      team: user.team ?? "—",
      sessions: user.sessions,
      sessionMinutes: user.sessionMinutes,
      activeMinutes: user.activeMinutes,
      pageViews: user.pageViews,
      distinctModules: user.distinctModules,
      topModule: user.topModule ?? "—",
      engagementScore: user.engagement.score,
      engagementBand: user.engagement.band,
      lastSeen: user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString("en-GB") : "—",
    }));

    const buffer = await buildPhoenixTableWorkbook({
      title: "Activity Control Center",
      subtitle: `User activity · last ${range.days} days · exported ${new Date().toLocaleString("en-GB")}`,
      sheetName: "User Activity",
      columns: COLUMNS,
      rows,
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityType: "user_activity_access",
      entityId: null,
      summary: `Exported user activity report (${rows.length} users, last ${range.days} days)`,
    });

    const filename = `activity-control-${range.days}d-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
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
      return NextResponse.json({ error: "forbidden", message: error instanceof Error ? error.message : "Forbidden" }, { status: 403 });
    }
    console.error("[activity] export error", error);
    return NextResponse.json({ error: "server_error", message: "Failed to export activity." }, { status: 500 });
  }
}
