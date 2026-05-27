"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Award,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RadarChart } from "@/components/charts/radar-chart";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  coachingMaxScore,
  coachingParameterLabels,
  coachingScoreItems,
  type CoachingParameterKey,
  type CoachingScoreItemKey,
} from "@/lib/coaching/constants";
import type {
  CoachingPerformanceZone,
  CoachingReportDetail,
  CoachingScoreItemRow,
} from "@/lib/coaching/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

/* ━━━━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

type EmployeeCoachingReviewProps = {
  allowAcknowledgment?: boolean;
  initialDetail: CoachingReportDetail;
};

type ApiResponse<T> = {
  data?: T;
  error?: string;
  message?: string;
};

type FormMessage = {
  text: string;
  tone: "danger" | "success";
};

/* ━━━━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const acknowledgmentText = "I acknowledge and submit this coaching report review.";

const categoryOrder: CoachingParameterKey[] = [
  "knowledge",
  "call_structure_skills",
  "business_intelligence",
  "business_planning",
  "personal_skills",
];

const categoryLetters: Record<CoachingParameterKey, string> = {
  business_intelligence: "C",
  business_planning: "D",
  call_structure_skills: "B",
  knowledge: "A",
  personal_skills: "E",
};

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

const zoneClassNames: Record<CoachingPerformanceZone, string> = {
  critical_red: "border-rose-200 bg-rose-50 text-rose-700",
  excellence_zone: "border-sky-200 bg-sky-50 text-sky-700",
  green_zone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red_zone: "border-rose-200 bg-rose-50 text-rose-700",
  yellow_zone: "border-amber-200 bg-amber-50 text-amber-700",
};

const printStyles = `
@media print {
  nav, header, aside, footer, .no-print { display: none !important; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 11px; }
  .coaching-review-print * { break-inside: avoid; }
  .coaching-review-print .recharts-responsive-container { height: 200px !important; }
}
`;

/* ━━━━━━━━━━━━━━━━━━ Utilities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatScore(value: number | string | null | undefined) {
  const score = Number(value ?? 0);
  return Number.isFinite(score) ? score.toFixed(0) : "0";
}

function formatPercent(value: number | string | null | undefined) {
  const percent = Number(value ?? 0);
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "0.0%";
}

function scoreMap(scores: CoachingScoreItemRow[]) {
  return new Map<CoachingScoreItemKey, CoachingScoreItemRow>(
    scores.map((score) => [score.score_item_key, score]),
  );
}

function groupScoreItems() {
  return categoryOrder.map((category) => ({
    category,
    items: coachingScoreItems.filter((item) => item.category === category),
    label: coachingParameterLabels[category],
  }));
}

function zoneLabel(zone: string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

function zoneClassName(zone: string | null | undefined) {
  if (!zone || !(zone in zoneClassNames)) return "border-slate-200 bg-slate-50 text-slate-600";
  return zoneClassNames[zone as CoachingPerformanceZone];
}

/** Color-grading for individual score items (1-6 scale). */
function scoreColorClass(score: number | null | undefined): string {
  const s = Number(score ?? 0);
  if (s >= 6) return "border-sky-200 bg-sky-50 text-sky-700 ring-sky-100";
  if (s >= 5) return "border-emerald-200 bg-emerald-50 text-emerald-700 ring-emerald-100";
  if (s >= 4) return "border-amber-200 bg-amber-50 text-amber-700 ring-amber-100";
  if (s >= 3) return "border-orange-200 bg-orange-50 text-orange-700 ring-orange-100";
  return "border-rose-200 bg-rose-50 text-rose-700 ring-rose-100";
}

/** Color-grading for category subtotal percent. */
function categoryColorClass(percent: number): string {
  if (percent >= 90) return "border-sky-200 bg-sky-50 text-sky-700";
  if (percent >= 75) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (percent >= 60) return "border-amber-200 bg-amber-50 text-amber-700";
  if (percent >= 50) return "border-orange-200 bg-orange-50 text-orange-700";
  return "border-rose-200 bg-rose-50 text-rose-700";
}

