import { FieldWorkforceRouteMap, type RouteMapCopy } from "@/components/field-workforce-compliance/field-workforce-route-map";
import { CrmNote } from "@/components/phoenix-crm/ui";
import type { DayRouteStop } from "@/lib/phoenix-crm/server/day-route";

/**
 * The admin day page's route map — the day's Phoenix CRM visits, numbered in the order they were logged, on the
 * same map Workforce Compliance draws its check-ins on (owner, 2026-10-24: "Admin tab plus a map").
 *
 * 🔴 IT LIVES UNDER `app/(admin)` AND NOWHERE A REP CAN REACH. `route` is null for every reader the loader does
 * not give the raw point to (`loadDayRoute`, the Super Admin and the SFE Manager alone), and null draws NOTHING —
 * not an empty map, which would read as a day spent nowhere.
 */

const VISIT_ROUTE_COPY: RouteMapCopy = {
  title: "Where the visits were logged",
  description:
    "Each stop is one visit, numbered in the order it was logged, at the point the phone read when it was saved. A visit the Super Admin entered later has no location and is not on the map.",
  empty: "No visit on this day carries a location.",
};

export function DayRouteMap({ route, routeUnread }: { route: DayRouteStop[] | null; routeUnread: boolean }) {
  if (routeUnread) {
    return (
      <CrmNote title="The map could not be read" tone="warn">
        The day&apos;s visits below are complete. Reload the page in a minute to draw the map.
      </CrmNote>
    );
  }
  if (!route) return null;
  return <FieldWorkforceRouteMap checkins={route} copy={VISIT_ROUTE_COPY} route={null} />;
}
