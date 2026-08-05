import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildPhoenixTableWorkbook, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import type { CustomerChannel } from "@/lib/sales/customer-channel";
import { loadCustomerDirectoryRows, type CustomerDirectoryFilters } from "@/lib/sales/customer-directory";
import { NextResponse } from "next/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLUMNS: ExportColumn[] = [
  { key: "clientCode", label: "Customer Code", width: 16 },
  { key: "clientName", label: "Customer Name", width: 34 },
  { key: "channel", label: "Channel", width: 12 },
  { key: "matchedKeywords", label: "Matched Word", width: 22 },
  { key: "clientAddress", label: "Address", width: 44 },
  { key: "distributorName", label: "Distributor", width: 18 },
  { key: "brickId", label: "Brick ID", width: 12 },
  { key: "brickName", label: "Brick Name", width: 26 },
  { key: "area", label: "Area", width: 20 },
  { key: "region", label: "Region", width: 16 },
  { key: "totalUnits", label: "Units", numeric: true, width: 12 },
  { key: "totalValue", label: "Value (EGP)", numeric: true, width: 16 },
];

// Exhaustive by construction: adding a channel to CustomerChannel breaks the build here rather
// than silently exporting every hospital as a pharmacy.
const CHANNEL_ROW_LABEL: Record<CustomerChannel, string> = {
  hospital: "Hospital",
  pharmacy: "Pharmacy",
  store: "Store",
};

const CHANNEL_SCOPE_LABEL: Record<CustomerChannel, string> = {
  hospital: "Hospitals only",
  pharmacy: "Pharmacies only",
  store: "Stores only",
};

function scopeLabel(filters: CustomerDirectoryFilters) {
  const parts: string[] = [];
  if (filters.fromPeriod || filters.toPeriod) {
    parts.push(`Period ${filters.fromPeriod || "start"} → ${filters.toPeriod || "latest"}`);
  } else {
    parts.push("All time");
  }
  if (filters.distributorCodes?.length) parts.push(`${filters.distributorCodes.length} distributor(s)`);
  if (filters.regionCodes?.length) parts.push(`${filters.regionCodes.length} region(s)`);
  if (filters.areaCodes?.length) parts.push(`${filters.areaCodes.length} area(s)`);
  if (filters.brickCodes?.length) parts.push(`${filters.brickCodes.length} brick(s)`);
  if (filters.search?.trim()) parts.push(`search "${filters.search.trim()}"`);
  if (filters.channel) parts.push(CHANNEL_SCOPE_LABEL[filters.channel]);
  return parts.join("  ·  ");
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Mirrors the page gate (app/(admin)/sales/customer-directory/page.tsx) -- Super Admin and
    // SFE Manager both reach the workspace, so both must be able to export what it shows them.
    if (access.role !== "Super Admin" && access.role !== "SFE Manager" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Customer Directory export is restricted to Super Admin and SFE Manager." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "export");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:sales:customer-directory" });

    const body = (await request.json().catch(() => ({}))) as CustomerDirectoryFilters;
    const filters: CustomerDirectoryFilters = {
      areaCodes: Array.isArray(body.areaCodes) ? body.areaCodes : [],
      brickCodes: Array.isArray(body.brickCodes) ? body.brickCodes : [],
      channel:
        body.channel === "hospital" || body.channel === "pharmacy" || body.channel === "store"
          ? body.channel
          : null,
      distributorCodes: Array.isArray(body.distributorCodes) ? body.distributorCodes : [],
      fromPeriod: typeof body.fromPeriod === "string" ? body.fromPeriod : null,
      regionCodes: Array.isArray(body.regionCodes) ? body.regionCodes : [],
      search: typeof body.search === "string" ? body.search : "",
      toPeriod: typeof body.toPeriod === "string" ? body.toPeriod : null,
    };

    const rows = await loadCustomerDirectoryRows(filters, access.role);
    const exportRows: ExportRow[] = rows.map((row) => ({
      area: row.areaName,
      brickId: row.brickId,
      brickName: row.brickName,
      channel: CHANNEL_ROW_LABEL[row.channel],
      clientAddress: row.clientAddress,
      clientCode: row.clientCode,
      clientName: row.clientName,
      distributorName: row.distributorName,
      matchedKeywords: row.matchedKeywords.join(" + "),
      region: row.regionName,
      totalUnits: Number(row.totalUnits.toFixed(0)),
      totalValue: Number(row.totalValue.toFixed(2)),
    }));

    const buffer = await buildPhoenixTableWorkbook({
      columns: COLUMNS,
      rows: exportRows,
      sheetName: "Customer Directory",
      subtitle: `Customer Directory  ·  ${scopeLabel(filters)}  ·  ${exportRows.length} customers  ·  Values in EGP`,
      title: "Phoenix Workforce — Customer Directory",
    });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-customer-directory.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to export Customer Directory." },
      { status: 500 },
    );
  }
}
