import { redirect } from "next/navigation";

import { DatabaseMappingWorkspace } from "@/components/sales/database-mapping-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { countBrickMoveFilesPending } from "@/lib/sales/master-data/brick-moves";
import { MASTER_ORDER, type MasterKey } from "@/lib/sales/master-data/definitions";
import { listMasterRows, type MasterRowRecord } from "@/lib/sales/master-data/list";
import { countCustomerMapByDistributor, pickOpeningCustomerDistributor } from "@/lib/sales/normalizer/customer-map";
import { listMergedDistributorProfiles } from "@/lib/sales/normalizer/distributor-profile-store";
import { profilesToHeaderGrid } from "@/lib/sales/normalizer/profile-grid";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ brick?: string | string[]; tab?: string | string[] }>;

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

// `?tab=bricks&brick=<id>` is where the Source Normalizer's "Correct in database" lands: the Bricks
// tab, opened on that brick's area correction (see brickCorrectionHref).
export default async function DatabaseMappingPage({ searchParams }: { searchParams: SearchParams }) {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // Master-data mutation surface — restrict to Super Admin / system, matching the other
  // Source-of-Sales admin pages (Customer Directory, Customer Mapping, Normalizer).
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  const params = await searchParams;
  const initialBrickId = firstParam(params.brick) || null;
  const tab = firstParam(params.tab);
  const initialTab: MasterKey = initialBrickId
    ? "bricks"
    : (MASTER_ORDER as readonly string[]).includes(tab) ? (tab as MasterKey) : MASTER_ORDER[0];
  // Moved files whose totals still wait to be rebuilt (a move whose page was closed mid-rebuild): the
  // page picks the rebuild up again. Zero when the count cannot be read; the next move rebuilds them.
  const pendingMoveFiles = countBrickMoveFilesPending().catch(() => 0);

  const initialRows = MASTER_ORDER.reduce((accumulator, master) => {
    accumulator[master] = [];
    return accumulator;
  }, {} as Record<MasterKey, MasterRowRecord[]>);
  let initialError: string | null = null;

  try {
    await assertPermission(accessContext, "sales", "import");
    const lists = await Promise.all(MASTER_ORDER.map((master) => listMasterRows(master)));
    MASTER_ORDER.forEach((master, index) => {
      initialRows[master] = lists[index];
    });
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Failed to load Database Mapping.";
  }

  // The Database Validation tab's header grid — MERGED profiles (code ∪ DB overrides) so a saved
  // in-app edit shows here too. Fails closed to code profiles if the override table is absent.
  const initialHeaderGrid = profilesToHeaderGrid(await listMergedDistributorProfiles());
  // The customer map opens on the first distributor that has customers, never on an empty one.
  const gridCodes = initialHeaderGrid.rows.map((row) => row.distributorCode);
  const initialCustomerDistributor = pickOpeningCustomerDistributor(gridCodes, await countCustomerMapByDistributor(gridCodes));

  return (
    <DatabaseMappingWorkspace
      initialBrickId={initialBrickId}
      initialCustomerDistributor={initialCustomerDistributor}
      initialError={initialError}
      initialHeaderGrid={initialHeaderGrid}
      initialPendingMoveFiles={await pendingMoveFiles}
      initialRows={initialRows}
      initialTab={initialTab}
    />
  );
}
