import { Award, CalendarDays, CheckCircle2, ClipboardCheck, Target, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { formatDateOnly } from "@/lib/date-only";

import {
  AdminSectionHeader,
  adminInsetPanelClassName,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
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
  CoachingReportDetail as CoachingReportDetailType,
  CoachingReportStatus,
  CoachingScoreItemRow,
} from "@/lib/coaching/types";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

type CoachingReportDetailProps = {
  detail: CoachingReportDetailType;
};

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

const statusLabels: Record<CoachingReportStatus, string> = {
  cancelled: "Cancelled",
  draft: "Draft",
  locked: "Locked",
  reviewed_by_employee: "Reviewed by Employee",
  submitted: "Submitted",
};

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

function formatDate(value: string | null | undefined) {
  // Parse + format both in local time via the shared helper so the literal
  // date-only value never shifts a day on non-UTC clients (e.g. Cairo browsers).
  return formatDateOnly(value, "en-US", { day: "2-digit", month: "short", year: "numeric" }, "Not set");
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

function formatPercent(value: number | string | null | undefined) {
  const percent = Number(value ?? 0);
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "0.0%";
}

function formatScore(value: number | string | null | undefined) {
  const score = Number(value ?? 0);
  return Number.isFinite(score) ? score.toFixed(0) : "0";
}

function statusLabel(status: CoachingReportStatus | string | null | undefined) {
  if (!status || !(status in statusLabels)) return "Unknown";
  return statusLabels[status as CoachingReportStatus];
}

function zoneLabel(zone: CoachingPerformanceZone | string | null | undefined) {
  if (!zone || !(zone in zoneLabels)) return "Not scored";
  return zoneLabels[zone as CoachingPerformanceZone];
}

function zoneClassName(zone: CoachingPerformanceZone | string | null | undefined) {
  if (zone === "critical_red" || zone === "red_zone") return "border-rose-200 bg-rose-50 text-rose-700";
  if (zone === "yellow_zone") return "border-orange-200 bg-orange-50 text-orange-700";
  if (zone === "green_zone") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (zone === "excellence_zone") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function statusClassName(status: CoachingReportStatus | string | null | undefined) {
  if (status === "draft") return "border-slate-200 bg-slate-50 text-slate-700";
  if (status === "submitted") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "reviewed_by_employee") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "locked") return "border-slate-300 bg-slate-900 text-white";
  if (status === "cancelled") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function scoreMap(scores: CoachingScoreItemRow[]) {
  return new Map<CoachingScoreItemKey, CoachingScoreItemRow>(
    scores.map((score) => [score.score_item_key, score]),
  );
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
          <p className="mt-1 text-sm font-black text-[#0F172A]">{value}</p>
        </div>
        {icon ? <div className="text-[#F97316]">{icon}</div> : null}
      </div>
    </div>
  );
}

function Pill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={cn("inline-flex rounded-full border px-3 py-1.5 text-xs font-black", className)}>
      {children}
    </span>
  );
}

function FeedbackBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <Card className={cn(adminPanelClassName, "p-5")}>
      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#F97316]">{label}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[#475569]">
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
        <div className="rounded-md border border-orange-100 bg-orange-50/70 px-3 py-2.5">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#EA580C]">Area to be Improved</p>
          <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-5 text-[#7C2D12]">{area}</p>
        </div>
      ) : null}
      {strength ? (
        <div className="rounded-md border border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700">Strength Point</p>
          <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-5 text-emerald-900">{strength}</p>
        </div>
      ) : null}
    </div>
  );
}

