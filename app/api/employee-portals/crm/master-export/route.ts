import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
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
import { isPortalCrmRole, resolvePortalCrmScope } from "@/lib/crm/portal-crm-scope";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

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
  if (!isPortalCrmRole(access.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    // assertPermission THROWS on denial. Uncaught, that surfaced as an unhandled 500 with a stack
    // in the logs instead of a 403, violating the route convention. It never fires today (all four
    // portal CRM roles hold crm_visits:read) but the matrix is runtime-overridable via
    // role_permission_overrides, so revoking that permission would turn this into a 500.
    await assertPermission(access, "crm_visits", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }

  // Resolve the row bound ONCE, before streaming. An empty scope yields a VALID EMPTY workbook (not a
  // 403): that matches what the grid shows and avoids leaking "you have no team" as a distinct status.
  const scope = await resolvePortalCrmScope(access);

  const params = request.nextUrl.searchParams;
  const minDurationRaw = params.get("minDuration");
  const minDuration = minDurationRaw != null && Number.isFinite(Number(minDurationRaw)) ? Number(minDurationRaw) : null;
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

  // Forensic record. This route streams a scoped manager's entire team field-movement history —
  // visit dates/times, customers, comments, and (on the check-ins dataset) GPS coordinates and
  // addresses — and wrote NO audit row. Logged before streaming because the row count is not known
  // until the stream finishes; the point is a record of who exported what, with which filters.
  await writeAuditLog({
    actorLoginId: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
    entityId: `${filter.dataset ?? "visits"}:${filter.dateFrom ?? "all"}:${filter.dateTo ?? "all"}`,
    entityType: "crm_master_export",
    newValues: {
      dataset: filter.dataset ?? "visits",
      dateFrom: filter.dateFrom,
      dateTo: filter.dateTo,
      role: access.role,
      scopeKind: scope.kind,
      search: filter.search,
      surface: "employee-portal",
    },
    summary: "CRM master data exported from the employee portal (scoped to the caller's own team).",
  });

  return streamCrmMasterWorkbookResponse({
    cover: {
      rows: [
        ["Dataset", filter.dataset ?? "visits"],
        ["Date from", filter.dateFrom || "—"],
        ["Date to", filter.dateTo || "—"],
        ["Search", filter.search || "—"],
        ["Scope", "Bounded to your own scope"],
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
    pages: streamCrmMasterExportPages(filter, scope, viewer),
  });
}
