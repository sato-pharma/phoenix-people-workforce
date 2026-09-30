import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

// Every portal route carries its own loading state (pinned by the portal route-skeleton test), and a
// module page is a route of its own now that the modules are split — the parent's loading.tsx does not
// reach a dynamic child. The same shape as the chooser's: this is the same door.
export default function FieldCrmModuleLoading() {
  return <PortalRouteSkeleton shape="dashboard" />;
}
