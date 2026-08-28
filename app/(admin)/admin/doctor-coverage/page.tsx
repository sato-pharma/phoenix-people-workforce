// Doctor Coverage & Frequency — READ-ONLY board inside the Phoenix admin shell. In practice this
// serves SFE Manager, Super Admin and CEO: the portal-mode roles (NSM, RM, DM, Medical Rep, PM,
// GPM, MM) are redirected to /employee-portals by app/(admin)/layout.tsx before this page's gate
// could ever run, so they reach the identical board through the portal twin at
// app/employee-portals/doctor-coverage. Month switch is a URL search param so every switch re-runs
// the gate server-side (same posture as the Business Review admin page).
//
// The role list is NOT maintained here. Both twins ask src/lib/crm/doctor-coverage-scope.ts, so
// they cannot drift apart on who may see whose reps — the failure this replaced, where this page
// and the portal page each kept their own hardcoded set and neither scoped the DATA at all.
import { redirect } from "next/navigation";

import { DoctorCoverageBoard } from "@/components/crm/doctor-coverage-board";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  coverageSelectionIsActive,
  pruneCoverageSelection,
  repKeysMatching,
  resolveCoverageSelection,
  restrictCoverageFilterTree,
} from "@/lib/crm/coverage-filters";
import { loadCoverageFilterTree } from "@/lib/crm/coverage-filters-data";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getSfeDoctorCoverage, resolveCoverageMonth } from "@/lib/crm/sfe-doctor-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filters ride in the URL, like the month, so every change re-runs the server-side gate.
type PageProps = {
  searchParams?: Promise<{
    area?: string;
    grade?: string;
    kind?: string;
    line?: string;
    month?: string;
    region?: string;
    rep?: string;
    search?: string;
    status?: string;
  }>;
};

export default async function DoctorCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const scope = await getDoctorCoverageScope(access);
  // No access resolves to a redirect rather than an explanation: inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (scope.kind === "none") redirect("/admin");

  const params = await searchParams;
  const month = resolveCoverageMonth(params?.month);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). Same rose fallback posture as the SFE command center — a data failure
  // renders a plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getSfeDoctorCoverage>> | null = null;
  let tree: Awaited<ReturnType<typeof loadCoverageFilterTree>> | null = null;
  let territory = resolveCoverageSelection({
    area: params?.area,
    line: params?.line,
    region: params?.region,
    rep: params?.rep,
  });
  let loadError: string | null = null;
  try {
    // The tree is read company-wide and cached under one key, so it is narrowed to THIS viewer here
    // rather than at the read. Without that, the picker offered every region, line, area and rep
    // name in the company to whoever opened the board, while the board itself stayed scoped — so
    // choosing somebody else's region returned an empty board that reads as "they covered nobody".
    tree = restrictCoverageFilterTree(
      await loadCoverageFilterTree(),
      scope.kind === "agents" ? scope.agentHrIds : null,
    );
    // A URL can carry any pair of codes at all — bookmarked, shared, or hand-edited. Pruning against
    // the live org keeps whatever still makes sense and drops the rest, so a stale link degrades to
    // a wider board rather than to a self-contradictory empty one. It runs against the RESTRICTED
    // tree, so a hand-edited `?region=` outside the viewer's territory is dropped rather than
    // honoured into an empty board.
    territory = pruneCoverageSelection(tree, territory);

    const filters = {
      grade: params?.grade,
      kind: params?.kind,
      search: params?.search,
      status: params?.status,
      // Territory becomes a rep-key set the board applies AFTER its access scope, so this can only
      // ever narrow what the viewer was already entitled to see — never widen it.
      ...(coverageSelectionIsActive(territory) ? { repKeys: [...repKeysMatching(tree, territory)] } : {}),
    };
    board = await getSfeDoctorCoverage({ filters, month, scope, viewerHrId: access.hrId });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Doctor coverage data is unavailable.";
  }

  if (!board || !tree) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Doctor coverage could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DoctorCoverageBoard board={board} monthBasePath="/admin/doctor-coverage" scope={territory} tree={tree} />
    </div>
  );
}
