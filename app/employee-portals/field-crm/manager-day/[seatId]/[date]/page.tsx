import { notFound, redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { ManagerDayView } from "@/components/phoenix-crm/manager-day-view";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { loadPhoenixCrmManagerDayPage } from "@/lib/phoenix-crm/server/manager-day-detail";
import { PHOENIX_CRM_PORTAL_PATH } from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phoenix CRM — one MANAGER'S day, in full, on its own address (owner, 2026-10-20).
 *
 * A manager's row on the team calendar used to print a count and open nothing. It now opens here, in a new tab,
 * exactly as a rep's day does — and this page is a leaf: nothing on it navigates.
 *
 * 🔴 WHO MAY OPEN IT IS DECIDED IN THE LOADER, not by a rule here: `loadPhoenixCrmManagerDayPage` asks the
 * `phoenix_crm` read permission first and then resolves the manager through `managersInScope` — the very list
 * the calendar draws its manager rows from — so a link can never open a manager the grid did not show.
 * 🔴 It is a sibling of `day/[seatId]/[date]`, never inside it: that route reads a rep's territory by seat, and
 * a manager's seat is no territory.
 */
export default async function PhoenixCrmManagerDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ seatId: string; date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date, seatId } = await params;
  // An address that is not a Cairo calendar day is nothing this app ever produced.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");

  const query = await searchParams;
  const load = await loadPhoenixCrmManagerDayPage(access, {
    date,
    seatId: decodeURIComponent(seatId),
    test: query.test === "1" || query.test === "true",
  });

  if (load.kind === "ready") {
    return (
      <EmployeePortalPageShell badge="CRM" description="Phoenix CRM · the manager's day in full" title="The manager's day in full">
        <ManagerDayView view={load.view} />
      </EmployeePortalPageShell>
    );
  }

  if (load.kind === "failed") {
    logPortalFailure(
      { hrId: access.hrId, module: "phoenix-crm", role: access.role, route: `${PHOENIX_CRM_PORTAL_PATH}/manager-day` },
      load.error,
    );
  }

  return (
    <EmployeePortalPageShell badge="CRM" title="The manager's day in full">
      <CrmPanel>
        {load.kind === "failed" ? (
          <CrmEmpty
            message="This is a load failure, not an empty day. Reload the page in a minute."
            title="Phoenix CRM could not load this day"
          />
        ) : (
          <CrmEmpty message={load.message} title="This day is not yours to open" />
        )}
      </CrmPanel>
    </EmployeePortalPageShell>
  );
}
