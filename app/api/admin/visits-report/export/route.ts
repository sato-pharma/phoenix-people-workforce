import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getVisitsReportExportRows } from "@/lib/visits-report/service";
import type { VisitsMappingStatus } from "@/lib/visits-report/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mappingStatuses: readonly VisitsMappingStatus[] = ["agent_unmapped", "double_unmapped", "either_unmapped", "fully_mapped"];

function dateParam(value: string | null) {
  const text = (value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function mappingStatusParam(value: string | null): VisitsMappingStatus | null {
  return mappingStatuses.includes(value as VisitsMappingStatus) ? (value as VisitsMappingStatus) : null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Only Super Admin can export the Visits Report.", success: false },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const result = await getVisitsReportExportRows({
      agentName: url.searchParams.get("agent"),
      ampm: url.searchParams.get("ampm"),
      dateFrom: dateParam(url.searchParams.get("dateFrom")),
      dateTo: dateParam(url.searchParams.get("dateTo")),
      mappingStatus: mappingStatusParam(url.searchParams.get("mappingStatus")),
      search: url.searchParams.get("search"),
      visitType: url.searchParams.get("visitType"),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Visits Report export failed.";
    return NextResponse.json({ error: "visits_export_failed", message, success: false }, { status: 500 });
  }
}
