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
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import {
  SALES_LINES,
  lineName,
  loadEmployeeNameMap,
  loadProductFamilyMap,
  loadProductNameMap,
  loadProductPriceMap,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import {
  isRowPublished,
  loadAchievementRange,
  loadPublishedPeriodKeys,
  salesVsTargetPeriods,
} from "@/lib/sales/vs-target";
import {
  MAKE_IT_HAPPEN_FLOOR,
  achievementOf,
  gradeRows,
  isPeriodKind,
  monthLabel,
  offeredPeriods,
  periodKeyOf,
  periodLabel,
  periodMonths,
  readTrend,
  shiftMonth,
  type ConcentrationPlanRow,
  type GradableRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
  type PeriodKind,
  type RepPlanSummary,
  type SavedPlanSummary,
} from "@/lib/sales/make-it-happen/engine";
import { listPlansForOwners, type StoredPlan } from "@/lib/sales/make-it-happen/plan-store";
import {
  applyMakeItHappenBound,
  isTeamBound,
  resolveMakeItHappenBound,
} from "@/lib/sales/make-it-happen/scope";

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

  const bound = await resolveMakeItHappenBound(ctx);
  const ownerKey = canonicalHrIdForDisplay(ctx.hrId);

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
    lines: [],
    totals: { targetValue: null, gradedValue: 0, actualValue: 0 },
    reps: [],
    plans: [],
  };
  if (bound.rows.kind === "none") return shell;

  const [rawRows, publishedKeys, productNames, prices, families, employeeNames] = await Promise.all([
    loadAchievementRange(MAKE_IT_HAPPEN_FLOOR, rangeTo),
    loadPublishedPeriodKeys(MAKE_IT_HAPPEN_FLOOR, rangeTo),
    loadProductNameMap(),
    loadProductPriceMap(),
    loadProductFamilyMap(),
    loadEmployeeNameMap(),
  ]);

  const namesByKey = new Map<string, string>();
  for (const [hrId, name] of employeeNames) {
    const key = canonicalHrIdKey(hrId);
    if (key) namesByKey.set(key, name);
  }
  const personName = (hrId: string | null | undefined) =>
    namesByKey.get(canonicalHrIdKey(hrId) ?? "") ?? "Unnamed employee";

  let rows = applyMakeItHappenBound(applyAchievementAreaMerges(rawRows), bound);
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

  const monthSet = new Set(months);
  const toGradable = (row: AchievementRow): GradableRow => ({
    period: row.period,
    closed: isRowPublished(row, publishedKeys),
    actualUnits: row.actualUnits,
    actualValue: row.actualValue,
    targetUnits: row.targetUnits,
    targetValue: row.targetValue,
  });

  const buildLines = (scopeRows: AchievementRow[]): LinePlanGroup[] => {
    const groups: LinePlanGroup[] = [];
    for (const line of SALES_LINES) {
      const lineRows = scopeRows.filter((row) => row.lineCode === line.code);
      if (lineRows.length === 0) continue;
      const historyMonths = historyMonthsByLine.get(line.code) ?? [];
      const historySet = new Set(historyMonths);
      const openMonths = months.filter((month) => !publishedKeys.has(`${line.code}|${month}`));
      const closedMonths = months.filter((month) => publishedKeys.has(`${line.code}|${month}`));
      const periodRows = lineRows.filter((row) => monthSet.has(row.period));

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
          price: prices.get(code) ?? 0,
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
        });
      }
      if (concentrations.length === 0) continue;
      concentrations.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));

      const lineGraded = gradeRows(periodRows.map(toGradable));
      groups.push({
        lineCode: line.code,
        lineName: lineName(line.code),
        remainingMonths: openMonths.length,
        closedMonthLabels: closedMonths.map((month) => monthLabel(month, true)),
        forecastMonthLabels: openMonths.map((month) => monthLabel(month, true)),
        targetValue: lineGraded.targetValue > 0 ? lineGraded.targetValue : null,
        gradedValue: lineGraded.gradedValue,
        actualValue: lineGraded.actualValue,
        rows: concentrations,
      });
    }
    return groups;
  };

  const lines = buildLines(rows);
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
        savedPlans: [],
      });
    }
    reps.sort((a, b) => a.name.localeCompare(b.name));
  }

  const planOwners = viewingRep ? [viewingRep.key] : [ownerKey ?? "", ...reps.map((rep) => rep.key)];
  const storedPlans = await listPlansForOwners(planOwners, periodKind, periodKey);
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
