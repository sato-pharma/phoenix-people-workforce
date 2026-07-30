import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { TargetsWorkspace, type TargetGridRow } from "@/components/sales/targets-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  SALES_LINES,
  loadAllCanonicalAreaNames,
  loadEmployeeNameMap,
  loadMonthlyAchievement,
  loadProductNameMap,
  loadProductPriceMap,
  regionName,
  rollupAchievementByDm,
  rollupAchievementByLine,
  rollupAchievementByRegion,
} from "@/lib/sales/monthly-targets";
import { filterAchievementForScope, isPortalTargetsRole, resolvePortalTargetsBound } from "@/lib/sales/portal-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Read-only Targets for the field sales management roles (owner decision 2026-07-30). The admin
// surface at /sales/targets keeps the authoring tools and redirects portal-shell roles away, which is
// why this twin exists at all — a District/Regional/National Sales Manager could otherwise not see
// their own target numbers anywhere in the Targets module.
//
// Same TargetsWorkspace component as the admin page, with canEdit={false}: no upload, no template,
// no inline inputs, no Save, no line-wide audit export. Rows are bounded by area code before any
// rollup runs — see the note on filterAchievementForScope.

/** A 13-month window (6 back → current → 6 forward), matching the admin page's picker. */
function buildPeriods(): { periods: string[]; current: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const periods: string[] = [];
  for (let offset = 6; offset >= -6; offset -= 1) {
    const date = new Date(year, month - offset, 1);
    periods.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return { periods, current: `${year}-${String(month + 1).padStart(2, "0")}` };
}

export default async function PortalTargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ line?: string; period?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalTargetsRole(access.role)) redirect(resolveLandingPathForRole(access.role));
  await assertPermission(access, "sales", "read");

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
    const [achievement, bound, areaName, productNames, productPrices, employeeNames] = await Promise.all([
      loadMonthlyAchievement(selectedPeriod),
      resolvePortalTargetsBound(access),
      loadAllCanonicalAreaNames(),
      loadProductNameMap(),
      loadProductPriceMap(),
      loadEmployeeNameMap(),
    ]);
    const nameFor = (hrId: string | null): string | null => (hrId ? employeeNames.get(hrId) ?? hrId : null);

    // Scope FIRST, then filter by the selected line, THEN roll up. Rolling up before scoping would
    // render a correct-looking grid above whole-line summary cards — an aggregate leak.
    const scopedRows = filterAchievementForScope(achievement, bound);
    const lineRows = scopedRows.filter((row) => row.lineCode === selectedLine);

    rows = lineRows
      .map((row) => ({
        areaCode: row.areaCode ?? "",
        areaName: areaName.get(row.areaCode ?? "") ?? "",
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
      .map((entry) => ({
        dmName: nameFor(entry.key) ?? entry.key,
        actualValue: entry.actualValue,
        targetValue: entry.targetValue,
        achievementValue: entry.achievementValue,
      }))
      .sort((left, right) => left.dmName.localeCompare(right.dmName));
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Failed to load targets.";
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      description="Your areas' targets and achievement against loaded distributor sales, by product and month."
      errorBoundaryTitle="Targets unavailable"
      title="Targets"
    >
      <TargetsWorkspace
        lines={SALES_LINES}
        periods={periods}
        selectedLine={selectedLine}
        selectedPeriod={selectedPeriod}
        rows={rows}
        lineTotal={lineTotal}
        byRegion={byRegion}
        byDm={byDm}
        // Company-wide distributor-upload provenance — never surfaced on the scoped view.
        sourceFiles={[]}
        error={error}
        canEdit={false}
        basePath="/employee-portals/targets"
      />
    </EmployeePortalPageShell>
  );
}
