import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

/**
 * `table`: the page is a band of counts and filters over one map and a list of customers as rows — a hero,
 * one card band and then rows is the closest of the six shapes.
 */
export default function MyMapLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
