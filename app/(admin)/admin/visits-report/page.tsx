import { redirect } from "next/navigation";

import { VisitsReportWorkspace } from "@/components/visits-report/visits-report-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getUnmappedCrmIdentities, getVisitsReportData } from "@/lib/visits-report/service";
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

export default async function VisitsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Company-wide raw CRM mirror — gated to Super Admin, same as the Data Integrity report.
  if (access.role !== "Super Admin") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const tab = params.tab === "unmapped" ? "unmapped" : "log";
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
    // Only pulled when the Unmapped Agents tab is active — it scans the full unmapped
    // history (not date-scoped), so it's skipped on every other page load to keep the
    // default Visit Log view fast.
    tab === "unmapped" ? getUnmappedCrmIdentities() : Promise.resolve([]),
  ]);

  // VisitsReportWorkspace's filter inputs are seeded from `initialFilters`/`data.dateFrom`/
  // `data.dateTo` via useState — but a client-side navigation to a new URL (e.g. the Unmapped
  // Agents tab's "View in Visit Log" jump) re-renders the SAME component instance with new
  // props rather than remounting it, so those useState initializers wouldn't fire again and the
  // input fields would keep showing stale values even though the underlying data is correct.
  // Keying on every URL-derived input forces a clean remount whenever any of them change.
  const workspaceKey = `${tab}:${data.dateFrom}:${data.dateTo}:${data.page}:${JSON.stringify(initialFilters)}`;

  return (
    <VisitsReportWorkspace
      key={workspaceKey}
      data={data}
      tab={tab}
      unmappedIdentities={unmappedIdentities}
      initialFilters={initialFilters}
    />
  );
}
