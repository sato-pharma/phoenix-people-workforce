import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import {
  TargetsWorkspace,
  type DmRollup,
  type LineTotal,
  type RegionRollup,
  type TargetGridRow,
} from "@/components/sales/targets-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
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
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
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

/**
 * A 13-month window (6 back → current → 6 forward), matching the admin page's picker — including
 * its Cairo anchor, so this read-only twin can never label a different month "current" than the
 * authoring surface does.
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
  const requestedLine = SALES_LINES.find((line) => line.code === sp.line)?.code ?? null;
  const selectedPeriod = sp.period && periods.includes(sp.period) ? sp.period : current;

  // The line picker must mirror the VIEWER's scope, not the company's. A District / Regional /
  // National Sales Manager owns exactly one line (their `bound.lineCodes`), so showing the full
  // CNS/Pedia/Anti-infective switcher lets them navigate to a line whose grid is correctly — but
  // confusingly — empty for them. Both are finalized inside the try, once resolvePortalTargetsBound
  // has run; a company viewer (canViewAllTargets) keeps every line.
  let availableLines: ReadonlyArray<{ code: string; label: string }> = SALES_LINES;
  let selectedLine = requestedLine ?? SALES_LINES[0].code;

  let rows: TargetGridRow[] = [];
  let lineTotal: LineTotal = null;
  let byRegion: RegionRollup[] = [];
  let byDm: DmRollup[] = [];
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

    // Restrict the line switcher to the viewer's own line(s). `bound.lineCodes` carries the SALES_LINES
    // codes the viewer is scoped to (a single line for District / Regional / National Sales Manager);
    // a company viewer resolves to `canViewAllTargets` and keeps the full list. If the bound can't be
    // narrowed to a real line (null/empty, or nothing matched), fall back to every line rather than
    // rendering a dead, empty picker.
    const scopedLineCodes = bound.canViewAllTargets ? null : bound.lineCodes;
    if (scopedLineCodes && scopedLineCodes.size > 0) {
      const scoped = SALES_LINES.filter((line) => scopedLineCodes.has(line.code));
      if (scoped.length > 0) {
        availableLines = scoped;
        selectedLine =
          requestedLine && scoped.some((line) => line.code === requestedLine) ? requestedLine : scoped[0].code;
      }
    }

    // Scope FIRST, then filter by the selected line, THEN roll up. Rolling up before scoping would
    // render a correct-looking grid above whole-line summary cards — an aggregate leak.
    const mergedAchievement = applyAchievementAreaMerges(achievement);
    const scopedRows = filterAchievementForScope(mergedAchievement, bound);
    const lineRows = scopedRows.filter((row) => row.lineCode === selectedLine);

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
    lineTotal = line
      ? { actualValue: line.actualValue, coveredActualValue: line.coveredActualValue, targetValue: line.targetValue, achievementValue: line.achievementValue }
      : null;
    byRegion = rollupAchievementByRegion(lineRows)
      .map((entry) => ({
        region: regionName(entry.regionCode),
        actualValue: entry.actualValue,
        coveredActualValue: entry.coveredActualValue,
        targetValue: entry.targetValue,
        achievementValue: entry.achievementValue,
      }))
      .sort((left, right) => left.region.localeCompare(right.region));
    byDm = rollupAchievementByDm(lineRows)
      .map((entry) => ({
        dmName: nameFor(entry.key) ?? entry.key,
        actualValue: entry.actualValue,
        coveredActualValue: entry.coveredActualValue,
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
        lines={availableLines}
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