export function CoachingReportDetail({ detail }: CoachingReportDetailProps) {
  const { report, scoreResult, summary } = detail;
  const scoresByKey = scoreMap(detail.scores);
  const displayZone = report.performance_zone ?? summary?.performanceZone ?? null;
  const acknowledged = report.employee_acknowledged || Boolean(report.acknowledged_at);

  return (
    <div className="space-y-5">
      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <div className="grid gap-5 border-b border-[#E2E8F0] bg-[linear-gradient(135deg,#FFFFFF_0%,#FFF7ED_58%,#F8FAFC_100%)] p-5 sm:p-6 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#F97316]">
              {report.report_number}
            </p>
            <h2 className="mt-2 text-3xl font-black tracking-[-0.04em] text-[#0F172A]">
              {formatEmployeeDisplayName(summary?.medicalRepName, report.medical_rep_hr_id)}
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#64748B]">
              Read-only coaching report for HR ID {report.medical_rep_hr_id}, coached by {formatEmployeeDisplayName(summary?.coachName, report.coach_hr_id)}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill className={zoneClassName(displayZone)}>{zoneLabel(displayZone)}</Pill>
            <Pill className={statusClassName(report.status)}>{statusLabel(report.status)}</Pill>
            <Pill className={acknowledged ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}>
              {acknowledged ? "Acknowledged" : "Acknowledgment Pending"}
            </Pill>
          </div>
        </div>

        <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-4">
          <StatTile icon={<CalendarDays className="h-4 w-4" />} label="Coaching Date" value={formatDate(report.coaching_date)} />
          <StatTile icon={<UserRound className="h-4 w-4" />} label="Medical Rep HR ID" value={report.medical_rep_hr_id} />
          <StatTile icon={<ClipboardCheck className="h-4 w-4" />} label="Coach" value={formatEmployeeDisplayName(summary?.coachName, report.coach_hr_id)} />
          <StatTile label="Coach Role" value={report.coach_role || "Coach"} />
          <StatTile label="Line" value={summary?.lineName || "Not assigned"} />
          <StatTile label="Area" value={summary?.areaName || "Not assigned"} />
          <StatTile label="Team" value={summary?.teamName || "Not assigned"} />
          <StatTile label="Acknowledged At" value={formatDateTime(report.acknowledged_at)} />
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <Card className={cn(adminPanelClassName, "p-5 sm:p-6")}>
          <AdminSectionHeader
            title="Final score"
            description="Calculated from the 20 fixed coaching score items."
            action={<Award className="h-5 w-5 text-[#F97316]" />}
          />
          <div className={cn(adminInsetPanelClassName, "mt-5 p-5")}>
            <p className="text-5xl font-black tracking-[-0.06em] text-[#0F172A]">
              {formatPercent(report.final_score_percent)}
            </p>
            <p className="mt-2 text-sm font-bold text-[#64748B]">
              {formatScore(report.actual_score)} / {coachingMaxScore} points
            </p>
            <div className="mt-5 grid gap-3">
              <StatTile
                label="Strongest parameter"
                value={scoreResult?.strongestParameter.label ?? "Not available"}
              />
              <StatTile
                label="Key development area"
                value={scoreResult?.keyDevelopmentArea.label ?? "Not available"}
              />
            </div>
          </div>
        </Card>

        <Card className={cn(adminPanelClassName, "p-5 sm:p-6")}>
          <AdminSectionHeader
            title="Review status"
            description="Tracks whether the medical rep has acknowledged the submitted coaching report."
            action={<CheckCircle2 className="h-5 w-5 text-[#F97316]" />}
          />
          <div className={cn(adminInsetPanelClassName, "mt-5 grid gap-3 p-5 sm:grid-cols-2")}>
            <StatTile label="Acknowledgment Status" value={acknowledged ? "Acknowledged" : "Pending"} />
            <StatTile label="Submitted At" value={formatDateTime(report.submitted_at)} />
            <StatTile label="Locked At" value={formatDateTime(report.locked_at)} />
            <StatTile label="Last Updated" value={formatDateTime(report.updated_at)} />
          </div>
        </Card>
      </div>

      <Card className={cn(adminPanelClassName, "p-5 sm:p-6")}>
        <AdminSectionHeader
          title="20 field excellence points"
          description="Five coaching parameters with fixed score items, each rated from 0 to 5."
          action={<Target className="h-5 w-5 text-[#F97316]" />}
        />

        <div className="mt-5 grid gap-4">
          {categoryOrder.map((category) => {
            const items = coachingScoreItems.filter((item) => item.category === category);
            const subtotal = scoreResult?.categorySubtotals.find((item) => item.category === category);
            return (
              <div className={cn(adminInsetPanelClassName, "p-4")} key={category}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-[#0F172A] text-sm font-black text-[#FDBA74]">
                      {categoryLetters[category]}
                    </span>
                    <div>
                      <p className="text-base font-black text-[#0F172A]">{coachingParameterLabels[category]}</p>
                      <p className="text-xs font-bold text-[#64748B]">{items.length} scoring items</p>
                    </div>
                  </div>
                  <span className="rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-black text-[#475569]">
                    {subtotal ? `${subtotal.actualScore} / ${subtotal.maxScore}` : "Not scored"}
                  </span>
                </div>

                <div className="mt-4 grid gap-2">
                  {items.map((item) => {
                    const scoreRow = scoresByKey.get(item.key);
                    const score = scoreRow?.score;
                    return (
                      <div
                        className="rounded-md border border-[#E2E8F0] bg-white px-4 py-3"
                        key={item.key}
                      >
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                          <div>
                            <p className="text-sm font-bold text-[#0F172A]">{item.label}</p>
                            <p className="mt-1 text-xs font-semibold text-[#64748B]">Point {item.displayOrder}</p>
                          </div>
                          <span className="inline-flex h-9 min-w-12 items-center justify-center rounded-md bg-[#FFF7ED] px-3 text-sm font-black text-[#EA580C] ring-1 ring-[#FED7AA]">
                            {score ?? "-"} / 5
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

      <div className="grid gap-4 lg:grid-cols-3">
        <FeedbackBlock label="Overall Area of Development" text={report.area_of_development} />
        <FeedbackBlock label="Overall Strength Points" text={report.strength_points} />
        <FeedbackBlock label="General Remarks" text={report.general_remarks} />
      </div>
    </div>
  );
}
