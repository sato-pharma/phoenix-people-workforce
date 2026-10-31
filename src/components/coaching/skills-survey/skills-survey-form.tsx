"use client";

// THE DISTRICT MANAGER'S FORM — the "Survey" sheet of "Team Skills Survey 2026", one team member at a
// time, in the one form design every Phoenix form wears: the Adverse Drug Reaction (Report It)
// wizard (owner, 2026-10-06; and for this form, 2026-10-31: "make it very premium polished and follow
// the report it form"). The shell — header, progress, numbered rail, phone stepper, step heading,
// footer — is `FormWizard` from the kit; the skill cards are Report It's numbered blocks; the finish
// is its confirmation screen, in the flat version (no glow).
//
// Every word comes from src/lib/coaching/skills-survey/vocabulary.ts, and every figure from
// calculations.ts — the workbook's own formulas — so the live Average on this form is the number the
// Ranking will show.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronLeft, ChevronRight, Lock, PencilLine, ShieldCheck, Users } from "lucide-react";

import {
  FieldLabel,
  FormActions,
  FormBlockHeader,
  FormWizard,
  RatingScale,
  type FormWizardStep,
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldGridClassName,
  phxTextareaClassName,
} from "@/components/ui/form-kit";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import {
  capabilityAverage,
  formatSkillsSurveyScore,
  scoreSkillsSurveyEntry,
  skillsSurveyQuarterLabel,
  type SkillsSurveyScores,
} from "@/lib/coaching/skills-survey/calculations";
import type { SkillsSurveyMemberForm } from "@/lib/coaching/skills-survey/service";
import {
  skillsSurveyDevelopmentPrioritiesHint,
  skillsSurveyFieldLabels,
  skillsSurveyInstructions,
  skillsSurveyNotObserved,
  skillsSurveyOverallFormula,
  skillsSurveyRankingLabels,
  skillsSurveyRatingScale,
  skillsSurveyRatingScaleHeading,
  skillsSurveyTitle,
  skillsSurveyYearsInRoleHint,
  skillsSurveyYearsNotFilled,
} from "@/lib/coaching/skills-survey/vocabulary";
import { cn } from "@/lib/utils";

import { PerformanceLevelText, formatSurveyDate } from "./skills-survey-parts";

const STEPS: FormWizardStep[] = [
  { label: "About", description: "Who you are rating", title: "About This Survey" },
  { label: "Skills", description: "0 to 5 for each skill", title: "Rate Each Skill" },
  { label: "Priorities", description: "What to work on first", title: "Development Priorities" },
];

const scaleOptions = skillsSurveyRatingScale.map((entry) => ({
  label: String(entry.score),
  title: entry.label,
  value: entry.score,
}));

function scaleEntry(score: number | null | undefined) {
  return score === null || score === undefined
    ? null
    : skillsSurveyRatingScale.find((entry) => entry.score === score) ?? null;
}

/** A read-only value printed in the field skin, so the facts sit exactly where inputs would. */
function ReadOnlyField({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex min-h-[42px] items-center border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
        <span className="min-w-0 break-words">{value}</span>
      </div>
      {hint ? <span className="mt-1 block text-xs leading-relaxed text-slate-400">{hint}</span> : null}
    </div>
  );
}

/** The figure strip under the form's header: the live Average, the count rated, the Overall score. */
function LiveFigures({
  average,
  rated,
  total,
  overall,
  level,
}: {
  average: number | null;
  rated: number;
  total: number;
  overall: number | null;
  level: ReturnType<typeof scoreSkillsSurveyEntry>["performanceLevel"];
}) {
  return (
    <dl className="grid grid-cols-2 border border-slate-200 bg-white sm:grid-cols-4">
      <div className="border-b border-r border-slate-200 px-4 py-3 sm:border-b-0">
        <dt className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{skillsSurveyFieldLabels.average}</dt>
        <dd className="mt-1 text-2xl font-black tabular-nums text-slate-900">{formatSkillsSurveyScore(average) || "-"}</dd>
      </div>
      <div className="border-b border-slate-200 px-4 py-3 sm:border-b-0 sm:border-r">
        <dt className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">Skills rated</dt>
        <dd className="mt-1 text-2xl font-black tabular-nums text-slate-900">
          {rated}
          <span className="text-base font-bold text-slate-400"> / {total}</span>
        </dd>
      </div>
      <div className="border-r border-slate-200 px-4 py-3">
        <dt className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{skillsSurveyRankingLabels.overallScore}</dt>
        <dd className="mt-1 text-2xl font-black tabular-nums text-slate-900">{formatSkillsSurveyScore(overall) || "-"}</dd>
      </div>
      <div className="px-4 py-3">
        <dt className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{skillsSurveyRankingLabels.performanceLevel}</dt>
        <dd className="mt-2 text-sm">
          <PerformanceLevelText level={level} />
        </dd>
      </div>
    </dl>
  );
}

