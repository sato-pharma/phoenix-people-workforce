import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import {
  crmMasterExportColumnsFor,
  crmMasterExportLabel,
  streamCrmMasterExportPages,
  type CrmMasterAmpm,
  type CrmMasterDataset,
  type CrmMasterFilter,
  type CrmMasterMappingStatus,
} from "@/lib/crm/master";
import { phoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import { streamCrmMasterWorkbookResponse } from "@/lib/crm/master-export-workbook";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { CRM_SCOPE_ALL } from "@/lib/crm/viewer-scope";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

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

// The first replace collapses every run of other characters to ONE dash, so a single-dash trim at each
// end is exact — and, unlike `-+$`, it cannot backtrack across a long run of dashes.
function exportFileName(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "export";
  return `crm-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: NextRequest) {
  const access = await resolveAccessContext(request);
  if (!access.loginId && !access.hrId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!canUseAdminCrmWorkspace(access)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const minDurationRaw = params.get("minDuration");
  const minDuration = minDurationRaw != null && Number.isFinite(Number(minDurationRaw)) ? Number(minDurationRaw) : null;
  // Forward ALL 13 filters the master table supports so the export matches the on-screen rows exactly
  // (Line / Hire-date / Min-duration / Half-days-only were once dropped, silently exporting a superset).
  // Golden rule #1's tier for this reader, resolved ONCE and used for both the sheet's header and
  // its cells. A rep's own row is blinded inside the shaper, per row.
  const viewer = phoenixDetailViewer(access.role, access.hrId);

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

  // Forensic record for the single most sensitive export in the app: this streams the ENTIRE
  // company CRM mirror (every rep's field movements, customers, comments, and GPS coordinates on
  // the check-ins dataset) and previously wrote no audit row at all. Logged before streaming since
  // the row count isn't known until the stream completes.
  await writeAuditLog({
    actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
    entityId: `${filter.dataset ?? "visits"}:${filter.dateFrom ?? "all"}:${filter.dateTo ?? "all"}`,
    entityType: "crm_master_export",
    newValues: {
      dataset: filter.dataset ?? "visits",
      dateFrom: filter.dateFrom,
      dateTo: filter.dateTo,
      role: access.role,
      scope: "company-wide",
      search: filter.search,
      surface: "admin",
    },
    summary: "CRM master data exported company-wide from the admin console.",
  });

  return streamCrmMasterWorkbookResponse({
    cover: {
      rows: [
        ["Dataset", filter.dataset ?? "visits"],
        ["Date from", filter.dateFrom || "—"],
        ["Date to", filter.dateTo || "—"],
        ["Search", filter.search || "—"],
        ["Scope", "Company-wide (Super Admin)"],
        // Cairo wall-clock, matching the portal twin — the house rule for every report the owner reads.
        ["Generated", `${cairoDateTimeSortable(new Date().toISOString())} Cairo`],
        [
          "Row count",
          "Not stated here on purpose: the rows are streamed, so none have been read when this page is written. The Visits sheet is the count.",
        ],
        [
          "Confidential",
          "Individual visit-level CRM activity. Internal use only — do not forward outside the organization.",
        ],
      ],
      subtitle: label,
      title: "CRM Master Export",
    },
    filename: exportFileName(label),
    sheetName: label,
    // ONE viewer for the header and the rows, so the sheet's shape and its cells can never disagree.
    columns: crmMasterExportColumnsFor(filter, viewer),
    // Super-Admin only (gate above), one of exactly two places allowed to construct company scope.
    pages: streamCrmMasterExportPages(filter, CRM_SCOPE_ALL, viewer),
  });
}
