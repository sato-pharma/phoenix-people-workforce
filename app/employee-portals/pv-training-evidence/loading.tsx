import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

// `detail`, because the page is one search box over ONE person's record and the sheet they signed.
export default function PvTrainingEvidenceLoading() {
  return <PortalRouteSkeleton shape="detail" />;
}