function RatingScaleKey() {
  return (
    <div className="border border-slate-200">
      <FormBlockHeader label={skillsSurveyRatingScaleHeading} />
      <dl className="grid grid-cols-1 sm:grid-cols-2">
        {skillsSurveyRatingScale.map((entry) => (
          <div key={entry.score} className="flex gap-3 border-b border-slate-100 px-4 py-2.5 sm:odd:border-r">
            <dt className="flex h-7 w-7 shrink-0 items-center justify-center bg-slate-900 text-xs font-black tabular-nums text-white">
              {entry.score}
            </dt>
            <dd className="min-w-0 text-xs leading-relaxed text-slate-600">
              <span className="block font-black text-slate-900">{entry.label.replace(/^\d+ - /, "")}</span>
              {entry.meaning}
            </dd>
          </div>
        ))}
        <div className="flex gap-3 px-4 py-2.5 sm:col-span-2">
          <dt className="flex h-7 shrink-0 items-center justify-center border border-dashed border-slate-300 px-2 text-phx-2xs font-black uppercase text-slate-500">
            Empty
          </dt>
          <dd className="min-w-0 text-xs leading-relaxed text-slate-600">
            <span className="block font-black text-slate-900">{skillsSurveyNotObserved.label}</span>
            {skillsSurveyNotObserved.meaning}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function StepAbout({ form }: { form: SkillsSurveyMemberForm }) {
  const date = form.survey?.surveyDate ?? form.today;
  return (
    <div className="space-y-6">
      <div className={phxFieldGridClassName}>
        <ReadOnlyField label={skillsSurveyFieldLabels.teamMember} value={form.member.name} />
        <ReadOnlyField label={skillsSurveyFieldLabels.district} value={form.districtName ?? "-"} />
        <ReadOnlyField label={skillsSurveyFieldLabels.districtManager} value={form.districtManagerName ?? "-"} />
        <ReadOnlyField
          label={skillsSurveyFieldLabels.date}
          value={`${formatSurveyDate(date)} · ${skillsSurveyQuarterLabel(form.quarter.year, form.quarter.quarter)}`}
        />
        <ReadOnlyField
          label={skillsSurveyFieldLabels.yearsInRole}
          value={
            form.yearsInRole === null ? (
              <span className="font-semibold text-amber-800">{skillsSurveyYearsNotFilled}</span>
            ) : (
              <span className="tabular-nums">{form.yearsInRole.toFixed(1)}</span>
            )
          }
          hint={skillsSurveyYearsInRoleHint}
        />
      </div>

      <div className="border border-slate-200">
        <FormBlockHeader label={skillsSurveyInstructions.howTo} />
        <ol className="divide-y divide-slate-100">
          {skillsSurveyInstructions.steps.map((text, index) => (
            <li key={text} className="flex gap-3 px-4 py-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center border border-slate-300 text-phx-2xs font-black tabular-nums text-slate-500">
                {index + 1}
              </span>
              <span className="min-w-0 text-sm leading-6 text-slate-700">{text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function SkillCard({
  index,
  total,
  name,
  goodLooksLike,
  value,
  onChange,
  disabled,
}: {
  index: number;
  total: number;
  name: string;
  goodLooksLike: string;
  value: number | null;
  onChange: (next: number | null) => void;
  disabled: boolean;
}) {
  const chosen = scaleEntry(value);
  return (
    <div className={cn("border", value === null ? "border-slate-200" : "border-slate-300")}>
      <FormBlockHeader
        label={
          <span className="break-words">
            <span className="tabular-nums text-slate-400">
              {String(index + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
            </span>{" "}
            {name}
          </span>
        }
        action={
          <span
            className={cn(
              "shrink-0 text-phx-2xs font-black uppercase tracking-wide tabular-nums",
              value === null ? "text-slate-400" : "text-orange-700",
            )}
          >
            {value === null ? skillsSurveyNotObserved.label : `${value} / 5`}
          </span>
        }
      />
      <div className="space-y-3 p-4">
        <div>
          <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">What good looks like</p>
          <p className="mt-1 text-sm leading-6 text-slate-700">{goodLooksLike}</p>
        </div>
        <RatingScale
          ariaLabel={`${name}: rating from 0 to 5`}
          disabled={disabled}
          emptyLabel={skillsSurveyNotObserved.label}
          onChange={onChange}
          options={scaleOptions}
          value={value}
        />
        <p className={cn("min-h-[1.25rem] text-xs leading-relaxed", chosen ? "text-slate-600" : "text-slate-400")}>
          {chosen ? (
            <>
              <span className="font-black text-slate-900">{chosen.label}.</span> {chosen.meaning}
            </>
          ) : (
            "Not observed. This skill is left out of the average."
          )}
        </p>
      </div>
    </div>
  );
}

export function SkillsSurveyForm({
  form,
  backHref,
  variant = "portal",
}: {
  form: SkillsSurveyMemberForm;
  /** The survey's team list, where Save and Cancel return to. */
  backHref: string;
  variant?: "portal" | "admin";
}) {
  const router = useRouter();
  const skills = useMemo(() => {
    const rated = new Set(Object.keys(form.survey?.scores ?? {}));
    return form.config.skills
      .filter((skill) => skill.isActive || (!form.canEdit && rated.has(skill.key)))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [form]);

  const [step, setStep] = useState(1);
  const [scores, setScores] = useState<SkillsSurveyScores>(() => ({ ...(form.survey?.scores ?? {}) }));
  const [priorities, setPriorities] = useState(form.survey?.developmentPriorities ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const readOnly = !form.canEdit;
  const shownScores = useMemo(
    () => Object.fromEntries(Object.entries(scores).filter(([key]) => skills.some((skill) => skill.key === key))),
    [scores, skills],
  );
  const average = capabilityAverage(shownScores);
  const card = scoreSkillsSurveyEntry({ scores: shownScores, yearsInRole: form.yearsInRole }, form.config.settings);
  const ratedCount = Object.keys(shownScores).length;

  const setScore = useCallback((key: string, value: number | null) => {
    setScores((current) => {
      const next = { ...current };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const handleStepChange = useCallback((next: number) => {
    setError(null);
    setStep(Math.min(Math.max(next, 1), STEPS.length));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (ratedCount === 0) {
      setError("Rate at least one skill. A survey with every skill on Not observed has no average.");
      setStep(2);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/coaching/skills-survey", {
        body: JSON.stringify({
          developmentPriorities: priorities,
          memberHrId: form.member.hrId,
          quarter: form.quarter.quarter,
          scores: shownScores,
          year: form.quarter.year,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The survey could not be saved.");
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The survey could not be saved. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [form.member.hrId, form.quarter, priorities, ratedCount, router, shownScores]);

  if (saved) {
    return (
      <div className={cn("mx-auto max-w-xl overflow-hidden p-0", adminPanelClassName)}>
        <div className="border-b border-phx-line bg-[#FCFDFE] px-6 py-7 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center border border-emerald-200 bg-emerald-50">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" />
          </div>
          <p className="mt-5 text-phx-xs font-black uppercase tracking-[0.2em] text-orange-600">{skillsSurveyTitle}</p>
          <h2 className="mt-1 text-2xl font-black text-slate-900">Survey Saved</h2>
        </div>
        <div className="space-y-5 px-6 py-7 text-center">
          <p className="text-sm leading-6 text-slate-600">
            {form.member.name}&apos;s survey for {skillsSurveyQuarterLabel(form.quarter.year, form.quarter.quarter)} is
            saved. You can change it until the quarter ends.
          </p>
          <div className="mx-auto grid max-w-sm grid-cols-2 border border-slate-900 bg-slate-900 text-left">
            <div className="border-r border-slate-700 px-5 py-3.5">
              <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-300">{skillsSurveyFieldLabels.average}</p>
              <p className="mt-1 text-xl font-black tabular-nums text-white">{formatSkillsSurveyScore(average) || "-"}</p>
            </div>
            <div className="px-5 py-3.5">
              <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-300">{skillsSurveyRankingLabels.overallScore}</p>
              <p className="mt-1 text-xl font-black tabular-nums text-white">{formatSkillsSurveyScore(card.overallScore) || "-"}</p>
            </div>
          </div>
          <p className="text-xs font-semibold text-slate-500">{skillsSurveyInstructions.privacy}</p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            <Link className={phxButtonAccentClassName} href={backHref}>
              <Users className="h-4 w-4" />
              Back to my team
            </Link>
            <button
              className={phxButtonGhostClassName}
              onClick={() => {
                setSaved(false);
                setStep(2);
              }}
              type="button"
            >
              <PencilLine className="h-4 w-4" />
              Change this survey
            </button>
          </div>
        </div>
      </div>
    );
  }

  const badge = readOnly ? (
    <span className="inline-flex w-fit items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
      <Lock className="h-3.5 w-3.5 text-orange-500" />
      Read only
    </span>
  ) : (
    <span className="inline-flex w-fit items-center gap-1.5 border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide text-orange-700">
      <ShieldCheck className="h-3.5 w-3.5" />
      Managers only
    </span>
  );

  const readOnlyFooter = (
    <FormActions
      left={
        <button className={phxButtonGhostClassName} disabled={step === 1} onClick={() => handleStepChange(step - 1)} type="button">
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
      }
      right={
        step < STEPS.length ? (
          <button className={phxButtonPrimaryClassName} onClick={() => handleStepChange(step + 1)} type="button">
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <Link className={phxButtonPrimaryClassName} href={backHref}>
            Done
          </Link>
        )
      }
    />
  );

  const description = (
    <>
      {form.member.name} · {skillsSurveyQuarterLabel(form.quarter.year, form.quarter.quarter)}.{" "}
      {readOnly ? "This survey can no longer be changed here." : skillsSurveyInstructions.lead}
    </>
  );

  return (
    <div className="space-y-4">
      <LiveFigures
        average={average}
        level={card.performanceLevel}
        overall={card.overallScore}
        rated={ratedCount}
        total={skills.length}
      />
      <FormWizard
        badge={badge}
        canJump={() => true}
        className={variant === "admin" ? adminPanelClassName : undefined}
        description={description}
        error={error}
        eyebrow={variant === "admin" ? "Field coaching" : undefined}
        footer={readOnly ? readOnlyFooter : undefined}
        footnote={skillsSurveyInstructions.privacy}
        header={variant === "admin" ? "panel" : "strip"}
        onStepChange={handleStepChange}
        onSubmit={handleSubmit}
        step={step}
        steps={STEPS}
        submitLabel="Save Survey"
        submitting={submitting}
        title={variant === "admin" ? skillsSurveyTitle : undefined}
      >
        {step === 1 && <StepAbout form={form} />}
        {step === 2 && (
          <div className="space-y-4">
            <RatingScaleKey />
            {skills.map((skill, index) => (
              <SkillCard
                disabled={readOnly}
                goodLooksLike={skill.goodLooksLike}
                index={index}
                key={skill.key}
                name={skill.name}
                onChange={(next) => setScore(skill.key, next)}
                total={skills.length}
                value={scores[skill.key] ?? null}
              />
            ))}
          </div>
        )}
        {step === 3 && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <FieldLabel htmlFor="skills-survey-priorities">{skillsSurveyFieldLabels.developmentPriorities}</FieldLabel>
              <textarea
                className={phxTextareaClassName}
                disabled={readOnly}
                id="skills-survey-priorities"
                maxLength={2000}
                onChange={(event) => setPriorities(event.target.value)}
                placeholder={skillsSurveyDevelopmentPrioritiesHint}
                rows={7}
                value={priorities}
              />
              <span className="mt-1 block text-xs leading-relaxed text-slate-400">{skillsSurveyDevelopmentPrioritiesHint}</span>
            </div>
            <div className="min-w-0 border border-slate-200">
              <FormBlockHeader label="How the scores are worked out" />
              <p className="px-4 py-3 text-xs leading-relaxed text-slate-600">
                {skillsSurveyOverallFormula(form.config.settings.capabilityWeight, form.config.settings.fullExperienceYears)}
              </p>
            </div>
          </div>
        )}
      </FormWizard>
    </div>
  );
}
