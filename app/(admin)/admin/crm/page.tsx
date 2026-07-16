import Link from "next/link";
import { redirect } from "next/navigation";
import { MapPinned, TriangleAlert } from "lucide-react";

import { VisitsReportWorkspace } from "@/components/visits-report/visits-report-workspace";
import { getUnmappedCrmIdentities } from "@/lib/crm/admin";
import { getVisitsReportData } from "@/lib/crm/reads";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoubleVisitRecoveredChains } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitRecoveredChain } from "@/lib/double-visit-analytics/types";
import type { VisitsMappingStatus } from "@/lib/visits-report/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mappingStatuses: readonly VisitsMappingStatus[] = ["agent_unmapped", "double_unmapped", "either_unmapped", "fully_mapped"];

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

function mappingStatusParam(value: string | string[] | undefined): VisitsMappingStatus | null {
  return mappingStatuses.includes(value as VisitsMappingStatus) ? (value as VisitsMappingStatus) : null;
}

// The CRM tab IS the raw CRM (iReports360) mirror — every visit pulled from the CRM, in one
// filterable/exportable table, backed entirely by the CRM module (src/lib/crm/*). These deeper,
// same-data tools stay one click away.
const crmTools = [
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
  // The CRM data mirror is company-wide raw CRM data — Super Admin only, matching every CRM sub-tool.
  if (access.role !== "Super Admin") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const tab = params.tab === "unmapped" ? "unmapped" : params.tab === "recovered" ? "recovered" : "log";
  const initialFilters = {
    agent: stringParam(params.agent) ?? "",
    ampm: stringParam(params.ampm) ?? "",
    mappingStatus: mappingStatusParam(params.mappingStatus) ?? "",
    search: stringParam(params.search) ?? "",
    visitType: stringParam(params.visitType) ?? "",
  };
  const [data, unmappedIdentities] = await Promise.all([
    getVisitsReportData({
      agentName: initialFilters.agent || null,
      ampm: initialFilters.ampm || null,
      dateFrom: dateParam(params.dateFrom),
      dateTo: dateParam(params.dateTo),
      mappingStatus: (initialFilters.mappingStatus || null) as VisitsMappingStatus | null,
      page: intParam(params.page, 1),
      pageSize: intParam(params.pageSize, 100),
      search: initialFilters.search || null,
      visitType: initialFilters.visitType || null,
    }),
    tab === "unmapped" ? getUnmappedCrmIdentities() : Promise.resolve([]),
  ]);

  const recoveredChains: DoubleVisitRecoveredChain[] = tab === "recovered"
    ? await getDoubleVisitRecoveredChains({ access, dateFrom: data.dateFrom, dateTo: data.dateTo })
    : [];

  // Key on every URL-derived input so a client-side tab/filter change cleanly remounts the
  // workspace (its filter inputs seed from props via useState) — same rule as the Visits Report page.
  const workspaceKey = `${tab}:${data.dateFrom}:${data.dateTo}:${data.page}:${JSON.stringify(initialFilters)}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-orange-600">CRM</p>
          <h1 className="text-xl font-bold tracking-[-0.01em] text-slate-950">CRM Data (iReports360)</h1>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Every visit pulled from the CRM — the single mirror all other Phoenix modules read from.
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

      <VisitsReportWorkspace
        key={workspaceKey}
        data={data}
        tab={tab}
        unmappedIdentities={unmappedIdentities}
        recoveredChains={recoveredChains}
        initialFilters={initialFilters}
      />
    </div>
  );
}
