// One rep's visits behind his row on the KPIs Call Rate tab: the actual calls the rate is made of.
//
// It was /admin/reps-plans/[rep], then /admin/reps-list/call-rate/[rep]. The owner took the call rate
// off Reps List on 2026-09-21 because KPIs already carries it, and chose "Open it from KPIs" for this
// page; both old addresses forward here.
//
// THIN GATE ONLY. The body — the organogram-resolved header, the rates, and every classified visit
// below them — lives in src/components/crm/rep-visits-page.tsx, shared verbatim with the portal twin
// at /employee-portals/kpis/call-rate/[rep], because the body rebuilds the board to find the clicked
// row and a copy that drifted would be a copy whose SCOPE drifted.
//
// THE KPIs GATES, re-run here server-side: the KPIs role list, then the permission matrix. A
// drill-down is its own request, and a role that cannot open the board must not reach a rep's visit
// list by typing the URL.
//
// THE VIEWER'S SCOPE IS THE OTHER HALF of that, and it is the half a guessed URL attacks. The body
// resolves the scope itself (getDoctorCoverageScope — the same reach the KPIs board applies) and looks
// the clicked rep up in the NARROWED board, so a key belonging to somebody else's rep finds no row and
// lands on the "nobody by that key" notice.
import { redirect } from "next/navigation";

import { RepVisitsPageBody, type RepVisitsPageQuery } from "@/components/crm/rep-visits-page";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { ADMIN_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<RepVisitsPageQuery>;
};

export default async function KpiRepVisitsPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canSeeDoctorCoverage(access.role)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const { rep: repParam } = await params;
  const query = await searchParams;

  return <RepVisitsPageBody access={access} basePath={ADMIN_KPIS_PATH} query={query} repParam={repParam} />;
}
