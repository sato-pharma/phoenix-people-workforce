// Frequency — how often each doctor should be visited and how often they were, one rep at a time.
// The portal KPIs report of that name (owner, 2026-10-14); the body is shared with Coverage and Call Rate.
import { PortalKpiReportPage } from "@/components/crm/portal-kpi-report-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function PortalKpiFrequencyPage({ searchParams }: PageProps) {
  return <PortalKpiReportPage report="frequency" searchParams={searchParams} />;
}
