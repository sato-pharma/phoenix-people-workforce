import Link from "next/link";
import { redirect } from "next/navigation";
import { FileSpreadsheet, MapPinned, TriangleAlert } from "lucide-react";

import { CrmMasterTable } from "@/components/crm/crm-master-table";
import { getCrmMasterData, type CrmMasterAmpm, type CrmMasterDataset, type CrmMasterMappingStatus } from "@/lib/crm/master";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function dateParam(value: string | string[] | undefined) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function intParam(value: string | string[] | undefined, fallback: number) {
  const parsed = Number(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value : null;
}

// Deeper, same-data tools over the CRM mirror — one click from the master table.
const crmTools = [
  { description: "Curated visit log with GPS-correlation & unmapped-agent tools", href: "/admin/visits-report", icon: FileSpreadsheet, label: "Visits Report" },
  { description: "Visits ↔ GPS check-in correlation, save-lag & impossible-travel flags", href: "/admin/crm-integrity", icon: MapPinned, label: "CRM Integrity" },
  { description: "Data-integrity checks for double-visit records", href: "/admin/double-visit-data-integrity", icon: TriangleAlert, label: "Double Visit Data Integrity" },
] as const;

export default async function CrmHubPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Raw company-wide CRM mirror — Super Admin only, matching every CRM sub-tool.
  if (access.role !== "Super Admin") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  // getCrmMasterData normalizes any unknown value back to "visits".
  const dataset = (typeof params.dataset === "string" ? params.dataset : "visits") as CrmMasterDataset;
  const dateFrom = dateParam(params.dateFrom);
  const dateTo = dateParam(params.dateTo);
  const search = stringParam(params.search);
  const page = intParam(params.page, 1);
  const pageSize = intParam(params.pageSize, 50);
  const agentHrId = stringParam(params.agentHrId);
  const ampm: CrmMasterAmpm | null = params.ampm === "AM" || params.ampm === "PM" ? params.ampm : null;
  const visitType = stringParam(params.visitType);
  const mappingStatus: CrmMasterMappingStatus | null =
    params.mappingStatus === "agent_mapped" || params.mappingStatus === "agent_unmapped" ? params.mappingStatus : null;
  const line = stringParam(params.line);
  const hireFrom = dateParam(params.hireFrom);
  const hireTo = dateParam(params.hireTo);
  const minDuration = typeof params.minDuration === "string" && Number.isFinite(Number(params.minDuration)) ? Number(params.minDuration) : null;
  const halfDaysOnly = params.halfDaysOnly === "1";

  const data = await getCrmMasterData({
    agentHrId,
    ampm,
    dataset,
    dateFrom,
    dateTo,
    halfDaysOnly,
    hireFrom,
    hireTo,
    line,
    mappingStatus,
    minDuration,
    page,
    pageSize,
    search,
    visitType,
  });

  // Remount the client table when any URL-derived input changes so its filter inputs re-seed.
  const tableKey = `${dataset}:${dateFrom}:${dateTo}:${page}:${pageSize}:${search}:${agentHrId}:${ampm}:${visitType}:${mappingStatus}:${line}:${hireFrom}:${hireTo}:${minDuration}:${halfDaysOnly}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-orange-600">CRM</p>
          <h1 className="text-xl font-bold tracking-[-0.01em] text-slate-950">CRM Master Data (iReports360)</h1>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            The exact mirror of the CRM — every visit and check-in pulled, with all columns and each record&apos;s
            full raw payload. The single source every other Phoenix module reads from.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {crmTools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                className="inline-flex items-center gap-2 border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                href={tool.href}
                key={tool.href}
                title={tool.description}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {tool.label}
              </Link>
            );
          })}
        </div>
      </div>

      <CrmMasterTable key={tableKey} data={data} />
    </div>
  );
}
