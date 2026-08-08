// Doctor Coverage & Frequency — READ-ONLY board inside the Phoenix admin shell. In practice this
// serves SFE Manager, Super Admin and CEO: the portal-mode roles (NSM, RM, DM, Medical Rep, PM,
// GPM, MM) are redirected to /employee-portals by app/(admin)/layout.tsx before this page's gate
// could ever run, so they reach the identical board through the portal twin at
// app/employee-portals/doctor-coverage. Month switch is a URL search param so every switch re-runs
// the gate server-side (same posture as the S1 Business Review admin page).
//
// The role list is NOT maintained here. Both twins ask src/lib/crm/doctor-coverage-scope.ts, so
// they cannot drift apart on who may see whose reps — the failure this replaced, where this page
// and the portal page each kept their own hardcoded set and neither scoped the DATA at all.
import { redirect } from "next/navigation";

import { DoctorCoverageBoard } from "@/components/crm/doctor-coverage-board";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getSfeDoctorCoverage, resolveCoverageMonth } from "@/lib/crm/sfe-doctor-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<{ month?: string }> };

export default async function DoctorCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const scope = await getDoctorCoverageScope(access);
  // No access resolves to a redirect rather than an explanation: inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (scope.kind === "none") redirect("/admin");

  const month = resolveCoverageMonth((await searchParams)?.month);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). Same rose fallback posture as the SFE command center — a data failure
  // renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getSfeDoctorCoverage>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getSfeDoctorCoverage({ month, scope });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Doctor coverage data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Doctor coverage could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DoctorCoverageBoard board={board} monthBasePath="/admin/doctor-coverage" />
    </div>
  );
}
