// The Reps Plans drill-down inside the employee portal — one of a manager's own reps, visit by visit.
//
// The portal twin of /admin/reps-plans/[rep], and the same body: src/components/crm/rep-visits-page.tsx
// renders both, so the two shells cannot drift on what a visit means or on whose reps a viewer may
// open. Only the gate and the chrome differ.
//
// A DRILL-DOWN IS ITS OWN REQUEST. It re-runs the role gate and the permission check rather than
// trusting the board that linked here, and the body re-resolves the viewer's scope before looking
// the clicked key up — so a district manager who edits the URL to another manager's rep gets the
// same "nobody by that key" notice as a month with no field work. That answer is deliberately
// identical for both causes: distinguishing them would make the page an oracle for whose rep a key
// belongs to.
import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepVisitsPageBody, type RepVisitsPageQuery } from "@/components/crm/rep-visits-page";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessRepsPlans } from "@/lib/crm/reps-plans-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<RepVisitsPageQuery>;
};

export default async function PortalRepVisitsPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  if (!canAccessRepsPlans(access) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Reps Plans is available to manager seats with CRM access — it shows the call rate of the reps who report to you, reported twice: what each one recorded, and what the check-ins prove."
        title="Reps Plans Unavailable"
      />
    );
  }

  const { rep: repParam } = await params;
  const query = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every call this rep recorded in the window the board was read on, classified by the same rule the rate uses."
      title="Reps Plans"
    >
      <RepVisitsPageBody
        access={access}
        basePath="/employee-portals/reps-plans"
        query={query}
        repParam={repParam}
      />
    </EmployeePortalPageShell>
  );
}
