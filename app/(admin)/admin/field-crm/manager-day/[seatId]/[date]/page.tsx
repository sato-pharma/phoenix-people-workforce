import { notFound, redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ManagerDayView } from "@/components/phoenix-crm/manager-day-view";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { loadPhoenixCrmManagerDayPage } from "@/lib/phoenix-crm/server/manager-day-detail";
import { PHOENIX_CRM_ADMIN_PATH } from "@/lib/phoenix-crm/server/page";

import { DayRouteMap } from "../../../_components/day-route-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HERO_ICON = <CalendarDays className="h-3.5 w-3.5" />;

/**
 * Phoenix CRM — one MANAGER'S day in full, in the ADMIN shell (owner, 2026-10-24: "Admin tab plus a map").
 *
 * The admin twin of `app/employee-portals/field-crm/manager-day/[seatId]/[date]`: the same loader and gate
 * (`managersInScope`, the list the calendar draws its manager rows from), the same `ManagerDayView`, under the admin
 * surface, with the day's route map above it — his own single visits and the visits he rode with a rep. Who sees
 * the map is decided in `loadDayRoute`.
 */
export default async function AdminPhoenixCrmManagerDayPage({
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
  // The admin layout already sends a portal viewer to this twin; the literal path is what
  // tests/portal-twin-forwarding.test.ts reads to keep that table honest.
  if (resolveNavigationMode(access) === "employee-portal") redirect(`/employee-portals/field-crm/manager-day/${seatId}/${date}`);

  const query = await searchParams;
  const load = await loadPhoenixCrmManagerDayPage(
    access,
    { date, seatId: decodeURIComponent(seatId), test: query.test === "1" || query.test === "true" },
    { withRoute: true },
  );

  if (load.kind === "failed") {
    logError("Phoenix CRM admin manager day page failed to load", {
      error: load.error,
      labels: { event: "phoenix_crm_admin_manager_day_failed", route: `${PHOENIX_CRM_ADMIN_PATH}/manager-day` },
    });
  }

  return (
    <div className="space-y-5">
      <AdminPageHero description="Phoenix CRM · the manager's day in full" eyebrow="CRM" icon={HERO_ICON} title="The manager's day in full" />
      {load.kind === "ready" ? (
        <CrmSurfaceProvider surface="admin">
          <div className="space-y-5">
            <DayRouteMap route={load.route} routeUnread={load.routeUnread} />
            <ManagerDayView view={load.view} />
          </div>
        </CrmSurfaceProvider>
      ) : (
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
      )}
    </div>
  );
}
