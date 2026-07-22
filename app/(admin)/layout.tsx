import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { SentryFeedbackWidget } from "@/components/admin/sentry-feedback-widget";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";

// Route-group layout for the admin surface. Rendering AppShell here (instead of in
// every page) keeps the sidebar/topbar mounted across navigation — no remount
// flash, scroll position preserved, and the access context / permission matrix
// resolved once per shell rather than once per page. The `(admin)` group does NOT
// affect URLs. Dual-mode / full-width / public routes (payslips, leave-management,
// offers) intentionally stay outside this group and keep their own per-page shell
// handling. The organogram lives INSIDE this group and uses the group AppShell.
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
      <SentryFeedbackWidget />
    </>
  );
}
