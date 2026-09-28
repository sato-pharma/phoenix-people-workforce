import { redirect } from "next/navigation";

// The whole Training Manager section is hidden from the employee portal system-wide (owner,
// 2026-09-29: "hide anything related to training manager and coaching anywhere system wide in employee
// portal"). This layout blocks every /employee-portals/training-manager route (overview, coaching
// dashboard, create-coaching-report, field-coaching and its detail/edit pages) at the direct-URL door;
// the nav links, the catalog entries and the Training-Manager landing redirect are already removed. The
// pages themselves are untouched; delete this file to restore the section. The redirect is gated on a
// boolean const so `return children` stays reachable (see the coaching layout for the full note).
const TRAINING_MANAGER_HIDDEN_IN_PORTAL: boolean = true;

export default function TrainingManagerPortalRouteBlockedLayout({ children }: { children: React.ReactNode }) {
  if (TRAINING_MANAGER_HIDDEN_IN_PORTAL) redirect("/employee-portals");
  return children;
}
