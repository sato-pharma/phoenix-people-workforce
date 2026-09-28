import { redirect } from "next/navigation";

// Coaching is hidden from the employee portal system-wide (owner, 2026-09-29: "hide anything related
// to training manager and coaching anywhere system wide in employee portal"). This layout blocks the
// whole /employee-portals/coaching subtree at the direct-URL door — every nav link was already removed
// in resolveEmployeePortalNavVisibility and system-navigation.ts. The coaching pages and the
// admin-shell coaching module are untouched; delete this file to restore the portal route.
//
// The redirect is gated on a boolean const (not an unconditional call) so the `return children`
// below is reachable code — it satisfies the layout's children contract without tripping
// no-unreachable. redirect() throws at runtime, so children never actually renders.
const COACHING_HIDDEN_IN_PORTAL: boolean = true;

export default function CoachingPortalRouteBlockedLayout({ children }: { children: React.ReactNode }) {
  if (COACHING_HIDDEN_IN_PORTAL) redirect("/employee-portals");
  return children;
}
