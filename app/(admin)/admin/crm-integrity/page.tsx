import { redirect } from "next/navigation";

import { CrmIntegrityWorkspace } from "@/components/crm-integrity/crm-integrity-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCrmIntegrityData } from "@/lib/crm-integrity/service";

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

export default async function CrmIntegrityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Correlates the same raw CRM mirror the /admin/crm hub reads, plus GPS coordinates -- gated to
  // Super Admin, matching /admin/crm and /admin/double-visit-data-integrity exactly.
  if (access.role !== "Super Admin") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const initialFilters = { agent: stringParam(params.agent) ?? "" };
  const data = await getCrmIntegrityData({
    agentName: initialFilters.agent || null,
    dateFrom: dateParam(params.dateFrom),
    dateTo: dateParam(params.dateTo),
    page: intParam(params.page, 1),
    pageSize: intParam(params.pageSize, 100),
  });

  return <CrmIntegrityWorkspace data={data} initialFilters={initialFilters} />;
}
