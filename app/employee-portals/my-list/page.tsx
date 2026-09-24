// My List is RETIRED — its board now lives in Phoenix CRM's List tab (owner, 2026-09-25: "hide the
// my-list board"). This route no longer renders a board of its own; it forwards to the CRM list,
// the board's new home, so a saved bookmark or a stale link still lands on the live board.
//
// THE GATE STAYS. The page still enforces exactly the permission its nav registry entry mirrors —
// crm_visits:read — so the sidebar/bottom-nav permission guard (tests/employee-portal-nav-permission-
// matches-page.test.ts) keeps one truth in one place. A seat without CRM access gets the same
// refusal it always did; a rep who holds it is forwarded on.
//
// THE TWO DOORS STILL CROSS. A manager who lands here is sent to Reps List, their own reach onto the
// same board, exactly as before. Everyone else the gate admits is forwarded to the CRM list.
//
// The board's data loader, view component and scope resolver are left intact and dormant in
// src/lib/crm — un-hiding is restoring the render here and flipping showMyListTab back in navigation.ts.
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
