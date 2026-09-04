import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveDocumentTitle } from "@/lib/navigation/module-title";
import { PATH_HEADER } from "@/lib/navigation/shell-headers";

// Names the browser tab after the module being opened, on the FIRST paint. Until 2026-09-04
// the portal named nothing at all — every one of its 118 routes rendered the bare brand, so
// a row of open portal tabs was 118 ways of reading "Phoenix Workforce". The address comes
// from proxy.ts; absent (a request the proxy matcher skipped) resolves to the brand alone,
// which is exactly what every page showed before. `DocumentTitleSync` in the server shell
// renames the tab thereafter on client navigation, through this same resolver.
export async function generateMetadata(): Promise<Metadata> {
  const requestedPath = (await headers()).get(PATH_HEADER) ?? "";
  // Request-cached, so this shares the layout's own resolution below rather than repeating it.
  const access = await resolveAccessContextFromPage();
  return { title: resolveDocumentTitle(requestedPath, "employee-portal", access.role) };
}

export default async function EmployeePortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  return (
    <>
      <EmployeePortalServerShell access={access}>
              {children}
      </EmployeePortalServerShell>
    </>
  );
}
