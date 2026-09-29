// This route is a REAL page — it renders PayrollPayslipsSection, the list of the employee's own
// payslip months. It fronted itself with `RedirectSkeleton`, a centred spinner whose whole meaning
// is "you are being sent somewhere else": the reader watched a redirect start, and then a list
// arrived instead. A skeleton of the WRONG shape is worse than none, because the page appears to
// settle and then relays out underneath the eye. `table` is the list it actually draws.
import { PortalRouteSkeleton } from "@/components/employee-portal/skeleton-templates";

export default function PayslipsLoading() {
  return <PortalRouteSkeleton shape="table" />;
}
