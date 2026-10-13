import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

/**
 * `table`, not `dashboard`, and the choice is the whole point of naming a shape.
 *
 * The page is a band of four compact stat cards over the Place checks board — four sections of place
 * ROWS. `TableSkeleton` draws a hero, one card-row band and then rows, which is that page within a
 * few pixels. `DashboardSkeleton` would draw two 224px chart blocks this page has never had, and a
 * skeleton of the wrong shape is worse than none: it settles, then relays out under the reader.
 */
export default function TeamPlaceChecksLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
