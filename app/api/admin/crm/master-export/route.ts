import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  getCrmMasterExportRows,
  type CrmMasterAmpm,
  type CrmMasterDataset,
  type CrmMasterMappingStatus,
} from "@/lib/crm/master";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Returns ALL rows for the current CRM master dataset + filters (unpaginated, capped at 50k) so the
// client can build an XLSX. Super-Admin only, matching the /admin/crm page gate. raw_payload is
// stripped — the sheet only needs the displayed columns.
export async function GET(request: NextRequest) {
  const access = await resolveAccessContext(request);
  if (!access.loginId && !access.hrId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (access.role !== "Super Admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const minDurationRaw = params.get("minDuration");
  const minDuration = minDurationRaw != null && Number.isFinite(Number(minDurationRaw)) ? Number(minDurationRaw) : null;
  // Forward ALL 13 filters the master table supports — previously only 8 were passed, so an export
  // filtered by Line / Hire-date / Min-duration / Half-days-only silently returned a SUPERSET of the
  // on-screen rows. getCrmMasterExportRows already honours every one of these.
  const result = await getCrmMasterExportRows({
    agentHrId: params.get("agentHrId"),
    ampm: (params.get("ampm") ?? undefined) as CrmMasterAmpm | undefined,
    dataset: (params.get("dataset") ?? undefined) as CrmMasterDataset | undefined,
    dateFrom: params.get("dateFrom"),
    dateTo: params.get("dateTo"),
    halfDaysOnly: params.get("halfDaysOnly") === "1",
    hireFrom: params.get("hireFrom"),
    hireTo: params.get("hireTo"),
    line: params.get("line"),
    mappingStatus: (params.get("mappingStatus") ?? undefined) as CrmMasterMappingStatus | undefined,
    minDuration,
    search: params.get("search"),
    visitType: params.get("visitType"),
  });

  const rows = result.rows.map((row) => {
    const copy = { ...row } as Record<string, unknown>;
    delete copy.raw_payload;
    return copy;
  });

  return NextResponse.json({ dataset: result.dataset, rows, truncated: result.truncated });
}
