import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

// `table`, because the planner tab — the one this route opens on — is a controls card above a
// four-column result table, which is the shape TableSkeleton draws. A `form` placeholder would
// promise a stack of fields and then relay out under the reader when the table arrived.
export default function ProductionPlanningLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
