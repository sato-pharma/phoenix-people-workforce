import { redirect } from "next/navigation";

import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { SentryUserIdentity } from "@/components/layout/sentry-user-identity";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

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
    <EmployeePortalServerShell access={access}>
      <SentryUserIdentity hrId={access.hrId} role={access.role} />
      {children}
    </EmployeePortalServerShell>
  );
}
