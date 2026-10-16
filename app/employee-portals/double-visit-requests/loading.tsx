import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

/**
 * `table`: the page is a head count over a list of request cards, each with its people beneath it — rows
 * after a hero, which is what the table skeleton draws.
 */
export default function DoubleVisitRequestsLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
