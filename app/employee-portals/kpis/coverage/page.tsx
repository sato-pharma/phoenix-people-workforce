// Coverage — how much of the planned doctor list has been reached, with every doctor listed.
// The portal KPIs report of that name (owner, 2026-10-14); the body is shared with Frequency and Call Rate.
import { PortalKpiReportPage } from "@/components/crm/portal-kpi-report-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function PortalKpiCoveragePage({ searchParams }: PageProps) {
  return <PortalKpiReportPage report="coverage" searchParams={searchParams} />;
}
