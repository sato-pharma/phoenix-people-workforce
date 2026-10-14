// Call Rate — Total, AM and PM. The per-rep visits page it links to is the sibling [rep] route.
// The portal KPIs report of that name (owner, 2026-10-14); the body is shared with Coverage and Frequency.
import { PortalKpiReportPage } from "@/components/crm/portal-kpi-report-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function PortalKpiCallRatePage({ searchParams }: PageProps) {
  return <PortalKpiReportPage report="call-rate" searchParams={searchParams} />;
}
