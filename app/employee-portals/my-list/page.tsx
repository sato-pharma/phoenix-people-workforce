// My List is RETIRED (owner, 2026-09-25: "hide the my-list board", then "delete the dormant My List
// board code"). Its board and every sidebar surface are gone; the rep's own contact list lives in
// Phoenix CRM's List tab (/employee-portals/field-crm?tab=list), which every rep reaches by its own
// phoenix_crm:read link. This route survives ONLY as a redirect onto it, so a saved bookmark or a
// stale link still lands on the live board rather than a 404.
//
// THE GATE STAYS. The page still enforces crm_visits:read before forwarding, so a seat without CRM
// access gets the same refusal it always did; a rep who holds it is forwarded on.
//
// THE TWO DOORS STILL CROSS. A manager who lands here is sent to Reps List, their own reach onto the
// board, exactly as before. Everyone else the gate admits is forwarded to the CRM list.
//
// The live board's data engine stays in src/lib/crm — it is what the Phoenix CRM List tab loads.
// Only the dormant My List view component and its unused scope resolver were removed.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessDoctorList, canAccessMyList } from "@/lib/crm/doctor-list-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PortalMyListPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // A manager's door onto the same board is Reps List, where their reps are.
  if (canAccessDoctorList(access) && !canAccessMyList(access)) redirect("/employee-portals/reps-list");

  if (!canAccessMyList(access) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="My List is available to medical reps with CRM access — it now lives in Phoenix CRM's List tab."
        title="My List Unavailable"
      />
    );
  }

  // Retired — the rep's own contact list is the Phoenix CRM List tab now.
  redirect("/employee-portals/field-crm?tab=list");
}
