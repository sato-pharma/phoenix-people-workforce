import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

// Every portal route carries its own loading state (pinned by the portal route-skeleton test), and a
// dynamic child is not reached by a parent's loading.tsx. "detail" is the shape here: one person's
// one day, read top to bottom — never the chooser's dashboard.
export default function FieldCrmDayLoading() {
  return <PortalRouteSkeleton shape="detail" />;
}
