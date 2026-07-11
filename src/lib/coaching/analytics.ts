import {
  coachingMaxItemScore,
  coachingParameterLabels,
  type CoachingParameterKey,
  type CoachingScoreItemKey,
} from "./constants.ts";
import { canonicalHrIdKey } from "../hr-id.ts";
import type { EmployeeDirectoryRow } from "../employees/employee-directory.ts";
import { resolveJobFunctionRole } from "../employees/job-function.ts";
import type {
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
  CoachingParameterDistributionRow,
  CoachingScoreAnalytics,
  CoachingTrainingManagerAreaComparisonRow,
  CoachingTrainingManagerCoachingMonthComparisonRow,
  CoachingTrainingManagerComparison,
  CoachingTrainingManagerComparisonBucket,
  CoachingTrainingManagerComparisonRow,
} from "./types.ts";

export type CoachingScoreAnalyticsInputRow = {
  parameter_category: CoachingParameterKey;
  report_id: string;
  score: number | string;
  score_item_key: CoachingScoreItemKey;
  score_item_label: string;
};

type ScoreBucket = {
  category: CoachingParameterKey;
  itemKey?: CoachingScoreItemKey;
  itemLabel?: string;
  reports: Set<string>;
  scoreCount: number;
  totalScore: number;
};

export type CoachingTrainingManagerComparisonFilters = {
  areaId?: number | string | null;
  lineId?: number | string | null;
  medicalRepHrId?: string | null;
  teamId?: number | string | null;
};

type TrainingManagerComparisonInput = {
  employees: EmployeeDirectoryRow[];
  filters?: CoachingTrainingManagerComparisonFilters;
  reports: CoachingReportSummaryRow[];
};

function round(value: number, fractionDigits = 2) {
  return Number(value.toFixed(fractionDigits));
}

function average(total: number, count: number) {
  if (count === 0) return 0;
  return round(total / count);
}

// Exported so every coaching analytics surface shares one definition of "completed" instead of
// each independently re-declaring the same status set (audit finding M14).
export const completedReportStatuses = new Set(["submitted", "reviewed_by_employee", "locked"]);
const coachingMonthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type CoachingReportAnalyticsSummary = {
  averageScore: number;
  bestScore: number;
  coachingCount: number;
  draftCount: number;
  latestReport: CoachingReportSummaryRow | null;
  lowestScore: number;
  pendingAcknowledgmentCount: number;
  zoneCounts: Record<string, number>;
};

function averageValues(values: number[]) {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function scoreAverageOrNull(values: number[]) {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 1);
}

function percent(part: number, total: number) {
  return total > 0 ? round((part / total) * 100, 1) : 0;
}

