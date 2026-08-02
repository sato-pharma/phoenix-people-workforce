// Doctor Coverage & Frequency — employee-portal twin of /admin/doctor-coverage, serving the
// National Sales Manager (a portal-mode role that can never reach the (admin) shell). Same board
// component, same company-wide dataset.
//
// SCOPE NOTE (owner-visible assumption, 2026-08-02): the NSM sees the company-wide board, same as
// the SFE Manager — there is one NSM per line, and line-scoping this view (filter agent panel by
// the NSM's line via the employee master) is a known follow-up, not built yet.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DoctorCoverageBoard } from "@/components/crm/doctor-coverage-board";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getSfeDoctorCoverage, resolveCoverageMonth } from "@/lib/crm/sfe-doctor-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<{ month?: string }> };

export default async function PortalDoctorCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="CRM Intelligence"
      description="Doctor visit frequency vs coverage norms — covered, under-visited, and lapsed panels per rep."
      title="Doctor Coverage"
    >
      {children}
    </EmployeePortalPageShell>
  );

  if (access.role !== "National Sales Manager") {
    return shell(
      <EmployeePortalEmptyState
        message="Doctor coverage is available to the National Sales Manager here, and to SFE / Super Admin in the admin area."
        title="Not available for your role"
      />,
    );
  }

  const month = resolveCoverageMonth((await searchParams)?.month);

  // Fetch and JSX stay separated (react-hooks/error-boundaries: no JSX inside try/catch).
  let board: Awaited<ReturnType<typeof getSfeDoctorCoverage>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getSfeDoctorCoverage({ month });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Doctor coverage data is unavailable.";
  }

  if (!board) {
    return shell(<EmployeePortalEmptyState message={loadError ?? ""} title="Doctor coverage could not load" />);
  }
  return shell(<DoctorCoverageBoard board={board} monthBasePath="/employee-portals/doctor-coverage" />);
}
