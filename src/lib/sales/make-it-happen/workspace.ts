// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the payload both routes render.
//
// The admin-shell page (SFE Manager, Super Admin) and the portal page share this builder, and so
// do the save and suggest routes: the numbers a plan is saved against are rebuilt here from the
// database, never trusted from the browser.
//
// Scope is applied to the raw rows FIRST, before anything is totalled — the Sales vs Target rule.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { resolveSemesterKey } from "@/lib/incentives/semester";
import { PEDIA_SATO_PRODUCT_CODES, isPediaSatoProductCode, pediaSplitApplies } from "@/lib/incentives/pedia-split";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import {
  SALES_LINES,
  lineName,
  loadEmployeeEmploymentStatusMap,
  loadAreaNameMap,
  loadEmployeeNameMap,
  loadProductFamilyMap,
  loadProductNameMap,
  regionName,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import { loadProductPeriodPrices } from "@/lib/sales/product-period-price";
import {
  isRowPublished,
  loadAchievementRange,
  loadPublishedPeriodKeys,
  salesVsTargetPeriods,
} from "@/lib/sales/vs-target";
import {
  MAKE_IT_HAPPEN_FLOOR,
  achievementOf,
  forecastMonthsOf,
  gradeRows,
  isPeriodKind,
  monthLabel,
  offeredPeriods,
  periodKeyOf,
  periodLabel,
  periodMonths,
  readTrend,
  shiftMonth,
  sortBricks,
  type BrickPlanRow,
  type ConcentrationPlanRow,
  type GradableRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
  type PeriodKind,
  type RepPlanSummary,
  type SavedPlanSummary,
} from "@/lib/sales/make-it-happen/engine";
import { brickReadNarrowing, loadBrickUnitsInBound, type BrickUnitsRow } from "@/lib/sales/make-it-happen/brick-history";
import { listPlansForOwners, type StoredPlan } from "@/lib/sales/make-it-happen/plan-store";
import {
  applyMakeItHappenBound,
  isTeamBound,
  resolveMakeItHappenBound,
} from "@/lib/sales/make-it-happen/scope";
import { isListedOnTeam, teamRowSatoHalf } from "@/lib/sales/make-it-happen/team-roster";

export type WorkspaceRequest = {
  kind?: string | null;
  period?: string | null;
  rep?: string | null;
};

function upper(code: string | null | undefined): string {
  return String(code ?? "").trim().toUpperCase();
}

function stripOwner(plan: StoredPlan): SavedPlanSummary {
  const { ownerKey: _ownerKey, ...summary } = plan;
  return summary;
}

export async function buildMakeItHappenWorkspace(
  ctx: AccessContext,
  request: WorkspaceRequest,
): Promise<MakeItHappenWorkspace> {
  const { current } = salesVsTargetPeriods();
  const periodKind: PeriodKind = isPeriodKind(request.kind) ? request.kind : "quarter";
  const offered = {
    month: offeredPeriods("month", current),
    quarter: offeredPeriods("quarter", current),
    semester: offeredPeriods("semester", current),
  };
  const offeredKeys = offered[periodKind].map((option) => option.value);
  const periodKey =
    request.period && offeredKeys.includes(request.period)
      ? request.period
      : (periodKeyOf(periodKind, current) ?? offeredKeys[0] ?? current);
  const months = periodMonths(periodKind, periodKey) ?? [current];
  const periodEnd = months[months.length - 1];
  const rangeTo = periodEnd > current ? periodEnd : current;
  const ownerKey = canonicalHrIdForDisplay(ctx.hrId);

  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"). The achievement range,
  // the publication keys and the product masters depend on the window alone, never on who is asking,
  // so they no longer wait for the bound — which is still applied to the rows below before anything
  // is totalled. A `none` bound returns the empty shell without awaiting them; the guards keep that
  // quiet. Each is still awaited, and still throws, where it is used.
  const boundLoad = resolveMakeItHappenBound(ctx);
  const windowLoads = Promise.all([
    loadAchievementRange(MAKE_IT_HAPPEN_FLOOR, rangeTo),
    loadPublishedPeriodKeys(MAKE_IT_HAPPEN_FLOOR, rangeTo),
    loadProductNameMap(),
    loadProductPeriodPrices(),
    loadProductFamilyMap(),
  ]);
  windowLoads.catch(() => {});
  // Employee names name the rep being viewed, the per-rep list AND each brick's rep and District
  // Manager (the export's District Managers and Medical Reps tabs, owner 2026-11-14) — so every bound reads them; the
  // read is memoised for a minute. A failed read must not blank the planner: names then read unnamed.
  const employeeNamesLoad = boundLoad.then((resolved) =>
    resolved.rows.kind === "none" ? new Map<string, string>() : loadEmployeeNameMap().catch(() => new Map<string, string>()),
  );
  employeeNamesLoad.catch(() => {});
  // Area names place each brick on the export's Bricks tab (Region → Area → Brick, owner 2026-11-14).
  // Display text only: a failed read must not blank the planner, the bricks then read "Area not named".
  const areaNamesLoad = boundLoad.then((resolved) =>
    resolved.rows.kind === "none" ? new Map<string, string>() : loadAreaNameMap().catch(() => new Map<string, string>()),
  );
  areaNamesLoad.catch(() => {});
  // Employment status decides who the per-person list names (team-roster.ts), so it is a team-only
  // read too. A failed read must not blank the planner: every person then reads as still employed.
  const employmentStatusLoad = boundLoad.then((resolved) =>
    isTeamBound(resolved)
      ? loadEmployeeEmploymentStatusMap().catch(() => new Map<string, string>())
      : new Map<string, string>(),
  );
  employmentStatusLoad.catch(() => {});
  // A non-team viewer's saved plans are his OWN and nobody else's — no rep to view, no rep list — so
  // the owner list is known the moment the bound is, and his plans read beside the range instead of
  // after it. Wrapped, because null from listPlansForOwners already means "no plans table".
  const ownPlansLoad = boundLoad.then((resolved) =>
    resolved.rows.kind !== "none" && !isTeamBound(resolved)
      ? listPlansForOwners([ownerKey ?? ""], periodKind, periodKey).then((plans) => ({ plans }))
      : null,
  );
  ownPlansLoad.catch(() => {});

  const bound = await boundLoad;

  const shell: MakeItHappenWorkspace = {
    periodKind,
    periodKey,
    periodLabel: periodLabel(periodKind, periodKey),
    offered,
    scopeLabel: bound.label,
    isEmptyScope: true,
    viewingRep: null,
    canSave: false,
    plansAvailable: true,
    bricksAvailable: true,
    lines: [],
    totals: { targetValue: null, gradedValue: 0, actualValue: 0 },
    reps: [],
    plans: [],
  };
  if (bound.rows.kind === "none") return shell;

  const [[rawRows, publishedKeys, productNames, prices, families], employeeNames, employmentStatuses] =
    await Promise.all([windowLoads, employeeNamesLoad, employmentStatusLoad]);
  const areaNames = await areaNamesLoad;

  const namesByKey = new Map<string, string>();
  for (const [hrId, name] of employeeNames) {
    const key = canonicalHrIdKey(hrId);
    if (key) namesByKey.set(key, name);
  }
  const statusByKey = new Map<string, string>();
  for (const [hrId, status] of employmentStatuses) {
    const key = canonicalHrIdKey(hrId);
    if (key) statusByKey.set(key, status);
  }
  const personName = (hrId: string | null | undefined) =>
    namesByKey.get(canonicalHrIdKey(hrId) ?? "") ?? "Unnamed employee";

  const mergedRows = applyAchievementAreaMerges(rawRows);
  let rows = applyMakeItHappenBound(mergedRows, bound);
  const team = isTeamBound(bound);

  let viewingRep: MakeItHappenWorkspace["viewingRep"] = null;
  const repKey = team ? canonicalHrIdKey(request.rep) : null;
  if (repKey) {
    const repRows = rows.filter((row) => canonicalHrIdKey(row.repHrId) === repKey);
    // A rep outside the viewer's bound has no rows here, so the request silently stays on the team.
    if (repRows.length > 0) {
      rows = repRows;
      viewingRep = { key: canonicalHrIdForDisplay(repKey) ?? repKey, name: personName(repKey) };
    }
  }

  // Closed history per line: published months from the floor up to this month.
  const historyMonthsByLine = new Map<string, string[]>();
  for (const line of SALES_LINES) {
    const list: string[] = [];
    let cursor: string | null = MAKE_IT_HAPPEN_FLOOR;
    while (cursor && cursor <= current) {
      if (publishedKeys.has(`${line.code}|${cursor}`)) list.push(cursor);
      cursor = shiftMonth(cursor, 1);
    }
    historyMonthsByLine.set(line.code, list);
  }

  // engine.ts rule 9 — each brick's own closed months, read for the rows this page shows and no
  // others. The read is narrowed to the lines and areas those rows touch (the RAW codes, so a merged
  // area still reaches the SQL), then bound exactly in brick-history.ts.
  const shownRows = new Set(rows);
  const scopedRaw = rawRows.filter((_, index) => shownRows.has(mergedRows[index]));
  const brickMonths = [...new Set([...historyMonthsByLine.values()].flat())].sort();
  // A failed brick read must not blank the planner: the products still plan, and the screen says the
  // bricks could not be read rather than showing a product as if it sold on no brick.
  let bricksAvailable = true;
  const brickRows = await loadBrickUnitsInBound({
    months: brickMonths,
    bound,
    narrowing: brickReadNarrowing(scopedRaw, bound.rows.kind === "company"),
    repKey: viewingRep ? repKey : null,
  }).catch((error: unknown) => {
    console.error("[make-it-happen] brick read failed", error);
    bricksAvailable = false;
    return [] as BrickUnitsRow[];
  });

  const monthSet = new Set(months);
  // Quarters and months sit inside one semester, and a semester is itself — so the first month names it.
  const periodSemester = resolveSemesterKey(months[0]);
  const satoNames = PEDIA_SATO_PRODUCT_CODES.map((code) => productNames.get(code)).filter(
    (name): name is string => Boolean(name),
  );
  const satoProductNames =
    satoNames.length === 0
      ? "the Sato products"
      : satoNames.length === 1
        ? satoNames[0]
        : `${satoNames.slice(0, -1).join(", ")} and ${satoNames[satoNames.length - 1]}`;
  const toGradable = (row: AchievementRow): GradableRow => ({
    period: row.period,
    closed: isRowPublished(row, publishedKeys),
    actualUnits: row.actualUnits,
    actualValue: row.actualValue,
    targetUnits: row.targetUnits,
    targetValue: row.targetValue,
  });

  // Who covers each brick on each line: the rep and District Manager of the LATEST closed month the
  // brick sold anything on that line. One brick has one rep and one DM per line and month (checked
  // on production, September 2026: 0 of 5,652 brick rows shared), so the latest month names today's
  // cover. Read once from every product's rows, so a brick sits under ONE rep in every product.
  // A rep sits under ONE District Manager: the one on HIS latest row on that line — so a brick that
  // last sold under a former manager still files under the rep's current one. Only a brick with no
  // rep (a vacant seat) keeps its own row's District Manager.
  const brickCover = new Map<string, { period: string; repHrId: string | null; dmHrId: string | null; areaCode: string | null }>();
  const repManager = new Map<string, { period: string; dmHrId: string | null }>();
  for (const row of brickRows) {
    const key = `${row.lineCode ?? ""}|${row.brickId}`;
    const seen = brickCover.get(key);
    if (!seen || seen.period < row.period) {
      brickCover.set(key, { period: row.period, repHrId: row.repHrId, dmHrId: row.dmHrId, areaCode: row.areaCode });
    }
    const repKeyOfRow = canonicalHrIdKey(row.repHrId);
    if (!repKeyOfRow) continue;
    const managerKey = `${row.lineCode ?? ""}|${repKeyOfRow}`;
    const managerSeen = repManager.get(managerKey);
    if (!managerSeen || managerSeen.period < row.period || (managerSeen.period === row.period && !managerSeen.dmHrId)) {
      repManager.set(managerKey, { period: row.period, dmHrId: row.dmHrId });
    }
  }
  for (const [key, cover] of brickCover) {
    const repKeyOfCover = canonicalHrIdKey(cover.repHrId);
    if (!repKeyOfCover) continue;
    const manager = repManager.get(`${key.slice(0, key.indexOf("|"))}|${repKeyOfCover}`);
    if (manager) cover.dmHrId = manager.dmHrId;
  }
  // An area's region on each line, from the merged achievement rows — the same areas the brick rows
  // carry after their own merges (brick-history.ts). Never a code on screen: an area the master does
  // not name reads "Area not named", a region without one "Region not named".
  // The latest month wins, as it does for the brick's cover.
  const areaRegion = new Map<string, { period: string; region: string }>();
  for (const row of mergedRows) {
    const area = row.areaCode?.trim().toUpperCase();
    if (!area || !row.regionCode || !row.lineCode) continue;
    const key = `${row.lineCode}|${area}`;
    const seen = areaRegion.get(key);
    if (!seen || seen.period < row.period) areaRegion.set(key, { period: row.period, region: row.regionCode });
  }
  const placeOf = (lineCode: string, areaCode: string | null | undefined) => {
    const area = areaCode?.trim().toUpperCase();
    if (!area) return { areaName: null, regionName: null };
    const region = areaRegion.get(`${lineCode}|${area}`)?.region;
    return {
      areaName: areaNames.get(area) || "Area not named",
      regionName: region ? regionName(region) || "Region not named" : null,
    };
  };
  const knownName = (hrId: string | null) => (hrId ? (namesByKey.get(canonicalHrIdKey(hrId) ?? "") ?? "Unnamed employee") : null);

  /** One product's bricks on one line, each read from its own closed months (rule 9). */
  const bricksOf = (
    lineCode: string,
    lineBricks: Map<string, BrickUnitsRow[]>,
    code: string,
    historyMonths: string[],
    openMonths: number,
  ): BrickPlanRow[] => {
    const byBrick = new Map<string, { name: string; units: Map<string, number> }>();
    for (const row of lineBricks.get(code) ?? []) {
      const entry = byBrick.get(row.brickId) ?? { name: row.brickName, units: new Map<string, number>() };
      if (!entry.name && row.brickName) entry.name = row.brickName;
      entry.units.set(row.period, (entry.units.get(row.period) ?? 0) + row.units);
      byBrick.set(row.brickId, entry);
    }
    const bricks: BrickPlanRow[] = [];
    for (const [brickId, entry] of byBrick) {
      // A closed month with no row is a month the brick sold nothing — 0, never skipped.
      const history = historyMonths.map((month) => entry.units.get(month) ?? 0);
      // A brick that only ever booked returns sold nothing to plan on.
      if (!history.some((units) => units > 0)) continue;
      const trend = readTrend(history, openMonths);
      const cover = brickCover.get(`${lineCode}|${brickId}`);
      bricks.push({
        brickId,
        name: entry.name || "Unnamed brick",
        expectedUnits: trend.expectedUnits,
        realisticMaxUnits: trend.realisticMaxUnits,
        repName: knownName(cover?.repHrId ?? null),
        districtManagerName: knownName(cover?.dmHrId ?? null),
        ...placeOf(lineCode, cover?.areaCode),
      });
    }
    return sortBricks(bricks);
  };

  const buildLines = (scopeRows: AchievementRow[], bricks: readonly BrickUnitsRow[] = []): LinePlanGroup[] => {
    const groups: LinePlanGroup[] = [];
    for (const line of SALES_LINES) {
      const lineRows = scopeRows.filter((row) => row.lineCode === line.code);
      if (lineRows.length === 0) continue;
      const historyMonths = historyMonthsByLine.get(line.code) ?? [];
      const historySet = new Set(historyMonths);
      const isClosed = (month: string) => publishedKeys.has(`${line.code}|${month}`);
      const closedMonths = months.filter(isClosed);
      const periodRows = lineRows.filter((row) => monthSet.has(row.period));
      // engine.ts rule 6: the forecast fills only the open months this scope carries a target in.
      const targetedMonths = new Set(periodRows.filter((row) => (row.targetValue ?? 0) > 0).map((row) => row.period));
      const { forecast: openMonths, untargeted } = forecastMonthsOf(months, isClosed, (month) => targetedMonths.has(month));

      const lineBricks = new Map<string, BrickUnitsRow[]>();
      for (const row of bricks) {
        if (row.lineCode !== line.code || !historySet.has(row.period)) continue;
        const bucket = lineBricks.get(row.productCode) ?? [];
        bucket.push(row);
        lineBricks.set(row.productCode, bucket);
      }

      const byCode = new Map<string, AchievementRow[]>();
      for (const row of lineRows) {
        if (!monthSet.has(row.period) && !historySet.has(row.period)) continue;
        const code = upper(row.productCode);
        if (!code) continue;
        const bucket = byCode.get(code) ?? [];
        bucket.push(row);
        byCode.set(code, bucket);
      }

      const concentrations: ConcentrationPlanRow[] = [];
      for (const [code, codeRows] of byCode) {
        const graded = gradeRows(codeRows.filter((row) => monthSet.has(row.period)).map(toGradable));
        const unitsByMonth = new Map<string, number>();
        for (const row of codeRows) {
          if (historySet.has(row.period)) unitsByMonth.set(row.period, (unitsByMonth.get(row.period) ?? 0) + row.actualUnits);
        }
        // A closed month with no row is a month with no sales — 0, never skipped.
        const history = historyMonths.map((period) => ({
          period,
          label: monthLabel(period, true),
          units: unitsByMonth.get(period) ?? 0,
        }));
        const hasSomething =
          graded.targetValue > 0 || graded.actualUnits !== 0 || history.some((point) => point.units !== 0);
        if (!hasSomething) continue;
        concentrations.push({
          productCode: code,
          name: productNames.get(code) ?? "Unnamed product",
          family: families.get(code) ?? "",
          // One price for a concentration that spans months: the one in force at the END of
          // the window, which is the price the plan being written will actually be sold at.
          price: prices.priceFor(code, rangeTo) ?? 0,
          targetUnits: graded.targetUnits > 0 ? graded.targetUnits : null,
          targetValue: graded.targetValue > 0 ? graded.targetValue : null,
          actualUnits: graded.actualUnits,
          actualValue: graded.actualValue,
          gradedUnits: graded.gradedUnits,
          gradedValue: graded.gradedValue,
          history,
          trend: readTrend(
            history.map((point) => point.units),
            openMonths.length,
          ),
          bricks: bricksOf(line.code, lineBricks, code, historyMonths, openMonths.length),
        });
      }
      if (concentrations.length === 0) continue;
      concentrations.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));

      const lineGraded = gradeRows(periodRows.map(toGradable));

      // engine.ts rule 7 — the Sato half, graded on its OWN rows so its months are its own: the
      // same total-over-total the incentive tab reads (src/lib/incentives/pedia-achievement.ts).
      let satoHalf: LinePlanGroup["satoHalf"] = null;
      if (pediaSplitApplies({ line: line.code, semester: periodSemester })) {
        const satoRows = periodRows.filter((row) => isPediaSatoProductCode(row.productCode));
        const satoInScope = concentrations.some((row) => isPediaSatoProductCode(row.productCode));
        if (satoInScope) {
          const satoGraded = gradeRows(satoRows.map(toGradable));
          satoHalf = {
            productCodes: concentrations
              .map((row) => row.productCode)
              .filter((code) => isPediaSatoProductCode(code)),
            productNames: satoProductNames,
            targetValue: satoGraded.targetValue > 0 ? satoGraded.targetValue : null,
            gradedValue: satoGraded.gradedValue,
          };
        }
      }

      groups.push({
        lineCode: line.code,
        lineName: lineName(line.code),
        remainingMonths: openMonths.length,
        closedMonthLabels: closedMonths.map((month) => monthLabel(month, true)),
        forecastMonthLabels: openMonths.map((month) => monthLabel(month, true)),
        untargetedMonthLabels: untargeted.map((month) => monthLabel(month, true)),
        targetValue: lineGraded.targetValue > 0 ? lineGraded.targetValue : null,
        gradedValue: lineGraded.gradedValue,
        actualValue: lineGraded.actualValue,
        satoHalf,
        rows: concentrations,
      });
    }
    return groups;
  };

  // Bricks on the planner's own lines only: the per-rep list below reads each rep's pace, never his bricks.
  const lines = buildLines(rows, brickRows);
  const overall = gradeRows(rows.filter((row) => monthSet.has(row.period)).map(toGradable));

  const reps: RepPlanSummary[] = [];
  if (team && !viewingRep) {
    const rowsByRep = new Map<string, AchievementRow[]>();
    for (const row of rows) {
      const key = canonicalHrIdKey(row.repHrId);
      if (!key) continue;
      const bucket = rowsByRep.get(key) ?? [];
      bucket.push(row);
      rowsByRep.set(key, bucket);
    }
    for (const [key, repRows] of rowsByRep) {
      // Someone who has left is listed only while they hold a target or sales in the selected period.
      // Their closed trend-month rows still feed `lines`, `overall` and the pace above: only this list moves.
      if (!isListedOnTeam({ employmentStatus: statusByKey.get(key), repRows, months: monthSet })) continue;
      const repLines = buildLines(repRows);
      if (repLines.length === 0) continue;
      const repGraded = gradeRows(repRows.filter((row) => monthSet.has(row.period)).map(toGradable));
      const expectedValue = repLines.reduce(
        (sum, group) => sum + group.rows.reduce((inner, row) => inner + row.trend.expectedUnits * row.price, 0),
        0,
      );
      const targetValue = repGraded.targetValue > 0 ? repGraded.targetValue : null;
      reps.push({
        key: canonicalHrIdForDisplay(key) ?? key,
        name: personName(key),
        targetValue,
        gradedValue: repGraded.gradedValue,
        expectedValue,
        expectedAchievement: achievementOf(repGraded.gradedValue, expectedValue, targetValue),
        // The rep's Sato half at pace — the companion to the total half above (engine.ts rule 7).
        pediaSato: teamRowSatoHalf({ repLines, semester: periodSemester, satoProductNames }),
        savedPlans: [],
      });
    }
    reps.sort((a, b) => a.name.localeCompare(b.name));
  }

  const planOwners = viewingRep ? [viewingRep.key] : [ownerKey ?? "", ...reps.map((rep) => rep.key)];
  // A non-team viewer's list is `[ownerKey ?? ""]` exactly — `viewingRep` and `reps` are team-only —
  // which is the read already made above; a team viewer's needs his reps, so it is made here.
  const ownPlans = await ownPlansLoad;
  const storedPlans = ownPlans ? ownPlans.plans : await listPlansForOwners(planOwners, periodKind, periodKey);
  const plansAvailable = storedPlans !== null;
  const plansByOwner = new Map<string, SavedPlanSummary[]>();
  for (const plan of storedPlans ?? []) {
    const bucket = plansByOwner.get(plan.ownerKey) ?? [];
    bucket.push(stripOwner(plan));
    plansByOwner.set(plan.ownerKey, bucket);
  }
  for (const rep of reps) rep.savedPlans = plansByOwner.get(rep.key) ?? [];

  return {
    ...shell,
    isEmptyScope: lines.length === 0,
    viewingRep,
    plansAvailable,
    bricksAvailable,
    canSave: plansAvailable && !viewingRep && Boolean(ownerKey) && lines.some((group) => group.remainingMonths > 0),
    lines,
    totals: {
      targetValue: overall.targetValue > 0 ? overall.targetValue : null,
      gradedValue: overall.gradedValue,
      actualValue: overall.actualValue,
    },
    reps,
    plans: plansByOwner.get(viewingRep ? viewingRep.key : (ownerKey ?? "")) ?? [],
  };
}
