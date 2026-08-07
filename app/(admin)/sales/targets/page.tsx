import { redirect } from "next/navigation";

import { TargetsWorkspace, type TargetGridRow } from "@/components/sales/targets-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { canViewTargetsAdminPage } from "@/lib/sales/portal-targets";
import {
  SALES_LINES,
  loadAllCanonicalAreaNames,
  loadEmployeeNameMap,
  loadMonthlyAchievement,
  loadProductNameMap,
  loadProductPriceMap,
  loadSourceFiles,
  regionName,
  rollupAchievementByDm,
  rollupAchievementByLine,
  rollupAchievementByRegion,
  type SourceFileRow,
} from "@/lib/sales/monthly-targets";
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";

export const dynamic = "force-dynamic";

/**
 * A 13-month window (6 back → current → 6 forward) so the picker covers loaded-actuals months and
 * forward target months.
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
  // VIEW vs EDIT. Until 2026-07-30 this page asserted `sales:import` for both, which only Super
  // Admin and SFE Manager hold — so even the CEO could not open a report on company target
  // achievement. Viewing is now `sales:read` bounded by an explicit role list (a bare `sales:read`
  // would also admit Finance Manager / Financial Advisor, which nobody asked for), and EDITING is
  // still `sales:import`. Every write route remains `sales:import`-gated server-side.
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
  let lineTotal: { actualValue: number; targetValue: number; achievementValue: number | null } | null = null;
  let byRegion: Array<{ region: string; actualValue: number; targetValue: number; achievementValue: number | null }> = [];
  let byDm: Array<{ dmName: string; actualValue: number; targetValue: number; achievementValue: number | null }> = [];
  let sourceFiles: SourceFileRow[] = [];
  let error: string | null = null;

  try {
    const [achievement, areaName, productNames, productPrices, employeeNames, files] = await Promise.all([
      loadMonthlyAchievement(selectedPeriod),
      loadAllCanonicalAreaNames(),
      loadProductNameMap(),
      loadProductPriceMap(),
      loadEmployeeNameMap(),
      loadSourceFiles(selectedPeriod),
    ]);
    sourceFiles = files;
    const nameFor = (hrId: string | null): string | null => (hrId ? employeeNames.get(hrId) ?? hrId : null);
    
    const mergedAchievement = applyAchievementAreaMerges(achievement);
    const lineRows = mergedAchievement.filter((row) => row.lineCode === selectedLine);

    rows = lineRows
      .map((row) => ({
        areaCode: row.areaCode ?? "",
        areaName: getMergedAreaName(selectedLine, row.areaCode ?? "") ?? areaName.get(row.areaCode ?? "") ?? "",
        regionCode: row.regionCode,
        regionName: regionName(row.regionCode),
        areaState: row.areaState,
        productCode: row.productCode,
        productName: productNames.get(row.productCode.toUpperCase()) ?? row.productCode,
        unitPrice: productPrices.get(row.productCode.toUpperCase()) ?? null,
        actualValue: row.actualValue,
        targetUnits: row.targetUnits,
        targetValue: row.targetValue,
        achievementValue: row.achievementValue,
        hasActual: row.hasActual,
        repHrId: row.repHrId,
        repName: nameFor(row.repHrId),
        dmHrId: row.dmHrId,
        dmName: nameFor(row.dmHrId),
      }))
      .sort((left, right) => left.areaCode.localeCompare(right.areaCode) || left.productCode.localeCompare(right.productCode));

    const line = rollupAchievementByLine(lineRows)[0];
    lineTotal = line ? { actualValue: line.actualValue, targetValue: line.targetValue, achievementValue: line.achievementValue } : null;
    byRegion = rollupAchievementByRegion(lineRows)
      .map((entry) => ({
        region: regionName(entry.regionCode),
        actualValue: entry.actualValue,
        targetValue: entry.targetValue,
        achievementValue: entry.achievementValue,
      }))
      .sort((left, right) => left.region.localeCompare(right.region));
    byDm = rollupAchievementByDm(lineRows)
      .map((entry) => ({ dmName: nameFor(entry.key) ?? entry.key, actualValue: entry.actualValue, targetValue: entry.targetValue, achievementValue: entry.achievementValue }))
      .sort((left, right) => left.dmName.localeCompare(right.dmName));
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Failed to load targets.";
  }

  return (
    <TargetsWorkspace
      lines={SALES_LINES}
      periods={periods}
      selectedLine={selectedLine}
      selectedPeriod={selectedPeriod}
      rows={rows}
      lineTotal={lineTotal}
      byRegion={byRegion}
      byDm={byDm}
      sourceFiles={sourceFiles}
      error={error}
      canEdit={canEdit}
    />
  );
}
