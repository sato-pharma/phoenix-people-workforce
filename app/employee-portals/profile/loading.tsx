// This route is a REAL page — 345 lines of the employee's own record, headed by the identity card.
// It fronted itself with `RedirectSkeleton`, a centred spinner that says "you are being sent
// somewhere else", so the reader saw a redirect start and then a full profile arrive. `detail` is
// the one record this page draws.
import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function ProfileLoading() {
  return <PortalRouteSkeleton shape="detail" />;
}
