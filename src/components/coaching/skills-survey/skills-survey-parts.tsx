// The small parts every Team Coaching Skills Survey screen shares: the table cells, the panel, the
// performance-level and training-priority words in their colour, and the number formats. Square
// edges, flat colour, nothing cut with an ellipsis — every cell wraps.
//
// Deliberately NOT "use client": nothing here holds state or handles an event, and the Employee 360
// survey history (a server component) imports the class strings and formatSurveyDate from it. Behind
// the directive those would be client references, and calling one on the server throws
// (tests/rsc-client-function-props.test.ts).

import type { ReactNode } from "react";

import {
  formatSkillsSurveyScore,
  formatSkillsSurveyShare,
} from "@/lib/coaching/skills-survey/calculations";
import {
  skillsSurveyPerformanceLevels,
  skillsSurveyTrainingPriorities,
  type SkillsSurveyPerformanceLevel,
  type SkillsSurveyTrainingPriority,
} from "@/lib/coaching/skills-survey/vocabulary";
import { cn } from "@/lib/utils";

export const surveyHeadCell =
  "px-2 py-2 text-left align-bottom text-phx-2xs font-bold uppercase tracking-[0.06em] break-words";
export const surveyBodyCell = "px-2 py-2 align-top break-words";
export const surveyHeadRow = "bg-[#0B0B0B] text-white";
export const surveyBodyRow = "border-b border-slate-200 bg-white even:bg-slate-50/60";

export function SurveyPanel({
  title,
  lead,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 border border-slate-200 bg-white", className)}>
      {title !== undefined || action !== undefined ? (
        <header className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {title !== undefined ? (
              <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-slate-900">
                <span aria-hidden className="h-3.5 w-1 shrink-0 bg-orange-500" />
                <span className="break-words">{title}</span>
              </h2>
            ) : null}
            {lead !== undefined ? <p className="mt-1 break-words text-sm leading-6 text-slate-600">{lead}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className="min-w-0 p-4">{children}</div>
    </section>
  );
}

const levelTone: Record<SkillsSurveyPerformanceLevel, string> = {
  [skillsSurveyPerformanceLevels.atOrAboveTarget]: "text-emerald-700",
  [skillsSurveyPerformanceLevels.developing]: "text-amber-800",
  [skillsSurveyPerformanceLevels.priorityForCoaching]: "text-rose-700",
};

export function PerformanceLevelText({ level }: { level: SkillsSurveyPerformanceLevel | null }) {
  if (!level) return <span className="text-slate-400">-</span>;
  return <span className={cn("font-bold", levelTone[level])}>{level}</span>;
}

const priorityTone: Record<SkillsSurveyTrainingPriority, string> = {
  [skillsSurveyTrainingPriorities.high]: "text-rose-700",
  [skillsSurveyTrainingPriorities.medium]: "text-amber-800",
  [skillsSurveyTrainingPriorities.onTarget]: "text-emerald-700",
  [skillsSurveyTrainingPriorities.noData]: "text-slate-400",
};

export function TrainingPriorityText({ priority }: { priority: SkillsSurveyTrainingPriority }) {
  return <span className={cn("font-bold", priorityTone[priority])}>{priority}</span>;
}

/** A score, or a dash when there is none. */
export function Score({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  const text = formatSkillsSurveyScore(value, digits);
  return text ? <span className="tabular-nums">{text}</span> : <span className="text-slate-400">-</span>;
}

export function Share({ value }: { value: number | null | undefined }) {
  const text = formatSkillsSurveyShare(value);
  return text ? <span className="tabular-nums">{text}</span> : <span className="text-slate-400">-</span>;
}

export function Years({ value, emptyText = "-" }: { value: number | null | undefined; emptyText?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="text-slate-400">{emptyText}</span>;
  }
  return <span className="tabular-nums">{value.toFixed(1)}</span>;
}

export function CardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-phx-2xs font-bold uppercase text-slate-400">{label}</dt>
      <dd className="break-words text-slate-800">{children}</dd>
    </div>
  );
}

/** "2026-10-31" as "31 Oct 2026". */
export function formatSurveyDate(isoDate: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ""));
  if (!match) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}
