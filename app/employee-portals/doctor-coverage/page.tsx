// Doctor Coverage & Frequency — employee-portal twin of /admin/doctor-coverage.
//
// Who reaches it here, and whose reps they see, is decided entirely by
// src/lib/crm/doctor-coverage-scope.ts — never by a role list in this file. Until 2026-08-08 this
// page hardcoded `access.role !== "National Sales Manager"` and then handed the board a
// company-wide dataset, so the one role allowed in was reading every other line's reps, while the
// District Manager and Medical Rep — the only people who can actually act on a lapsed doctor —
// could not open it at all. Owner decision 2026-08-08: DM sees own reps, Medical Rep own panel,
// RM own region, NSM/PM/GPM their line, MM/SFE/Super Admin company-wide.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DoctorCoverageBoard } from "@/components/crm/doctor-coverage-board";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getSfeDoctorCoverage, resolveCoverageMonth } from "@/lib/crm/sfe-doctor-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filters ride in the URL, like the month, so every change re-runs the server-side access gate
// instead of narrowing a payload already delivered to the browser.
type PageProps = {
  searchParams?: Promise<{
    grade?: string;
    kind?: string;
    month?: string;
    rep?: string;
    search?: string;
    status?: string;
  }>;
};

export default async function PortalDoctorCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const scope = await getDoctorCoverageScope(access);

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="CRM Intelligence"
      description="Doctor visit frequency vs coverage norms — who to see next, and who has lapsed."
      title="Doctor Coverage"
    >
      {children}
    </EmployeePortalPageShell>
  );

  if (scope.kind === "none") {
    return shell(<EmployeePortalEmptyState message={scope.reason} title="Not available for your role" />);
  }

  const params = await searchParams;
  const month = resolveCoverageMonth(params?.month);
  const filters = {
    grade: params?.grade,
    kind: params?.kind,
    repKey: params?.rep,
    search: params?.search,
    status: params?.status,
  };

  // Fetch and JSX stay separated (react-hooks/error-boundaries: no JSX inside try/catch).
  let board: Awaited<ReturnType<typeof getSfeDoctorCoverage>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getSfeDoctorCoverage({ filters, month, scope });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Doctor coverage data is unavailable.";
  }

  if (!board) {
    return shell(<EmployeePortalEmptyState message={loadError ?? ""} title="Doctor coverage could not load" />);
  }
  return shell(<DoctorCoverageBoard board={board} monthBasePath="/employee-portals/doctor-coverage" />);
}
