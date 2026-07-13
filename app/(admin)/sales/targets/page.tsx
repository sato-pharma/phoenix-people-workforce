import { redirect } from "next/navigation";

import { TargetsWorkspace, type TargetGridRow } from "@/components/sales/targets-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  SALES_LINES,
  loadEmployeeNameMap,
  loadMonthlyAchievement,
  loadProductNameMap,
  loadTargetableAreas,
  regionName,
  rollupAchievementByDm,
  rollupAchievementByLine,
  rollupAchievementByRegion,
} from "@/lib/sales/monthly-targets";

export const dynamic = "force-dynamic";

/** A 13-month window (6 back → current → 6 forward) so the picker covers loaded-actuals months and forward target months. */
function buildPeriods(): { periods: string[]; current: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const periods: string[] = [];
  for (let offset = 6; offset >= -6; offset -= 1) {
    const date = new Date(year, month - offset, 1);
    periods.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return { periods, current: `${year}-${String(month + 1).padStart(2, "0")}` };
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
  // Edit access = sales:import, held only by Super Admin + SFE Manager (server-enforced).
  try {
    await assertPermission(access, "sales", "import");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }

  const sp = await searchParams;
  const { periods, current } = buildPeriods();
  const selectedLine = SALES_LINES.find((line) => line.code === sp.line)?.code ?? SALES_LINES[0].code;
  const selectedPeriod = sp.period && periods.includes(sp.period) ? sp.period : current;

  let rows: TargetGridRow[] = [];
  let lineTotal: { actualValue: number; targetValue: number; achievementValue: number | null } | null = null;
  let byRegion: Array<{ region: string; actualValue: number; targetValue: number; achievementValue: number | null }> = [];
  let byDm: Array<{ dmName: string; actualValue: number; targetValue: number; achievementValue: number | null }> = [];
  let error: string | null = null;

  try {
    const [achievement, areas, productNames, employeeNames] = await Promise.all([
      loadMonthlyAchievement(selectedPeriod),
      loadTargetableAreas(selectedLine),
      loadProductNameMap(),
      loadEmployeeNameMap(),
    ]);
    const areaName = new Map(areas.map((area) => [area.areaCode, area.areaName]));
    const nameFor = (hrId: string | null): string | null => (hrId ? employeeNames.get(hrId) ?? hrId : null);
    const lineRows = achievement.filter((row) => row.lineCode === selectedLine);

    rows = lineRows
      .map((row) => ({
        areaCode: row.areaCode ?? "",
        areaName: areaName.get(row.areaCode ?? "") ?? "",
        regionCode: row.regionCode,
        regionName: regionName(row.regionCode),
        areaState: row.areaState,
        productCode: row.productCode,
        productName: productNames.get(row.productCode.toUpperCase()) ?? row.productCode,
        actualValue: row.actualValue,
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
        region: regionName(entry.key.startsWith(selectedLine) ? entry.key.slice(selectedLine.length) : entry.key),
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
      error={error}
    />
  );
}
