import { notFound, redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DayDetailView } from "@/components/phoenix-crm/day-detail-view";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { PHOENIX_CRM_ADMIN_PATH } from "@/lib/phoenix-crm/server/page";
import { loadPhoenixCrmDayPage } from "@/lib/phoenix-crm/server/day-detail";

import { DayRouteMap } from "../../../_components/day-route-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HERO_ICON = <CalendarDays className="h-3.5 w-3.5" />;

/**
 * Phoenix CRM — one rep's day in full, in the ADMIN shell (owner, 2026-10-24: a square on the admin team calendar
 * "redirects me to an employee portal"; he chose "Admin tab plus a map").
 *
 * The admin twin of `app/employee-portals/field-crm/day/[seatId]/[date]`: the same loader, the same gate and the
 * same `DayDetailView`, drawn under the admin surface (so its dropdowns are the admin's combo boxes) with the day's
 * route map above it. Who may open it is still decided in `loadPhoenixCrmDayPage`; who sees the map is decided in
 * `loadDayRoute`. A portal-mode viewer never renders here — the (admin) layout forwards them to the portal twin.
 */
export default async function AdminPhoenixCrmDayPage({
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
  if (resolveNavigationMode(access) === "employee-portal") redirect(`/employee-portals/field-crm/day/${seatId}/${date}`);

  const query = await searchParams;
  const load = await loadPhoenixCrmDayPage(
    access,
    { date, seatId: decodeURIComponent(seatId), test: query.test === "1" || query.test === "true" },
    { withRoute: true },
  );

  if (load.kind === "failed") {
    logError("Phoenix CRM admin day page failed to load", {
      error: load.error,
      labels: { event: "phoenix_crm_admin_day_failed", route: `${PHOENIX_CRM_ADMIN_PATH}/day` },
    });
  }

  return (
    <div className="space-y-5">
      <AdminPageHero description="Phoenix CRM · the day in full" eyebrow="CRM" icon={HERO_ICON} title="The day in full" />
      {load.kind === "ready" ? (
        <CrmSurfaceProvider surface="admin">
          <div className="space-y-5">
            <DayRouteMap route={load.route} routeUnread={load.routeUnread} />
            <DayDetailView view={load.view} />
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