function sortedLabels(left: string, right: string) {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function matchesIdFilter(employeeId: number | null, filterValue: number | string | null | undefined) {
  const raw = String(filterValue ?? "").trim();
  if (!raw) return true;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && employeeId === numeric;
}

function isActiveMedicalRep(employee: EmployeeDirectoryRow) {
  const status = String(employee.employmentStatus ?? "active").trim().toLowerCase();
  const isActive = status === "" || status === "active" || status === "on_leave";
  if (!isActive || employee.organogramVisible === false) return false;
  return (
    resolveJobFunctionRole(employee.positionTitle) === "Medical Rep" ||
    resolveJobFunctionRole(employee.jobTitle) === "Medical Rep"
  );
}

function employeeMatchesComparisonFilters(
  employee: EmployeeDirectoryRow,
  filters: CoachingTrainingManagerComparisonFilters,
) {
  const medicalRepFilter = canonicalHrIdKey(filters.medicalRepHrId);
  return (
    matchesIdFilter(employee.areaId, filters.areaId) &&
    matchesIdFilter(employee.lineId, filters.lineId) &&
    matchesIdFilter(employee.teamId, filters.teamId) &&
    (!medicalRepFilter || canonicalHrIdKey(employee.hrId) === medicalRepFilter)
  );
}

function bucketCounts(rows: CoachingTrainingManagerComparisonRow[]): CoachingTrainingManagerComparisonBucket {
  const coachedCount = rows.filter((row) => row.status === "coached").length;
  const totalReps = rows.length;
  return {
    coachedCount,
    coachedRate: percent(coachedCount, totalReps),
    label: "",
    totalReps,
    uncoachedCount: totalReps - coachedCount,
  };
}

function buildAreaBreakdown(
  rows: CoachingTrainingManagerComparisonRow[],
): CoachingTrainingManagerAreaComparisonRow[] {
  const buckets = new Map<string, CoachingTrainingManagerComparisonRow[]>();
  for (const row of rows) {
    const key = row.areaId === null ? "none" : String(row.areaId);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.values()]
    .map((bucketRows) => {
      const first = bucketRows[0];
      const counts = bucketCounts(bucketRows);
      const label = first.areaName || "Not assigned";
      return {
        ...counts,
        areaId: first.areaId,
        areaName: first.areaName,
        label,
      };
    })
    .sort((left, right) => right.totalReps - left.totalReps || sortedLabels(left.label, right.label));
}

function coachingMonthFromReport(report: CoachingReportSummaryRow) {
  const parsedMonth = Number(report.coachingDate.slice(5, 7));
  if (Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) return parsedMonth;
  return Number.isInteger(report.coachingMonth) && report.coachingMonth >= 1 && report.coachingMonth <= 12
    ? report.coachingMonth
    : null;
}

function buildCoachingMonthBreakdown(
  rows: CoachingTrainingManagerComparisonRow[],
  completedReportsByRep: Map<string, CoachingReportSummaryRow[]>,
): CoachingTrainingManagerCoachingMonthComparisonRow[] {
  const eligibleRepKeys = rows.reduce<string[]>((keys, row) => {
    const key = canonicalHrIdKey(row.hrId);
    if (key) keys.push(key);
    return keys;
  }, []);
  const coachedRepKeysByMonth = new Map<number, Set<string>>();

  for (const repKey of eligibleRepKeys) {
    for (const report of completedReportsByRep.get(repKey) ?? []) {
      const month = coachingMonthFromReport(report);
      if (month === null) continue;
      const repKeys = coachedRepKeysByMonth.get(month) ?? new Set<string>();
      repKeys.add(repKey);
      coachedRepKeysByMonth.set(month, repKeys);
    }
  }

  const totalReps = rows.length;
  return coachingMonthLabels
    .map((label, index) => {
      const coachingMonth = index + 1;
      const coachedCount = coachedRepKeysByMonth.get(coachingMonth)?.size ?? 0;
      return {
        coachedCount,
        coachedRate: percent(coachedCount, totalReps),
        coachingMonth,
        label,
        totalReps,
        uncoachedCount: Math.max(totalReps - coachedCount, 0),
      };
    })
    .filter((row) => row.coachedCount > 0);
}

export function buildTrainingManagerCoachingComparison({
  employees,
  filters = {},
  reports,
}: TrainingManagerComparisonInput): CoachingTrainingManagerComparison {
  const completedReportsByRep = new Map<string, CoachingReportSummaryRow[]>();
  for (const report of reports.filter((row) => completedReportStatuses.has(row.status))) {
    const key = canonicalHrIdKey(report.medicalRepHrId);
    if (!key) continue;
    completedReportsByRep.set(key, [...(completedReportsByRep.get(key) ?? []), report]);
  }

  const rows = employees
    .filter(isActiveMedicalRep)
    .filter((employee) => employeeMatchesComparisonFilters(employee, filters))
    .map((employee): CoachingTrainingManagerComparisonRow => {
      const hrIdKey = canonicalHrIdKey(employee.hrId);
      const employeeReports = hrIdKey ? completedReportsByRep.get(hrIdKey) ?? [] : [];
      const orderedReports = [...employeeReports].sort((left, right) => left.coachingDate.localeCompare(right.coachingDate));
      const latestReport = orderedReports[orderedReports.length - 1] ?? null;
      const scores = orderedReports.map((report) => report.finalScorePercent).filter(Number.isFinite);
      const coachNames = [...new Set(orderedReports.map((report) => report.coachName || report.coachHrId).filter(Boolean))];

      return {
        areaId: employee.areaId,
        areaName: employee.areaName,
        averageScore: scoreAverageOrNull(scores),
        coachNames,
        coachingCount: orderedReports.length,
        firstCoachingDate: orderedReports[0]?.coachingDate ?? null,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        latestCoachName: latestReport ? latestReport.coachName || latestReport.coachHrId : null,
        latestCoachingDate: latestReport?.coachingDate ?? null,
        lineId: employee.lineId,
        lineName: employee.lineName,
        medicalRepName: employee.displayName || employee.hrId,
        status: orderedReports.length > 0 ? "coached" : "not_coached",
        teamId: employee.teamId,
        teamName: employee.teamName,
      };
    })
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "not_coached" ? -1 : 1;
      return (
        sortedLabels(left.areaName || "Not assigned", right.areaName || "Not assigned") ||
        String(left.hireDate ?? "9999-99-99").localeCompare(String(right.hireDate ?? "9999-99-99")) ||
        sortedLabels(left.medicalRepName, right.medicalRepName)
      );
    });

  const coachedCount = rows.filter((row) => row.status === "coached").length;
  const totalMedicalReps = rows.length;

  return {
    areaBreakdown: buildAreaBreakdown(rows),
    coachedCount,
    coachedRate: percent(coachedCount, totalMedicalReps),
    coachingMonthBreakdown: buildCoachingMonthBreakdown(rows, completedReportsByRep),
    rows,
    totalMedicalReps,
    uncoachedCount: totalMedicalReps - coachedCount,
  };
}

