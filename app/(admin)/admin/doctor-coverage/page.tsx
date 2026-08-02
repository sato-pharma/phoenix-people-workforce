// Doctor Coverage & Frequency — READ-ONLY board inside the Phoenix admin shell. Visible to
// SFE Manager and Super Admin. National Sales Manager is deliberately NOT listed here: NSM is a
// portal-mode role, and app/(admin)/layout.tsx redirects every portal-mode viewer to
// /employee-portals before this page's gate could ever run — the NSM surface is the portal twin at
// app/employee-portals/doctor-coverage. Month switch is a URL search param so every switch re-runs
// the role gate server-side (same posture as the S1 Business Review admin page).
import { redirect } from "next/navigation";

import { DoctorCoverageBoard } from "@/components/crm/doctor-coverage-board";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSfeDoctorCoverage, resolveCoverageMonth } from "@/lib/crm/sfe-doctor-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["SFE Manager", "Super Admin"]);

type PageProps = { searchParams?: Promise<{ month?: string }> };

export default async function DoctorCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (!ALLOWED_ROLES.has(access.role)) redirect("/admin");

  const month = resolveCoverageMonth((await searchParams)?.month);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). Same rose fallback posture as the SFE command center — a data failure
  // renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getSfeDoctorCoverage>> | null = null;
  let loadError: string | null = null;
  try {
    board = await getSfeDoctorCoverage({ month });
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