/** Color for distribution bar segments. */
function distributionSegmentColor(score: number): string {
  if (score >= 6) return "bg-sky-500";
  if (score >= 5) return "bg-emerald-500";
  if (score >= 4) return "bg-amber-400";
  if (score >= 3) return "bg-orange-400";
  return "bg-rose-500";
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as ApiResponse<T>;
  if (!response.ok) {
    const error = payload.error;
    if (response.status === 403 || error === "forbidden") {
      throw new Error("You are not authorized to acknowledge this coaching report.");
    }
    if (response.status === 409 || error === "conflict") {
      throw new Error("This coaching report has already been acknowledged or is no longer open for acknowledgment.");
    }
    throw new Error("Unable to submit acknowledgment. Please try again later.");
  }
  if (!payload.data) {
    throw new Error("Unable to refresh the coaching report after acknowledgment.");
  }
  return payload.data;
}

/* ━━━━━━━━━━━━━━━━━━ Skeleton Loader ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function SkeletonPulse({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-slate-200", className)} />;
}

function CoachingReviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded border border-slate-200 bg-white">
        <div className="bg-slate-900 px-5 py-6">
          <SkeletonPulse className="h-5 w-28 bg-slate-700" />
          <SkeletonPulse className="mt-4 h-8 w-56 bg-slate-700" />
          <SkeletonPulse className="mt-2 h-4 w-80 bg-slate-700" />
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonPulse className="h-14 w-full" key={i} />
          ))}
        </div>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <SkeletonPulse className="h-36 w-full" />
        <SkeletonPulse className="h-36 w-full" />
      </div>
      <SkeletonPulse className="h-60 w-full" />
      <SkeletonPulse className="h-96 w-full" />
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Sub-components ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-100 bg-slate-50/90 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}

function FeedbackBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <Card className="rounded border border-slate-200/80 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">{label}</p>
      <p className="mt-2 break-words whitespace-pre-wrap text-sm leading-7 text-slate-700 sm:mt-3">
        {text?.trim() || "No feedback was provided."}
      </p>
    </Card>
  );
}

function ScoreItemNotes({ score }: { score: CoachingScoreItemRow | undefined }) {
  const area = score?.area_to_be_improved?.trim();
  const strength = score?.strength_point?.trim();
  if (!area && !strength) return null;

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {area ? (
        <div className="rounded border border-orange-100 bg-orange-50/70 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-700">Area to be Improved</p>
          <p className="mt-1 break-words whitespace-pre-wrap text-xs font-semibold leading-5 text-orange-950">{area}</p>
        </div>
      ) : null}
      {strength ? (
        <div className="rounded border border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">Strength Point</p>
          <p className="mt-1 break-words whitespace-pre-wrap text-xs font-semibold leading-5 text-emerald-950">{strength}</p>
        </div>
      ) : null}
    </div>
  );
}

function ScoreDistributionBar({ scores }: { scores: CoachingScoreItemRow[] }) {
  const distribution = [6, 5, 4, 3, 2, 1].map((s) => ({
    count: scores.filter((item) => item.score === s).length,
    score: s,
  }));
  const total = scores.length || 1;

  return (
    <div aria-label={`Score distribution: ${distribution.filter((d) => d.count > 0).map((d) => `${d.score}/6: ${d.count}`).join(", ")}`} role="img">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Score distribution</p>
      <div className="mt-2 flex h-6 w-full overflow-hidden rounded">
        {distribution.map((d) =>
          d.count > 0 ? (
            <div
              className={cn("flex items-center justify-center text-[10px] font-bold text-white", distributionSegmentColor(d.score))}
              key={d.score}
              style={{ width: `${(d.count / total) * 100}%` }}
              title={`Score ${d.score}: ${d.count} item${d.count > 1 ? "s" : ""}`}
            >
              {d.count}
            </div>
          ) : null,
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3">
        {distribution.map((d) =>
          d.count > 0 ? (
            <span className="flex items-center gap-1 text-[10px] text-slate-500" key={d.score}>
              <span className={cn("inline-block h-2 w-2 rounded-sm", distributionSegmentColor(d.score))} />
              {d.score}/6: {d.count}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Hero Header ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function ReviewHeroHeader({
  coachHrId,
  coachName,
  coachRole,
  coachingDate,
  displayZone,
  reportNumber,
  status,
}: {
  coachHrId: string;
  coachName: string | null | undefined;
  coachRole: string | null;
  coachingDate: string | null | undefined;
  displayZone: string | null;
  reportNumber: string;
  status: string;
}) {
  return (
    <Card className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_4px_24px_rgba(15,23,42,0.08)]">
      <div className="relative overflow-hidden bg-[linear-gradient(135deg,#0B0B0B_0%,#111827_58%,#3B2413_100%)] px-4 py-5 text-white sm:px-7 sm:py-6">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="relative grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <p className="inline-flex rounded border border-orange-400/40 bg-orange-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-orange-200">
              {reportNumber}
            </p>
            <h2 className="mt-3 text-2xl font-black tracking-[-0.03em] text-white sm:mt-4 sm:text-3xl">
              Field Coaching Review
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-300 sm:mt-2">
              Review the structured assessment and feedback submitted by your coach.
            </p>
          </div>
          <div className={cn("rounded border px-4 py-2.5 text-sm font-bold", zoneClassName(displayZone))}>
            {zoneLabel(displayZone)}
          </div>
        </div>
      </div>

      <div className="grid gap-2 p-4 sm:grid-cols-2 sm:gap-3 sm:p-6 lg:grid-cols-4">
        <DetailPill label="Coaching date" value={formatDate(coachingDate)} />
        <DetailPill label="Coach" value={formatEmployeeDisplayName(coachName, coachHrId)} />
        <DetailPill label="Coach role" value={coachRole || "Coach"} />
        <DetailPill label="Status" value={status.replace(/_/g, " ")} />
      </div>
    </Card>
  );
}

/* ━━━━━━━━━━━━━━━━━━ Main Component ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function EmployeeCoachingReview({ allowAcknowledgment = true, initialDetail }: EmployeeCoachingReviewProps) {
  const [detail, setDetail] = useState(initialDetail);
  const [checked, setChecked] = useState(false);
  const [closedByConflict, setClosedByConflict] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const report = detail.report;
  const summary = detail.summary;
  const scoresByKey = scoreMap(detail.scores);
  const acknowledged = report.employee_acknowledged || Boolean(report.acknowledged_at);
  const canAcknowledge = allowAcknowledgment && report.status === "submitted" && !acknowledged && !closedByConflict;
  const displayZone = report.performance_zone ?? summary?.performanceZone ?? null;

  const radarData = detail.scoreResult?.categorySubtotals.map((cat) => ({
    desc: `${cat.actualScore}/${cat.maxScore} points`,
    score: Math.round(cat.percent),
    subject: cat.label,
  })) ?? [];

  const handleAcknowledge = async () => {
    if (!checked || isSubmitting || !canAcknowledge) return;

    setIsSubmitting(true);
    setMessage(null);

    try {
      const updated = await parseApiResponse<CoachingReportDetail>(
        await fetch(`/api/coaching/reports/${report.id}/acknowledge`, {
          body: JSON.stringify({ acknowledgmentText }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );
      setDetail(updated);
      setChecked(false);
      setMessage({ text: "Your coaching report acknowledgment has been submitted.", tone: "success" });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "Unable to submit acknowledgment. Please try again later.";
      if (errorText.toLowerCase().includes("already been acknowledged")) {
        setClosedByConflict(true);
        setChecked(false);
      }
      setMessage({
        text: errorText,
        tone: "danger",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!hydrated) return <CoachingReviewSkeleton />;

  return (
    <div dir="auto" className="coaching-review-print space-y-3 sm:space-y-5">
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      {/* ── Hero Header ────────────────────────────────────────────── */}
      <ReviewHeroHeader
        coachHrId={report.coach_hr_id}
        coachName={summary?.coachName}
        coachRole={report.coach_role}
        coachingDate={report.coaching_date}
        displayZone={displayZone}
        reportNumber={report.report_number}
        status={report.status}
      />

      {/* ── Employee Context + Final Score ──────────────────────────── */}
      <div className="grid gap-3 sm:gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
        <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_4px_24px_rgba(15,23,42,0.06)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">Employee context</p>
              <h3 className="mt-2 text-xl font-black tracking-[-0.03em] text-slate-900 sm:text-2xl">
                {formatEmployeeDisplayName(summary?.medicalRepName, report.medical_rep_hr_id)}
              </h3>
              <p className="mt-1 text-sm font-medium text-slate-500">HR ID: {report.medical_rep_hr_id}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded bg-orange-50 text-orange-600">
              <UserRound className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:mt-5 sm:gap-3 sm:grid-cols-3">
            <DetailPill label="Line" value={summary?.lineName || "Not assigned"} />
            <DetailPill label="Area" value={summary?.areaName || "Not assigned"} />
            <DetailPill label="Team" value={summary?.teamName || "Not assigned"} />
          </div>
        </Card>

        <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_4px_24px_rgba(15,23,42,0.06)] sm:p-6">
          <div className="flex items-start justify-between gap-3 sm:gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">Final score</p>
              <p className="mt-2 text-3xl font-black tracking-[-0.04em] text-slate-900 sm:text-4xl">
                {formatPercent(report.final_score_percent)}
              </p>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {formatScore(report.actual_score)} / {coachingMaxScore} points
              </p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded bg-slate-900 text-orange-300">
              <Award className="h-4 w-4" />
            </div>
          </div>
          {detail.scoreResult ? (
            <div className="mt-4 grid gap-2 sm:mt-5 sm:gap-3">
              <DetailPill label="Strongest parameter" value={detail.scoreResult.strongestParameter.label} />
              <DetailPill label="Key development area" value={detail.scoreResult.keyDevelopmentArea.label} />
            </div>
          ) : null}
        </Card>
      </div>

      {/* ── Category Performance Chart + Distribution ───────────────── */}
      {detail.scoreResult && radarData.length > 0 ? (
        <WorkspaceErrorBoundary fallbackTitle="Unable to render score charts">
          <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_4px_24px_rgba(15,23,42,0.06)] sm:p-6">
            <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.5fr)]">
              <div aria-label="Category performance radar chart showing percentage scores for each coaching parameter" role="img">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-orange-600" />
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">Category performance</p>
                </div>
                <RadarChart data={radarData} dataKey="score" subjectKey="subject" height={240} />
              </div>
              <div className="flex flex-col justify-between gap-4">
                <div className="grid gap-2">
                  {detail.scoreResult.categorySubtotals.map((cat) => (
                    <div className="flex items-center justify-between gap-3 rounded border border-slate-100 bg-slate-50/60 px-3 py-2" key={cat.category}>
                      <span className="text-xs font-semibold text-slate-700">{cat.label}</span>
                      <span className={cn("rounded border px-2 py-0.5 text-[11px] font-bold", categoryColorClass(cat.percent))}>
                        {Math.round(cat.percent)}%
                      </span>
                    </div>
                  ))}
                </div>
                <ScoreDistributionBar scores={detail.scores} />
              </div>
            </div>
          </Card>
        </WorkspaceErrorBoundary>
      ) : null}

      {/* ── Structured Scoring ──────────────────────────────────────── */}
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_4px_24px_rgba(15,23,42,0.06)] sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">Structured scoring</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.03em] text-slate-900 sm:text-2xl">
              20 field excellence points
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Each scoring item is rated from 1 to 6 across five coaching parameters.
            </p>
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded bg-orange-50 text-orange-600">
            <Target className="h-4 w-4" />
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:mt-6 sm:gap-4">
          {groupScoreItems().map((group) => {
            const catSub = detail.scoreResult?.categorySubtotals.find((item) => item.category === group.category);
            return (
              <div className="rounded border border-slate-200/80 bg-slate-50/70 p-3 sm:p-4" key={group.category}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded bg-slate-900 text-xs font-bold text-orange-300">
                      {categoryLetters[group.category]}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-slate-900">{group.label}</p>
                      <p className="text-[11px] font-medium text-slate-500">{group.items.length} scoring items</p>
                    </div>
                  </div>
                  {catSub ? (
                    <span className={cn("rounded border px-2.5 py-1 text-xs font-bold", categoryColorClass(catSub.percent))}>
                      {catSub.actualScore} / {catSub.maxScore}
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-1.5">
                  {group.items.map((item) => {
                    const scoreRow = scoresByKey.get(item.key);
                    const score = scoreRow?.score;
                    return (
                      <div
                        className="rounded border border-slate-200/70 bg-white px-3 py-2.5 sm:px-4 sm:py-3"
                        key={item.key}
                      >
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                          <div>
                            <p className="text-sm font-semibold text-slate-800">{item.label}</p>
                            <p className="mt-0.5 text-[11px] font-medium text-slate-400">Point {item.displayOrder}</p>
                          </div>
                          <span className={cn(
                            "inline-flex h-8 min-w-12 items-center justify-center rounded px-3 text-sm font-bold ring-1",
                            scoreColorClass(score),
                          )}>
                            {score ?? "-"} / 6
                          </span>
                        </div>
                        <ScoreItemNotes score={scoreRow} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Feedback Blocks ────────────────────────────────────────── */}
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-3">
        <FeedbackBlock label="Overall Area of Development" text={report.area_of_development} />
        <FeedbackBlock label="Overall Strength Points" text={report.strength_points} />
        <FeedbackBlock label="General Remarks" text={report.general_remarks} />
      </div>

      {/* ── Acknowledgment ─────────────────────────────────────────── */}
      <Card className="rounded border border-slate-200 bg-white p-4 shadow-[0_4px_24px_rgba(15,23,42,0.06)] sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">Acknowledgment</p>
            <h3 className="mt-2 text-xl font-black tracking-[-0.03em] text-slate-900 sm:text-2xl">
              Employee review confirmation
            </h3>
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded bg-orange-50 text-orange-600">
            <ShieldCheck className="h-4 w-4" />
          </div>
        </div>

        {acknowledged || closedByConflict ? (
          <div className="mt-5 rounded border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5" />
              <p className="text-sm font-bold">
                {report.acknowledged_at
                  ? `Acknowledged on ${formatDateTime(report.acknowledged_at)}.`
                  : "This report has already been acknowledged."}
              </p>
            </div>
          </div>
        ) : canAcknowledge ? (
          <div className="mt-5 space-y-4">
            <label className="flex gap-3 rounded border border-slate-200 bg-slate-50/80 p-4">
              <input
                checked={checked}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                disabled={isSubmitting}
                onChange={(event) => setChecked(event.target.checked)}
                type="checkbox"
              />
              <span className="text-sm font-medium leading-6 text-slate-700">
                {acknowledgmentText}
              </span>
            </label>
            <Button
              className="rounded bg-slate-900 px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_12px_rgba(15,23,42,0.10)] hover:bg-orange-600"
              disabled={!checked || isSubmitting}
              onClick={handleAcknowledge}
              type="button"
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}
              Submit Acknowledgment
            </Button>
          </div>
        ) : (
          <div className="mt-5 rounded border border-slate-200 bg-slate-50 p-4 text-slate-700">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-orange-500" />
              <p className="text-sm font-medium">
                {allowAcknowledgment
                  ? "This report is not currently open for employee acknowledgment."
                  : "Only the Medical Rep can submit the employee acknowledgment for this report."}
              </p>
            </div>
          </div>
        )}

        {message ? (
          <div
            className={cn(
              "mt-4 flex items-start gap-3 rounded border p-4 text-sm font-semibold",
              message.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800",
            )}
          >
            {message.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertCircle className="mt-0.5 h-4 w-4" />}
            <span>{message.text}</span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
