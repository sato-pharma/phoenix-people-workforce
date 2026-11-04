// Brick Coverage — READ-ONLY board inside the Phoenix admin shell, answering "is each rep visiting
// the bricks that carry his sales?". Mirrors app/(admin)/admin/doctor-coverage/page.tsx exactly:
// month rides in the URL so every switch re-runs the gate server-side, and the role list is NOT
// maintained here — both boards ask src/lib/crm/doctor-coverage-scope.ts, so they cannot drift
// apart on who may see whose reps.
//
// The board itself is deliberately labelled as interim: it infers presence from GPS check-ins
// because the CRM region -> brick mapping is still empty. See src/lib/crm/brick-coverage.ts.
import { redirect } from "next/navigation";

import { BrickCoverageBoard } from "@/components/crm/brick-coverage-board";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { readsUnpublishedSalesTools } from "@/lib/sales/unpublished-sales-access";
import {
  coverageSelectionIsActive,
  pruneCoverageSelection,
  repsMatching,
  resolveCoverageSelection,
  restrictCoverageFilterTree,
} from "@/lib/crm/coverage-filters";
import { loadCoverageFilterTree } from "@/lib/crm/coverage-filters-data";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { getBrickCoverage, resolveBrickCoverageMonth } from "@/lib/crm/brick-coverage";
import { canonicalHrIdKey } from "@/lib/hr-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Filters ride in the URL alongside the month, so every change re-runs the gate server-side.
type PageProps = {
  searchParams?: Promise<{ area?: string; line?: string; month?: string; region?: string; rep?: string }>;
};

export default async function BrickCoveragePage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  const scope = await getDoctorCoverageScope(access);
  // No access resolves to a redirect rather than an explanation: inside the admin shell an
  // unreachable page should behave as if it does not exist for that role.
  if (scope.kind === "none") redirect("/admin");

  const params = await searchParams;
  const month = resolveBrickCoverageMonth(params?.month);

  // Data fetch and JSX stay separated (react-hooks/error-boundaries: JSX must not be constructed
  // inside try/catch). Same rose fallback posture as Doctor Coverage — a data failure renders a
  // plain explanation, never a crash page.
  let board: Awaited<ReturnType<typeof getBrickCoverage>> | null = null;
  let tree: Awaited<ReturnType<typeof loadCoverageFilterTree>> | null = null;
  let territory = resolveCoverageSelection({
    area: params?.area,
    line: params?.line,
    region: params?.region,
    rep: params?.rep,
  });
  let loadError: string | null = null;
  try {
    // Narrowed to THIS viewer — the tree is read company-wide and cached under one key, and both
    // coverage boards share it, so the same picker that offered Doctor Coverage every region, line,
    // area and rep name in the company offered them here too.
    tree = restrictCoverageFilterTree(
      await loadCoverageFilterTree(),
      scope.kind === "agents" ? scope.agentHrIds : null,
    );
    // A bookmarked or hand-edited URL can pair codes that do not go together; pruning keeps what
    // still makes sense rather than rendering a self-contradictory empty board.
    territory = pruneCoverageSelection(tree, territory);

    board = await getBrickCoverage({
      includeUnpublishedSales: readsUnpublishedSalesTools(access),
      month,
      scope,
      // Mapped into THIS board's key convention — bare canonical hr id, no `hr:` prefix. The doctor
      // board keys the same people differently; see repsMatching.
      territoryRepKeys: coverageSelectionIsActive(territory)
        ? repsMatching(tree, territory).map((rep) => canonicalHrIdKey(rep.hrId) ?? rep.hrId)
        : null,
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Brick coverage data is unavailable.";
  }

  if (!board || !tree) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">Brick coverage could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  return (
    <>
      {board.salesWithheld ? (
        <div className="mb-4 border border-amber-200 bg-amber-50 px-5 py-3">
          <p className="text-xs font-semibold text-amber-900">
            Sales for {board.monthLabel} appear here once the month&apos;s closing is published. Visits are shown as usual.
          </p>
        </div>
      ) : null}
      <BrickCoverageBoard board={board} monthBasePath="/admin/brick-coverage" scope={territory} tree={tree} />
    </>
  );
}
