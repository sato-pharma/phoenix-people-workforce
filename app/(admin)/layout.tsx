import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";

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
// The redirect below is deliberately to the portal HOME, not to the portal twin of the
// requested page. A portal viewer who follows a shared /leave-management/... link
// therefore loses their destination. That is a known rough edge, not an oversight —
// making it destination-preserving needs a route map every admin-group page would have
// to be kept in step with, and their own sidebar never links here.
export default async function AdminGroupLayout({ children }: { children: ReactNode }) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  // Portal-mode users must never land in the admin shell.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  return (
    <>
      <AppShell accessContext={access} navigationMode="admin">
              {children}
      </AppShell>
    </>
  );
}
