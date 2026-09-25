import { redirect } from "next/navigation";

import { TargetsAuthoring, type TargetGridRow } from "@/components/sales/targets-authoring";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { canViewTargetsAdminPage } from "@/lib/sales/portal-targets";
import {
  SALES_LINES,
  loadMonthlyTargets,
  loadTargetableAreas,
  loadTargetableProducts,
  regionName,
} from "@/lib/sales/monthly-targets";
import { getMergedAreaName } from "@/lib/sales/closing-area-merges";

export const dynamic = "force-dynamic";

/**
 * A 13-month window (6 back → current → 6 forward) so the picker covers closed months and the
 * forward months targets are actually set for.
 *
 * `current` MUST come from Cairo, never the runtime clock: this is a server component on a UTC
 * runtime, and `current` becomes the default `selectedPeriod` that the grid SAVES with. Between
 * Cairo 00:00 and 02:00/03:00 on the 1st a UTC clock still reads the previous month — and
 * phx_upsert_monthly_targets is ON CONFLICT DO UPDATE, so entering the new month's targets in
 * those hours would silently overwrite the month that just closed.
 */
function buildPeriods(): { periods: string[]; current: string } {
  const { year, month } = currentCairoDateParts();
  const monthIndex = month - 1; // 0-based for the Date arithmetic below
  const periods: string[] = [];
  for (let offset = 6; offset >= -6; offset -= 1) {
    const date = new Date(Date.UTC(year, monthIndex - offset, 1));
    periods.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return { periods, current: `${year}-${String(month).padStart(2, "0")}` };
}

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ line?: string; period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  // VIEW vs EDIT. Viewing is `sales:read` bounded by an explicit role list (a bare `sales:read`
  // would also admit Finance Manager / Financial Advisor, which nobody asked for), and EDITING is
  // `sales:import`. Every write route remains `sales:import`-gated server-side.
  try {
    await assertPermission(access, "sales", "read");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }
  if (!canViewTargetsAdminPage(access)) redirect(resolveLandingPathForRole(access.role));
  const canEdit = await canAccess(access, "sales", "import");

  const sp = await searchParams;
  const { periods, current } = buildPeriods();
  const selectedLine = SALES_LINES.find((line) => line.code === sp.line)?.code ?? SALES_LINES[0].code;
  const selectedPeriod = sp.period && periods.includes(sp.period) ? sp.period : current;

  let rows: TargetGridRow[] = [];
  let error: string | null = null;

  try {
    // ── The row source is the MODEL, not the sales ────────────────────────────
    //
    // This page used to build its grid from `au.f_monthly_achievement`, which returns a row only
    // where a target or a sale already exists. Two consequences, and the second is why it had to
    // change: achievement belongs to Business Review and the owner does not want it on this tab
    // at all — and a month with no sales yet returned ZERO rows, so October, November and
    // December rendered "Nothing loaded" and a target for a future quarter could not be typed AT
    // ALL. Targets are authored ahead of the sales they are later measured against; a screen that
    // can only show months which already happened cannot do this job.
    //
    // `loadTargetableAreas` is the authority: `carries_target = true` only ("Other" areas carry
    // none) and merged pairs already folded to one option, so Pedia offers "Fayoum - Beni Suef"
    // once rather than a Beni Suef cell that no screen can ever display.
    const [areas, products, targets] = await Promise.all([
      loadTargetableAreas(selectedLine),
      loadTargetableProducts(selectedLine),
      loadMonthlyTargets(selectedPeriod),
    ]);

    const targetByCell = new Map(
      targets
        .filter((target) => target.lineCode === selectedLine)
        .map((target) => [`${target.areaCode}|${target.productCode.toUpperCase()}`, target]),
    );

    rows = areas.flatMap((area) =>
      products.map((product) => {
        const target = targetByCell.get(`${area.areaCode}|${product.productCode.toUpperCase()}`);
        return {
          areaCode: area.areaCode,
          areaName: getMergedAreaName(selectedLine, area.areaCode, selectedPeriod) ?? area.areaName,
          regionCode: area.regionCode,
          regionName: regionName(area.regionCode),
          areaState: area.areaState,
          productCode: product.productCode,
          productName: product.productName,
          unitPrice: product.factoryPrice,
          targetUnits: target?.targetUnits ?? null,
          targetValue: target?.targetValue ?? null,
        } satisfies TargetGridRow;
      }),
    );
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Failed to load targets.";
  }

  return (
    <TargetsAuthoring
      lines={SALES_LINES}
      periods={periods}
      selectedLine={selectedLine}
      selectedPeriod={selectedPeriod}
      rows={rows}
      error={error}
      canEdit={canEdit}
    />
  );
}