export function buildCoachingReportAnalytics(
  reports: CoachingReportSummaryRow[],
): CoachingReportAnalyticsSummary {
  const completed = reports.filter((report) => completedReportStatuses.has(report.status));
  const scores = completed.map((report) => report.finalScorePercent).filter(Number.isFinite);
  const zoneCounts = completed.reduce<Record<string, number>>((accumulator, report) => {
    const zone = report.performanceZone ?? "unclassified";
    accumulator[zone] = (accumulator[zone] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    averageScore: averageValues(scores),
    bestScore: scores.length ? Math.max(...scores) : 0,
    coachingCount: completed.length,
    draftCount: reports.filter((report) => report.status === "draft").length,
    latestReport: completed[0] ?? null,
    lowestScore: scores.length ? Math.min(...scores) : 0,
    pendingAcknowledgmentCount: completed.filter((report) => report.status === "submitted" && !report.acknowledged).length,
    zoneCounts,
  };
}

export function filterCoachingQuarterlySummaryByReports(
  quarterlySummary: CoachingQuarterlySummaryRow[],
  reports: CoachingReportSummaryRow[],
  shouldFilter: boolean,
) {
  if (!shouldFilter) return quarterlySummary;
  const visibleHrIds = new Set(reports.map((report) => report.medicalRepHrId.trim().toLowerCase()));
  return quarterlySummary.filter((row) => visibleHrIds.has(row.medicalRepHrId.trim().toLowerCase()));
}

function averagePercent(score: number) {
  return round((score / coachingMaxItemScore) * 100);
}

function categoryLabel(category: CoachingParameterKey) {
  return coachingParameterLabels[category] ?? category.replace(/_/g, " ");
}

function createBucket(category: CoachingParameterKey, itemKey?: CoachingScoreItemKey, itemLabel?: string): ScoreBucket {
  return {
    category,
    itemKey,
    itemLabel,
    reports: new Set<string>(),
    scoreCount: 0,
    totalScore: 0,
  };
}

function incrementDistribution(
  distribution: Map<CoachingParameterKey, number>,
  category: CoachingParameterKey,
) {
  distribution.set(category, (distribution.get(category) ?? 0) + 1);
}

function mapDistribution(
  distribution: Map<CoachingParameterKey, number>,
  denominator: number,
): CoachingParameterDistributionRow[] {
  return [...distribution.entries()]
    .map(([parameterCategory, count]) => ({
      count,
      parameterCategory,
      parameterKey: parameterCategory,
      parameterLabel: categoryLabel(parameterCategory),
      percent: denominator > 0 ? round((count / denominator) * 100) : 0,
    }))
    .sort((left, right) => right.count - left.count || left.parameterLabel.localeCompare(right.parameterLabel));
}

export function buildCoachingScoreAnalytics(
  rows: CoachingScoreAnalyticsInputRow[],
): CoachingScoreAnalytics {
  const categoryBuckets = new Map<CoachingParameterKey, ScoreBucket>();
  const itemBuckets = new Map<string, ScoreBucket>();
  const reportCategoryBuckets = new Map<string, Map<CoachingParameterKey, ScoreBucket>>();

  for (const row of rows) {
    const score = Number(row.score);
    if (!row.report_id || !Number.isFinite(score)) continue;

    const category = row.parameter_category;
    const categoryBucket = categoryBuckets.get(category) ?? createBucket(category);
    categoryBucket.scoreCount += 1;
    categoryBucket.totalScore += score;
    categoryBucket.reports.add(row.report_id);
    categoryBuckets.set(category, categoryBucket);

    const itemKey = `${category}:${row.score_item_key}`;
    const itemBucket = itemBuckets.get(itemKey) ?? createBucket(category, row.score_item_key, row.score_item_label);
    itemBucket.scoreCount += 1;
    itemBucket.totalScore += score;
    itemBucket.reports.add(row.report_id);
    itemBuckets.set(itemKey, itemBucket);

    const reportBuckets = reportCategoryBuckets.get(row.report_id) ?? new Map<CoachingParameterKey, ScoreBucket>();
    const reportCategoryBucket = reportBuckets.get(category) ?? createBucket(category);
    reportCategoryBucket.scoreCount += 1;
    reportCategoryBucket.totalScore += score;
    reportCategoryBucket.reports.add(row.report_id);
    reportBuckets.set(category, reportCategoryBucket);
    reportCategoryBuckets.set(row.report_id, reportBuckets);
  }

  const strongestDistribution = new Map<CoachingParameterKey, number>();
  const keyDevelopmentAreaDistribution = new Map<CoachingParameterKey, number>();

  for (const reportBuckets of reportCategoryBuckets.values()) {
    const categoryAverages = [...reportBuckets.values()].map((bucket) => ({
      averageScore: average(bucket.totalScore, bucket.scoreCount),
      category: bucket.category,
    }));
    if (categoryAverages.length === 0) continue;

    const strongest = [...categoryAverages].sort(
      (left, right) => right.averageScore - left.averageScore || categoryLabel(left.category).localeCompare(categoryLabel(right.category)),
    )[0];
    const keyDevelopment = [...categoryAverages].sort(
      (left, right) => left.averageScore - right.averageScore || categoryLabel(left.category).localeCompare(categoryLabel(right.category)),
    )[0];

    incrementDistribution(strongestDistribution, strongest.category);
    incrementDistribution(keyDevelopmentAreaDistribution, keyDevelopment.category);
  }

  const categoryAverageScores = [...categoryBuckets.values()]
    .map((bucket) => {
      const averageScore = average(bucket.totalScore, bucket.scoreCount);
      return {
        averagePercent: averagePercent(averageScore),
        averageScore,
        parameterCategory: bucket.category,
        parameterKey: bucket.category,
        parameterLabel: categoryLabel(bucket.category),
        reportCount: bucket.reports.size,
        scoreCount: bucket.scoreCount,
      };
    })
    .sort((left, right) => right.averageScore - left.averageScore || left.parameterLabel.localeCompare(right.parameterLabel));

  const scoreItemAverageScores = [...itemBuckets.values()]
    .map((bucket) => {
      const averageScore = average(bucket.totalScore, bucket.scoreCount);
      return {
        averagePercent: averagePercent(averageScore),
        averageScore,
        parameterCategory: bucket.category,
        parameterKey: bucket.category,
        parameterLabel: categoryLabel(bucket.category),
        reportCount: bucket.reports.size,
        scoreCount: bucket.scoreCount,
        scoreItemKey: bucket.itemKey as CoachingScoreItemKey,
        scoreItemLabel: bucket.itemLabel ?? bucket.itemKey ?? "",
      };
    })
    .sort((left, right) => left.averageScore - right.averageScore || left.scoreItemLabel.localeCompare(right.scoreItemLabel));

  const reportCount = reportCategoryBuckets.size;

  return {
    categoryAverageScores,
    keyDevelopmentAreaDistribution: mapDistribution(keyDevelopmentAreaDistribution, reportCount),
    scoreItemAverageScores,
    strongestParameterDistribution: mapDistribution(strongestDistribution, reportCount),
  };
}

export const emptyCoachingScoreAnalytics: CoachingScoreAnalytics = {
  categoryAverageScores: [],
  keyDevelopmentAreaDistribution: [],
  scoreItemAverageScores: [],
  strongestParameterDistribution: [],
};
