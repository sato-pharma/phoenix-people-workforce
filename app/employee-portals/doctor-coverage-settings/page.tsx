// Doctor Coverage Settings — employee-portal twin of /admin/doctor-coverage-settings.
//
// Product Manager, Group Product Manager and Marketing Manager hold crm_visits:update (owner,
// 2026-08-09) but are PORTAL-MODE roles: app/(admin)/layout.tsx redirects them to /employee-portals
// before an admin page's gate could run, so the admin route is unreachable for them. This is the
// same admin/portal twin split the board itself uses.
//
// The gate is the identical permission the API route asserts. The route is the real boundary — a
// page gate alone protects nothing, since the editor writes through the API.
import { DoctorCoverageNormsEditor } from "@/components/crm/doctor-coverage-norms-editor";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canAccess } from "@/lib/auth/permissions";
import { getDoctorCoverageConfig } from "@/lib/crm/doctor-coverage-config";
import { getDoctorCoverageOverrideOptions } from "@/lib/crm/doctor-coverage-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PortalDoctorCoverageSettingsPage() {
  const access = await resolveAuthenticatedPageAccess();

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="CRM Intelligence"
      description="Visits required per month, by grade — set separately for doctors and for pharmacies, hospitals and contract accounts."
      title="Doctor Coverage Settings"
    >
      {children}
    </EmployeePortalPageShell>
  );

  if (!(await canAccess(access, "crm_visits", "update"))) {
    return shell(
      <EmployeePortalEmptyState
        message="Changing the coverage norms is limited to Super Admin, SFE Manager, and the Product, Group Product and Marketing Managers."
        title="Not available for your role"
      />,
    );
  }

  // Options for the line-exception editor: who it can apply to, and the real line names.
  const [config, options] = await Promise.all([getDoctorCoverageConfig(), getDoctorCoverageOverrideOptions()]);
  return shell(
    <div className="p-5">
      <DoctorCoverageNormsEditor candidates={options.candidates} initial={config} lines={options.lines} />
    </div>,
  );
}
