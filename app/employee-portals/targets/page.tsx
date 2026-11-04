import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepTargetsView } from "@/components/sales/rep-targets-view";
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
  foldMergedAchievementCells,
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
import {
  filterAchievementForScope,
  isPortalRepTargetsRole,
  isPortalTargetsRole,
  resolvePortalTargetsBound,
  TARGETS_TERRITORY_UNRESOLVED_MESSAGE,
} from "@/lib/sales/portal-targets";
import { loadRepTargets } from "@/lib/sales/rep-targets";
import { isSalesPeriodReleased } from "@/lib/sales/unpublished-sales-access";
import { loadPublishedPeriodKeys, withholdUnpublishedSales } from "@/lib/sales/vs-target";

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
//
// A MEDICAL REP reaches the same URL (owner, 2026-09-16) and is answered by the branch at the top
// of the page, before the manager gate: their own targets, bounded to their HR id, in their own view.
// They must never fall through to the manager path — its bound would hand a rep the whole line.

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

  if (isPortalRepTargetsRole(access.role)) {
    await assertPermission(access, "sales", "read");
    const { period } = await searchParams;
    // Not caught: a failed read belongs to the error boundary, exactly as on the rep's Sales vs
    // Target page — an empty result would tell the rep a published month is still awaiting closing.
    const repTargets = await loadRepTargets(access, period ?? null);
    // Badge and title are the sidebar's own section and label ("Sales" · "Targets").
    return (
      <EmployeePortalPageShell
        badge="Sales"
        description="Your own targets by product and month, and how far you reached them once each month's closing is published."
        errorBoundaryTitle="Targets unavailable"
        title="Targets"
      >
        {/* The rep view renders the portal identity under the standard navy shell hero. */}
        <RepTargetsView data={repTargets} basePath="/employee-portals/targets" salesVsTargetHref="/employee-portals/sales-vs-target" />
      </EmployeePortalPageShell>
    );
  }

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
  // Closed until the publication read says otherwise, so a failed read can never show a sale.
  let salesPublished = false;

  try {
    const [achievement, publishedKeys, bound, areaName, productNames, productPrices, employeeNames] = await Promise.all([
      loadMonthlyAchievement(selectedPeriod),
      // Below the July 2026 floor this is an empty set. Both gates below read that as history, not as closed.
      loadPublishedPeriodKeys(selectedPeriod, selectedPeriod),
      resolvePortalTargetsBound(access),
      loadAllCanonicalAreaNames(),
      loadProductNameMap(),
      loadProductPriceMap(selectedPeriod),
      loadEmployeeNameMap(),
    ]);
    const nameFor = (hrId: string | null): string | null => (hrId ? employeeNames.get(hrId) ?? hrId : null);
    // A District / Regional Manager whose organogram seat gave no areas gets an empty bound (no rows),
    // never his whole line — and the page says why in words instead of showing a blank grid.
    if (bound.territoryUnresolved) error = TARGETS_TERRITORY_UNRESOLVED_MESSAGE;

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
    //
    // The publication gate comes before all of it, for every role that reaches this page (owner,
    // 2026-11-04): every figure below is built from these rows, so an unpublished month's sale cannot
    // reach a roll-up or the page payload. Targets stay, which is why rows are not simply dropped.
    salesPublished = isSalesPeriodReleased(selectedPeriod, selectedLine, publishedKeys);
    const mergedAchievement = applyAchievementAreaMerges(withholdUnpublishedSales(achievement, publishedKeys));
    const scopedRows = filterAchievementForScope(mergedAchievement, bound);
    const lineRows = scopedRows.filter((row) => row.lineCode === selectedLine);

    // FOLD before building the keyed grid rows, exactly as the admin authoring page did before it
    // stopped reading achievement at all. applyAchievementAreaMerges above rewrites the CODE without
    // aggregating, so on Pedia the merged Fayoum/Beni Suef pair arrives here as TWO rows that both key
    // on `GZ6|product` — a duplicate React key, and the area printed twice with different numbers.
    //
    // The roll-ups below deliberately keep `lineRows`: they re-derive coveredActualValue from
    // hasTarget, which the fold OR-s, so folding first would count an untargeted area's actuals as
    // covered and inflate the very figure the card prints beside the grade.
    const gridRows = foldMergedAchievementCells(lineRows);

    rows = gridRows
      .map((row) => ({
        areaCode: row.areaCode ?? "",
        areaName: getMergedAreaName(selectedLine, row.areaCode ?? "", selectedPeriod) ?? areaName.get(row.areaCode ?? "") ?? "",
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
      badge="Sales"
      description="Your areas' targets, and how far they were reached once each month's closing is published."
      errorBoundaryTitle="Targets unavailable"
      title="Targets"
    >
      {/* surface="portal": the workspace drops its light command band for the portal identity under
          the standard navy shell hero. The admin authoring twin at /sales/targets is unchanged. */}
      <TargetsWorkspace
        lines={availableLines}
        periods={periods}
        selectedLine={selectedLine}
        selectedPeriod={selectedPeriod}
        rows={rows}
        lineTotal={lineTotal}
        byRegion={byRegion}
        byDm={byDm}
        salesPublished={salesPublished}
        // Company-wide distributor-upload provenance — never surfaced on the scoped view.
        sourceFiles={[]}
        error={error}
        canEdit={false}
        basePath="/employee-portals/targets"
        surface="portal"
      />
    </EmployeePortalPageShell>
  );
}
