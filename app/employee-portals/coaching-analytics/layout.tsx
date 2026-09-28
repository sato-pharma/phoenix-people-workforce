import { redirect } from "next/navigation";

// Coaching Analytics is hidden from the employee portal system-wide (owner, 2026-09-29). This layout
// blocks the direct-URL door; the nav links are already gone (showCoachingAnalyticsTab is false and the
// catalog entry was removed). The page and the admin coaching analytics are untouched; delete this file
// to restore the portal route. The redirect is gated on a boolean const so `return children` stays
// reachable (see the coaching layout for the full note).
const COACHING_HIDDEN_IN_PORTAL: boolean = true;

export default function CoachingAnalyticsPortalRouteBlockedLayout({ children }: { children: React.ReactNode }) {
  if (COACHING_HIDDEN_IN_PORTAL) redirect("/employee-portals");
  return children;
}
