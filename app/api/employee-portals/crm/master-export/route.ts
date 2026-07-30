import { NextResponse, type NextRequest } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
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
import { isPortalCrmRole, resolvePortalCrmScope } from "@/lib/crm/portal-crm-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Streams row-by-row (flat memory) like the admin export — a scoped export is strictly SMALLER than
// the company-wide one, so the memory/time envelope only improves. Generous headroom regardless.
export const maxDuration = 300;

// Portal-scoped twin of /api/admin/crm/master-export. Same streaming build (streamCrmMasterExportPages
// -> streamCrmMasterWorkbookResponse, never buffered), but every row is bounded to the caller's own
// scope resolved server-side (Medical Rep = self, DSM = district, RM = region subtree, NSM = line
// subtree). The admin route stays Super-Admin-only and untouched — zero blast radius on the recently
// hardened company-wide export.

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
  if (!isPortalCrmRole(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await assertPermission(access, "crm_visits", "read");

  // Resolve the row bound ONCE, before streaming. An empty scope yields a VALID EMPTY workbook (not a
  // 403): that matches what the grid shows and avoids leaking "you have no team" as a distinct status.
  const scope = await resolvePortalCrmScope(access);

  const params = request.nextUrl.searchParams;
  const minDurationRaw = params.get("minDuration");
  const minDuration = minDurationRaw != null && Number.isFinite(Number(minDurationRaw)) ? Number(minDurationRaw) : null;
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
    pages: streamCrmMasterExportPages(filter, scope),
  });
}
