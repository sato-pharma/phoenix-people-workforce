import { redirect } from "next/navigation";

import { VisitsReportWorkspace } from "@/components/visits-report/visits-report-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getVisitsReportData } from "@/lib/visits-report/service";

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
  const data = await getVisitsReportData({
    agentHrId: typeof params.agent === "string" ? params.agent : null,
    dateFrom: dateParam(params.dateFrom),
    dateTo: dateParam(params.dateTo),
    page: intParam(params.page, 1),
    pageSize: intParam(params.pageSize, 100),
  });

  return <VisitsReportWorkspace data={data} />;
}
