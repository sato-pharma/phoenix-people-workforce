import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { PORTAL_HOME, resolvePortalTwin } from "@/lib/navigation/portal-twins";
import { PATH_HEADER } from "@/lib/navigation/shell-headers";

// Route-group layout for the admin surface. Rendering AppShell here (instead of in
// every page) keeps the sidebar/topbar mounted across navigation — no remount
// flash, scroll position preserved, and the access context / permission matrix
// resolved once per shell rather than once per page. The `(admin)` group does NOT
// affect URLs. Dual-mode / full-width / public routes (payslips, offers) intentionally
// stay outside this group and keep their own per-page shell handling. The organogram
// lives INSIDE this group and uses the group AppShell.
//
// leave-management was named above as being outside the group until 2026-08-30. It is
// NOT — app/(admin)/leave-management/ is inside it, with no nested layout to override
// the redirect below. That mattered: both pages there carried an EmployeePortalPageShell
// branch for portal-mode viewers that could never run, because this layout sends those
// viewers to /employee-portals first. The branches are gone; the note is corrected here
// so the next reader does not re-derive the same wrong picture from this comment.
//
// This redirect sent EVERY portal-mode viewer to the portal home until 2026-08-30, which
// silently killed the 41 pages in this group that name the exact portal page such a viewer
// belongs on: the page could not run, so its own forward could not fire. A viewer opening a
// shared /admin/approvals/plan/<id> link landed on the portal home with no idea which
// record they had been sent. The comment here used to call that a known rough edge on the
// grounds that fixing it "needs a route map every admin-group page would have to be kept in
// step with" — half right. It does need the map, which is now
// src/lib/navigation/portal-twins.ts; what it does NOT need is manual upkeep, because
// tests/portal-twin-forwarding.test.ts re-derives the map from the pages themselves and
// goes red when they disagree.
export default async function AdminGroupLayout({ children }: { children: ReactNode }) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  // Portal-mode users must never land in the admin shell. Where they land instead is the
  // portal twin of what they actually asked for, when a page names one — the address comes
  // from proxy.ts, which deletes any inbound copy of this header before writing its own, so
  // it cannot be forged. Absent (a request the proxy matcher skips) or unmapped both fall
  // back to the portal home, which is what every one of these viewers got before.
  //
  // Nothing here grants anything: every twin is inside /employee-portals, which is outside
  // this route group, and that page re-asserts its own access exactly as it does when the
  // portal sidebar links it.
  if (resolveNavigationMode(access) === "employee-portal") {
    const requestedPath = (await headers()).get(PATH_HEADER);
    redirect(resolvePortalTwin(requestedPath, access.role) ?? PORTAL_HOME);
  }

  return (
    <>
      <AppShell accessContext={access} navigationMode="admin">
              {children}
      </AppShell>
    </>
  );
}
