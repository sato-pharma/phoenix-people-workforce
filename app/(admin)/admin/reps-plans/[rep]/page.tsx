// The drill-down behind one row of Reps Plans: the actual visits the rate is made of.
//
// THIN GATE ONLY. The body — the organogram-resolved header, the two rates, and every classified
// visit below them — lives in src/components/crm/rep-visits-page.tsx, shared verbatim with the
// portal twin at /employee-portals/reps-plans/[rep]. It was extracted there on 2026-09-03 rather
// than copied, because the body rebuilds the board to find the clicked row and a copy that drifted
// would be a copy whose SCOPE drifted.
//
// SAME ACCESS GATES AS THE BOARD, re-run here server-side. A drill-down is not a child of the page
// that linked to it — it is its own request, and a role that cannot open Reps Plans must not be able
// to reach a rep's visit list by typing the URL.
//
// THE VIEWER'S SCOPE IS THE OTHER HALF of that, and it is the half a guessed URL attacks. The body
// resolves the scope itself and looks the clicked rep up in the NARROWED board, so a key belonging
// to somebody else's rep finds no row and lands on the "nobody by that key" notice.
import { redirect } from "next/navigation";

import { RepVisitsPageBody, type RepVisitsPageQuery } from "@/components/crm/rep-visits-page";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<RepVisitsPageQuery>;
};

export default async function RepVisitsPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!canAccessRepsPlans(access)) redirect("/admin");
  if (!(await canAccess(access, "crm_visits", "read"))) redirect("/admin");

  const { rep: repParam } = await params;
  const query = await searchParams;

  return <RepVisitsPageBody access={access} basePath="/admin/reps-plans" query={query} repParam={repParam} />;
}
