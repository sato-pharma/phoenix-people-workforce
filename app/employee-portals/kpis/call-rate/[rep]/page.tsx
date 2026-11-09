// One rep's visits behind his row on the portal's KPIs Call Rate tab.
//
// It was /employee-portals/reps-plans/[rep], then /employee-portals/reps-list/call-rate/[rep]. The
// owner took the call rate off Reps List on 2026-09-21 because KPIs already carries it, and chose
// "Open it from KPIs" for this page; both old addresses forward here. The portal twin of
// /admin/kpis/call-rate/[rep], and the same body: src/components/crm/rep-visits-page.tsx renders both,
// so the two shells cannot drift on what a visit means or on whose reps a viewer may open. Only the
// gate's wording and the chrome differ.
//
// A DRILL-DOWN IS ITS OWN REQUEST. It re-runs the KPIs gates rather than trusting the board that
// linked here, and the body re-resolves the viewer's scope before looking the clicked key up — so a
// district manager who edits the URL to another manager's rep gets the same "nobody by that key"
// notice as a month with no field work, and a medical rep reaches only his own visits. That answer is
// deliberately identical for both causes: distinguishing them would make the page an oracle for whose
// rep a key belongs to.
import { redirect } from "next/navigation";

import { BackToPreviousPage } from "@/components/crm/back-to-previous-page";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PortalEmptyState, PortalSection } from "@/components/employee-portal/portal-primitives";
import { RepVisitsPageBody, type RepVisitsPageQuery } from "@/components/crm/rep-visits-page";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSeeDoctorCoverage } from "@/lib/crm/doctor-coverage-roles";
import { PORTAL_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ rep: string }>;
  searchParams?: Promise<RepVisitsPageQuery>;
};

export default async function PortalKpiRepVisitsPage({ params, searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") redirect("/overview");

  // The KPIs page's own gate and its own sentence — this page is a row of that board, opened. Said
  // inside the portal shell, under the same header the page would have carried.
  if (!canSeeDoctorCoverage(access.role) || !(await canAccess(access, "crm_visits", "read"))) {
    return (
      <EmployeePortalPageShell badge="CRM" title="KPIs">
        <PortalSection>
          <PortalEmptyState
            message="KPIs is available to field seats with CRM access — it shows the call rate, coverage and frequency of the reps in your reach, and a medical rep's own three measures."
            title="KPIs Unavailable"
          />
        </PortalSection>
      </EmployeePortalPageShell>
    );
  }

  const { rep: repParam } = await params;
  const query = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every call this rep recorded in the window the board was read on, classified by the same rule the rate uses."
      title="KPIs"
    >
      {/* "Back" to the page the rep was pressed on (owner, 2026-11-09). */}
      <BackToPreviousPage fallbackHref={PORTAL_KPIS_PATH} />
      <RepVisitsPageBody access={access} basePath={PORTAL_KPIS_PATH} query={query} repParam={repParam} surface="portal" />
    </EmployeePortalPageShell>
  );
}
