// The drill-down behind one row of the Reps List Call rate tab: the actual visits the rate is made of.
//
// It was /admin/reps-plans/[rep] until the owner merged Reps Plans into Reps List on 2026-09-21; that
// address now forwards here.
//
// THIN GATE ONLY. The body — the organogram-resolved header, the two rates, and every classified
// visit below them — lives in src/components/crm/rep-visits-page.tsx, shared verbatim with the
// portal twin at /employee-portals/reps-list/call-rate/[rep], because the body rebuilds the board to
// find the clicked row and a copy that drifted would be a copy whose SCOPE drifted.
//
// SAME ACCESS GATES AS THE TAB, re-run here server-side: the Reps List gate, then the call-rate
// tab's own (the Reps Plans role list), then the permission matrix. A drill-down is its own request,
// and a role that cannot open the tab must not reach a rep's visit list by typing the URL.
//
// THE VIEWER'S SCOPE IS THE OTHER HALF of that, and it is the half a guessed URL attacks. The body
// resolves the scope itself and looks the clicked rep up in the NARROWED board, so a key belonging
// to somebody else's rep finds no row and lands on the "nobody by that key" notice.
import { redirect } from "next/navigation";

import { RepVisitsPageBody, type RepVisitsPageQuery } from "@/components/crm/rep-visits-page";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessDoctorList } from "@/lib/crm/doctor-list-access";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<RepVisitsPageQuery>;
};

export default async function RepVisitsPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canAccessDoctorList(access) || !canAccessRepsPlans(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const { rep: repParam } = await params;
  const query = await searchParams;

  return <RepVisitsPageBody access={access} basePath="/admin/reps-list" query={query} repParam={repParam} />;
}
