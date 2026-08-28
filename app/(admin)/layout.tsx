import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { AppShell } from "@/components/layout/app-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode, usesHrNamespace } from "@/lib/auth/permissions";
import { PATH_HEADER, SHELL_HEADER, toHrNamespacePath } from "@/lib/navigation/shell-headers";

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

  // ── The /hr namespace ──────────────────────────────────────────────────────
  // An HR seat that arrives on a BARE admin address is sent to the same page under /hr. Every
  // page either seat can open lives in this route group (measured: all 36 of them), so this one
  // redirect is the whole mechanism — it catches the ~827 notification links already sitting on
  // people's phones, every bookmark, and every in-page `<Link href="/admin/…">` written before
  // the namespace existed. Nothing else in the app has to learn about the prefix.
  //
  // The reverse is deliberately NOT enforced: a non-HR role opening an /hr address gets the HR
  // chrome rather than a bounce, so the owner can inspect exactly what these seats see. That is
  // safe because the shell is chrome — every page behind it re-asserts its own grant.
  const requestHeaders = await headers();
  if (requestHeaders.get(SHELL_HEADER) !== "hr" && usesHrNamespace(access.role)) {
    // Written by middleware on every matched request. Absent only if middleware did not run, in
    // which case there is no path to redirect TO — fall through to the admin shell rather than
    // guess, because a guessed target here is how a redirect loop starts.
    const requestedPath = requestHeaders.get(PATH_HEADER);
    if (requestedPath) {
      redirect(toHrNamespacePath(requestedPath));
    }
  }

  return (
    <>
      <AppShell accessContext={access} navigationMode="admin">
              {children}
      </AppShell>
    </>
  );
}
