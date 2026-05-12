"use client";

import { useState } from "react";
import {
  AlertCircle,
  Award,
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
  excellence_zone: "border-amber-200 bg-amber-50 text-amber-800",
  green_zone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red_zone: "border-rose-200 bg-rose-50 text-rose-700",
  yellow_zone: "border-orange-200 bg-orange-50 text-orange-700",
};

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

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/90 px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-black text-slate-950">{value}</p>
    </div>
  );
}

function FeedbackBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <Card className="rounded-[24px] border border-slate-200/80 bg-white p-5 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">{label}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-700">
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
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      {area ? (
        <div className="rounded-2xl border border-orange-100 bg-orange-50/70 px-3 py-2.5">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-700">Area to be Improved</p>
          <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-5 text-orange-950">{area}</p>
        </div>
      ) : null}
      {strength ? (
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700">Strength Point</p>
          <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-5 text-emerald-950">{strength}</p>
        </div>
      ) : null}
    </div>
  );
}

export function EmployeeCoachingReview({ allowAcknowledgment = true, initialDetail }: EmployeeCoachingReviewProps) {
  const [detail, setDetail] = useState(initialDetail);
  const [checked, setChecked] = useState(false);
  const [closedByConflict, setClosedByConflict] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<FormMessage | null>(null);

  const report = detail.report;
  const summary = detail.summary;
  const scoresByKey = scoreMap(detail.scores);
  const acknowledged = report.employee_acknowledged || Boolean(report.acknowledged_at);
  const canAcknowledge = allowAcknowledgment && report.status === "submitted" && !acknowledged && !closedByConflict;
  const displayZone = report.performance_zone ?? summary?.performanceZone ?? null;

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

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden rounded-[30px] border border-white/75 bg-white/95 shadow-[0_24px_70px_rgba(15,23,42,0.10)] ring-1 ring-slate-900/5">
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,#0B0B0B_0%,#111827_58%,#3B2413_100%)] px-5 py-6 text-white sm:px-7">
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-orange-500/20 blur-3xl" />
          <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
            <div>
              <p className="inline-flex rounded-full border border-orange-400/40 bg-orange-500/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-orange-200">
                {report.report_number}
              </p>
              <h2 className="mt-4 text-3xl font-black tracking-[-0.04em] text-white sm:text-4xl">
                Field Coaching Review
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                Review the structured assessment and feedback submitted by your coach.
              </p>
            </div>
            <div className={cn("rounded-[22px] border px-4 py-3 text-sm font-black", zoneClassName(displayZone))}>
              {zoneLabel(displayZone)}
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-4">
          <DetailPill label="Coaching date" value={formatDate(report.coaching_date)} />
          <DetailPill label="Coach" value={formatEmployeeDisplayName(summary?.coachName, report.coach_hr_id)} />
          <DetailPill label="Coach role" value={report.coach_role || "Coach"} />
          <DetailPill label="Status" value={report.status.replace(/_/g, " ")} />
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
        <Card className="rounded-[30px] border border-white/75 bg-white/95 p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Employee context</p>
              <h3 className="mt-2 text-2xl font-black tracking-[-0.03em] text-slate-950">
                {formatEmployeeDisplayName(summary?.medicalRepName, report.medical_rep_hr_id)}
              </h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">HR ID: {report.medical_rep_hr_id}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
              <UserRound className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <DetailPill label="Line" value={summary?.lineName || "Not assigned"} />
            <DetailPill label="Area" value={summary?.areaName || "Not assigned"} />
            <DetailPill label="Team" value={summary?.teamName || "Not assigned"} />
          </div>
        </Card>

        <Card className="rounded-[30px] border border-white/75 bg-white/95 p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Final score</p>
              <p className="mt-2 text-4xl font-black tracking-[-0.05em] text-slate-950">
                {formatPercent(report.final_score_percent)}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                {formatScore(report.actual_score)} / {coachingMaxScore} points
              </p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-950 text-orange-300">
              <Award className="h-5 w-5" />
            </div>
          </div>
          {detail.scoreResult ? (
            <div className="mt-5 grid gap-3">
              <DetailPill label="Strongest parameter" value={detail.scoreResult.strongestParameter.label} />
              <DetailPill label="Key development area" value={detail.scoreResult.keyDevelopmentArea.label} />
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="rounded-[30px] border border-white/75 bg-white/95 p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Structured scoring</p>
            <h3 className="mt-2 text-2xl font-black tracking-[-0.03em] text-slate-950">
              20 field excellence points
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Each scoring item is rated from 1 to 6 across five coaching parameters.
            </p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
            <Target className="h-5 w-5" />
          </div>
        </div>

        <div className="mt-6 grid gap-4">
          {groupScoreItems().map((group) => (
            <div className="rounded-[24px] border border-slate-200/80 bg-slate-50/70 p-4" key={group.category}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-orange-300">
                    {categoryLetters[group.category]}
                  </span>
                  <div>
                    <p className="text-base font-black text-slate-950">{group.label}</p>
                    <p className="text-xs font-semibold text-slate-500">{group.items.length} scoring items</p>
                  </div>
                </div>
                {detail.scoreResult ? (
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-700">
                    {detail.scoreResult.categorySubtotals.find((item) => item.category === group.category)?.actualScore ?? 0}
                    {" / "}
                    {detail.scoreResult.categorySubtotals.find((item) => item.category === group.category)?.maxScore ?? 0}
                  </span>
                ) : null}
              </div>

              <div className="mt-4 grid gap-2">
                {group.items.map((item) => {
                  const scoreRow = scoresByKey.get(item.key);
                  const score = scoreRow?.score;
                  return (
                    <div
                      className="rounded-2xl border border-slate-200/70 bg-white px-4 py-3"
                      key={item.key}
                    >
                      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div>
                          <p className="text-sm font-bold text-slate-900">{item.label}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">Point {item.displayOrder}</p>
                        </div>
                        <span className="inline-flex h-9 min-w-12 items-center justify-center rounded-2xl bg-orange-50 px-3 text-sm font-black text-orange-700 ring-1 ring-orange-100">
                          {score ?? "-"} / 6
                        </span>
                      </div>
                      <ScoreItemNotes score={scoreRow} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <FeedbackBlock label="Overall Area of Development" text={report.area_of_development} />
        <FeedbackBlock label="Overall Strength Points" text={report.strength_points} />
        <FeedbackBlock label="General Remarks" text={report.general_remarks} />
      </div>

      <Card className="rounded-[30px] border border-white/75 bg-white/95 p-5 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Acknowledgment</p>
            <h3 className="mt-2 text-2xl font-black tracking-[-0.03em] text-slate-950">
              Employee review confirmation
            </h3>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
            <ShieldCheck className="h-5 w-5" />
          </div>
        </div>

        {acknowledged || closedByConflict ? (
          <div className="mt-5 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5" />
              <p className="text-sm font-black">
                {report.acknowledged_at
                  ? `Acknowledged on ${formatDateTime(report.acknowledged_at)}.`
                  : "This report has already been acknowledged."}
              </p>
            </div>
          </div>
        ) : canAcknowledge ? (
          <div className="mt-5 space-y-4">
            <label className="flex gap-3 rounded-[24px] border border-slate-200 bg-slate-50/80 p-4">
              <input
                checked={checked}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                disabled={isSubmitting}
                onChange={(event) => setChecked(event.target.checked)}
                type="checkbox"
              />
              <span className="text-sm font-semibold leading-6 text-slate-700">
                {acknowledgmentText}
              </span>
            </label>
            <Button
              className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)] hover:bg-orange-600"
              disabled={!checked || isSubmitting}
              onClick={handleAcknowledge}
              type="button"
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-2 h-4 w-4" />}
              Submit Acknowledgment
            </Button>
          </div>
        ) : (
          <div className="mt-5 rounded-[24px] border border-slate-200 bg-slate-50 p-4 text-slate-700">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-orange-500" />
              <p className="text-sm font-semibold">
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
              "mt-4 flex items-start gap-3 rounded-[22px] border p-4 text-sm font-semibold",
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
