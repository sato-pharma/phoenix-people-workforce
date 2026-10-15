import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

/**
 * `table`: the page is a picker and a set of field buttons over a dashboard, a map and a list of visits
 * as rows — a hero, one card band and then rows is the closest of the six shapes, and it never draws
 * the chart blocks of `dashboard` before the picker is even there.
 */
export default function TeamVisitReportLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
