import type {
  CoachingPerformanceZone,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

/*
 * Pure, server-safe builders that turn coaching summary rows into the small
 * insight widgets rendered on the Training Manager landing page (monthly score
 * trend, coaching-quality radar, previous-month top scores). Kept out of the
 * heavy client analytics component so the landing page stays a server component.
 */

const monthShortNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// A report only counts once submitted (draft scores are still in flux). Mirrors
// the completed-status set used by the coaching analytics list.
const completedStatuses = new Set<CoachingReportStatus>(["submitted", "reviewed_by_employee", "locked"]);

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Score → tone color, mirroring getScoreColor in the coaching analytics list. */
export function getCoachingScoreColor(score: number): string {
  if (score >= 90) return "#0369a1";
  if (score >= 80) return "#059669";
  if (score >= 65) return "#d97706";
  if (score >= 50) return "#dc2626";
  return "#b91c1c";
}

const zoneShortLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Critical",
  excellence_zone: "Excellence",
  green_zone: "Green",
  red_zone: "Red",
  yellow_zone: "Yellow",
};

/** Short, human label for a coaching performance zone. */
export function coachingZoneLabel(zone: CoachingPerformanceZone | null): string {
  if (!zone) return "Not scored";
  return zoneShortLabels[zone] ?? zone;
}

/* ── Monthly score trend ─────────────────────────────────────────────── */

export type CoachingScoreTrendPoint = {
  avg: number;
  count: number;
  label: string;
};

/**
 * Aggregate coaching reports into a month-by-month average-score trend.
 * Returns [] when there are fewer than two months of completed reports.
 */
export function buildMonthlyCoachingScoreTrend(
  reports: CoachingReportSummaryRow[],
): CoachingScoreTrendPoint[] {
  const completed = reports
    .filter((report) => completedStatuses.has(report.status) && report.coachingDate)
    .sort((a, b) => a.coachingDate.localeCompare(b.coachingDate));

  if (completed.length < 2) return [];

  const monthMap = new Map<string, number[]>();
  for (const report of completed) {
    const key = report.coachingDate.slice(0, 7); // YYYY-MM
    const scores = monthMap.get(key) ?? [];
    scores.push(report.finalScorePercent);
    monthMap.set(key, scores);
  }

  const points = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, scores]) => {
      const avg = round2(scores.reduce((sum, value) => sum + value, 0) / scores.length);
      const [year, month] = key.split("-");
      const label = `${monthShortNames[Number(month) - 1] ?? month} ${year}`;
      return { avg, count: scores.length, label };
    });

  // Need at least two distinct months for a meaningful trend line.
  return points.length >= 2 ? points : [];
}

/* ── Coaching quality overview (radar) ───────────────────────────────── */

export type CoachingQualityRadarPoint = {
  dimension: string;
  fullMark: number;
  value: number;
};

/**
 * Coaching-quality radar. Summary rows have no per-category breakdown, so this
 * mirrors the analytics list's proxy-metric radar: average score, consistency,
 * completion, acknowledgment, and recent-trend. Returns [] with no completed
 * reports.
 */
export function buildCoachingQualityRadar(
  reports: CoachingReportSummaryRow[],
): CoachingQualityRadarPoint[] {
  const completed = reports.filter(
    (report) => completedStatuses.has(report.status) && report.finalScorePercent > 0,
  );
  if (completed.length === 0) return [];

  const scores = completed.map((report) => report.finalScorePercent);
  const avgScore = round2(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  const consistency = completed.length > 1
    ? round2(100 - (Math.max(...scores) - Math.min(...scores)))
    : avgScore;
  const completionRate = round2((completed.length / Math.max(reports.length, 1)) * 100);
  const ackRate = round2(
    (completed.filter((report) => report.acknowledged).length / Math.max(completed.length, 1)) * 100,
  );
  const recentTrend = (() => {
    const sorted = [...completed].sort((a, b) => b.coachingDate.localeCompare(a.coachingDate));
    if (sorted.length < 2) return avgScore;
    const recent = sorted.slice(0, Math.ceil(sorted.length / 2));
    return round2(recent.reduce((sum, report) => sum + report.finalScorePercent, 0) / recent.length);
  })();

  return [
    { dimension: "Avg Score", fullMark: 100, value: avgScore },
    { dimension: "Consistency", fullMark: 100, value: Math.max(0, consistency) },
    { dimension: "Completion", fullMark: 100, value: completionRate },
    { dimension: "Acknowledgment", fullMark: 100, value: ackRate },
    { dimension: "Recent Trend", fullMark: 100, value: recentTrend },
  ];
}

/* ── Previous-month top coaching scores ──────────────────────────────── */

export type CoachingTopScoreEntry = {
  coachName: string;
  finalScorePercent: number;
  medicalRepHrId: string;
  medicalRepName: string;
  performanceZone: CoachingPerformanceZone | null;
  rank: number;
  reportId: string;
};

/**
 * Rank the highest-scoring completed coaching reports (highest score first) and
 * return the top `limit`. Feed it a single month's reports to get that month's
 * leaderboard; the caller decides the window (e.g. the previous calendar month).
 *
 * `excludeHrIds` removes reps BEFORE the slice, so a leaver's slot is filled by the next
 * score down and the board still shows `limit` names (owner, 2026-10-24: Stars of the Month
 * skips a resigned rep and takes the one after him).
 */
export function buildTopCoachingScores(
  reports: CoachingReportSummaryRow[],
  limit = 5,
  excludeHrIds: ReadonlySet<string> = new Set(),
): CoachingTopScoreEntry[] {
  return reports
    .filter(
      (report) =>
        completedStatuses.has(report.status) &&
        report.finalScorePercent > 0 &&
        !excludeHrIds.has(report.medicalRepHrId.toUpperCase()),
    )
    .sort(
      (a, b) =>
        b.finalScorePercent - a.finalScorePercent ||
        a.coachingDate.localeCompare(b.coachingDate),
    )
    .slice(0, limit)
    .map((report, index) => ({
      coachName: formatEmployeeDisplayName(report.coachName) || report.coachHrId,
      finalScorePercent: report.finalScorePercent,
      medicalRepHrId: report.medicalRepHrId,
      medicalRepName: formatEmployeeDisplayName(report.medicalRepName) || report.medicalRepHrId,
      performanceZone: report.performanceZone,
      rank: index + 1,
      reportId: report.reportId,
    }));
}
