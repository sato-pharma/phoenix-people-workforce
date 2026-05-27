import { redirect } from "next/navigation";

import { ContactHRSupportPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

/* ---------- print stylesheet ---------- */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
@media (prefers-reduced-motion: reduce) {
  .animate-spin, .animate-pulse, .animate-bounce { animation: none !important; }
  *, *::before, *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
`;

export default async function EmployeePortalContactHRSupportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  let data = null;
  try {
    data = await getEmployeePortalShellData(access);
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your profile. Please try again or contact your administrator."
        title="Something Went Wrong"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="HR Support"
      description="Open support tickets and reach your HR team faster with the latest escalation context."
      title="Contact HR Support"
    >
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />
      <div dir="auto">
        <WorkspaceErrorBoundary fallbackTitle="HR Support unavailable">
          <ContactHRSupportPage data={data} />
        </WorkspaceErrorBoundary>
      </div>
    </EmployeePortalPageShell>
  );
}
