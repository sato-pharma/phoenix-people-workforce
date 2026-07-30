import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  crmMasterExportColumns,
  crmMasterExportLabel,
  streamCrmMasterExportPages,
  type CrmMasterAmpm,
  type CrmMasterDataset,
  type CrmMasterFilter,
  type CrmMasterMappingStatus,
} from "@/lib/crm/master";
import { streamCrmMasterWorkbookResponse } from "@/lib/crm/master-export-workbook";
import { CRM_SCOPE_ALL } from "@/lib/crm/viewer-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The workbook streams row-by-row (flat memory), but a very large unfiltered export still has to walk
// every page of the mirror — give it generous headroom so it isn't killed mid-stream.
export const maxDuration = 300;

// Streams the CRM master dataset + filters as a premium XLSX download, unpaginated and UNCAPPED, so
// the export always covers the whole on-screen sheet. Super-Admin only, matching the /admin/crm page
// gate. Rows are generated + styled on the server one page at a time (see streamCrmMasterExportPages
// + streamCrmMasterWorkbookResponse), never held in memory all at once — the old path fetched every
// row as JSON then styled it in a single in-memory pass, which OOM'd/timed out past ~20-50k rows.

function exportFileName(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "export";
  return `crm-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

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
  // Forward ALL 13 filters the master table supports so the export matches the on-screen rows exactly
  // (Line / Hire-date / Min-duration / Half-days-only were once dropped, silently exporting a superset).
  const filter: CrmMasterFilter = {
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
  };

  const label = crmMasterExportLabel(filter);
  return streamCrmMasterWorkbookResponse({
    filename: exportFileName(label),
    sheetName: label,
    columns: crmMasterExportColumns(filter),
    // Super-Admin only (gate above), one of exactly two places allowed to construct company scope.
    pages: streamCrmMasterExportPages(filter, CRM_SCOPE_ALL),
  });
}
