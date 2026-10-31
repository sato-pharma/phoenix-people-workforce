"use client";

// THE TEAM COACHING SKILLS SURVEY'S SCREEN — the workbook's four working sheets as four tabs: Survey,
// Ranking, Analysis, Skills. One component for the employee portal and the admin shell. Everything is
// calculated from the saved surveys by calculations.ts (the workbook's own formulas); the only things
// typed here are the Training Manager's settings and skills list, in the places the workbook puts
// them. Every table fits its own width: all columns when there is room, merged columns when there is
// less, one card per row on a phone — never a sideways scroll, never a cut word, never a round corner.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronRight, Plus, ShieldCheck } from "lucide-react";

import {
  CheckTile,
  FieldLabel,
  FormBlockHeader,
  FormError,
  phxButtonAccentClassName,
  phxButtonAddBlockClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-kit";
import {
  buildSkillsSurveyAnalysis,
  buildSkillsSurveyDistrictAverages,
  buildSkillsSurveyExperienceBandAverages,
  buildSkillsSurveyRanking,
  capabilityAverage,
  skillsForAnalysis,
  skillsSurveyQuarterKey,
  skillsSurveyQuarterLabel,
  type SkillsSurveyEntry,
  type SkillsSurveyExperienceBand,
  type SkillsSurveyGroupAverageRow,
  type SkillsSurveySkill,
} from "@/lib/coaching/skills-survey/calculations";
import type { SkillsSurveyWorkspace as SkillsSurveyWorkspaceData } from "@/lib/coaching/skills-survey/service";
import {
  skillsSurveyAnalysisLabels,
  skillsSurveyFieldLabels,
  skillsSurveyInstructions,
  skillsSurveyOverallFormula,
  skillsSurveyRankingLabels,
  skillsSurveySkillsLabels,
  skillsSurveyStatus,
  skillsSurveyTabOrder as tabOrder,
  skillsSurveyTabs,
  skillsSurveyYearsNotFilled,
  type SkillsSurveyTab,
} from "@/lib/coaching/skills-survey/vocabulary";
import { cn } from "@/lib/utils";

import {
  CardField,
  PerformanceLevelText,
  Score,
  Share,
  SurveyPanel,
  TrainingPriorityText,
  Years,
  formatSurveyDate,
  surveyBodyCell,
  surveyBodyRow,
  surveyHeadCell,
  surveyHeadRow,
} from "./skills-survey-parts";


// ─── Saving the Training Manager's settings ───────────────────────────────────

function useSettingsSave() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      setError(null);
      setMessage(null);
      try {
        const response = await fetch("/api/coaching/skills-survey/settings", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? "The settings could not be saved.");
        setMessage("Saved. The ranking and the analysis now use it.");
        router.refresh();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The settings could not be saved.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [router],
  );

  return { error, message, save, saving };
}

function SaveRow({
  saving,
  error,
  message,
  onSave,
  label = "Save",
}: {
  saving: boolean;
  error: string | null;
  message: string | null;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {error ? <FormError>{error}</FormError> : null}
        {message && !error ? <p className="text-xs font-bold text-emerald-700">{message}</p> : null}
      </div>
      <button className={phxButtonAccentClassName} disabled={saving} onClick={onSave} type="button">
        {saving ? "Saving" : label}
      </button>
    </div>
  );
}

// ─── Survey tab ───────────────────────────────────────────────────────────────

function TeamTable({ data, memberHrefBase }: { data: SkillsSurveyWorkspaceData; memberHrefBase: string }) {
  const isCurrent =
    data.quarter.year === data.currentQuarter.year && data.quarter.quarter === data.currentQuarter.quarter;
  const quarterKey = skillsSurveyQuarterKey(data.quarter.year, data.quarter.quarter);

  function action(member: SkillsSurveyWorkspaceData["team"][number]) {
    if (isCurrent) {
      return (
        <Link
          className={cn(member.rated ? phxButtonGhostClassName : phxButtonAccentClassName, "w-full justify-center")}
          href={`${memberHrefBase}/${encodeURIComponent(member.hrId)}`}
        >
          {member.rated ? "Change" : "Rate"}
          <ChevronRight className="h-4 w-4" />
        </Link>
      );
    }
    if (!member.rated) return <span className="text-xs text-slate-400">Quarter ended</span>;
    return (
      <Link
        className={cn(phxButtonGhostClassName, "w-full justify-center")}
        href={`${memberHrefBase}/${encodeURIComponent(member.hrId)}?quarter=${quarterKey}`}
      >
        View
      </Link>
    );
  }

  const status = (rated: boolean) => (
    <span className={cn("font-bold", rated ? "text-emerald-700" : "text-amber-800")}>
      {rated ? skillsSurveyStatus.rated : skillsSurveyStatus.notRated}
    </span>
  );

  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[820px]:table">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[12%]" />
          <col className="w-[12%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
          <col className="w-[12%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead>
          <tr className={surveyHeadRow}>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.teamMember}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.yearsInRole}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.average}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyRankingLabels.overallScore}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyRankingLabels.performanceLevel}</th>
            <th className={surveyHeadCell} scope="col">Status</th>
            <th className={surveyHeadCell} scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.team.map((member) => (
            <tr className={surveyBodyRow} key={member.hrId}>
              <td className={surveyBodyCell}>
                <p className="font-bold text-slate-900">{member.name}</p>
                {member.districtName ? <p className="mt-0.5 text-slate-500">{member.districtName}</p> : null}
              </td>
              <td className={surveyBodyCell}>
                <Years emptyText={skillsSurveyYearsNotFilled} value={member.yearsInRole} />
              </td>
              <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                <Score value={member.card?.capabilityAverage} />
              </td>
              <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                <Score value={member.card?.overallScore} />
              </td>
              <td className={surveyBodyCell}>
                <PerformanceLevelText level={member.card?.performanceLevel ?? null} />
              </td>
              <td className={surveyBodyCell}>{status(member.rated)}</td>
              <td className={surveyBodyCell}>{action(member)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="space-y-2 @min-[820px]:hidden">
        {data.team.map((member) => (
          <li className="border border-slate-200 bg-white p-3 text-xs" key={member.hrId}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-slate-900">{member.name}</p>
                {member.districtName ? <p className="mt-0.5 text-slate-500">{member.districtName}</p> : null}
              </div>
              <p className="shrink-0 text-right">{status(member.rated)}</p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 @min-[420px]:grid-cols-4">
              <CardField label={skillsSurveyFieldLabels.yearsInRole}>
                <Years emptyText={skillsSurveyYearsNotFilled} value={member.yearsInRole} />
              </CardField>
              <CardField label={skillsSurveyFieldLabels.average}>
                <Score value={member.card?.capabilityAverage} />
              </CardField>
              <CardField label={skillsSurveyRankingLabels.overallScore}>
                <Score value={member.card?.overallScore} />
              </CardField>
              <CardField label={skillsSurveyRankingLabels.performanceLevel}>
                <PerformanceLevelText level={member.card?.performanceLevel ?? null} />
              </CardField>
            </dl>
            <div className="mt-3">{action(member)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SurveysTable({
  entries,
  memberHrefBase,
  quarterKey,
}: {
  entries: SkillsSurveyEntry[];
  memberHrefBase: string;
  quarterKey: string;
}) {
  const sorted = [...entries].sort(
    (left, right) =>
      String(left.districtName ?? "").localeCompare(String(right.districtName ?? "")) ||
      left.memberName.localeCompare(right.memberName),
  );
  const href = (entry: SkillsSurveyEntry) =>
    `${memberHrefBase}/${encodeURIComponent(entry.memberHrId)}?quarter=${quarterKey}`;
  const average = (entry: SkillsSurveyEntry) => capabilityAverage(entry.scores);

  return (
    <div className="@container min-w-0">
      <table className="hidden w-full table-fixed border-collapse text-xs @min-[1080px]:table">
        <colgroup>
          <col className="w-[10%]" />
          <col className="w-[12%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[8%]" />
          <col className="w-[8%]" />
          <col className="w-[24%]" />
          <col className="w-[8%]" />
        </colgroup>
        <thead>
          <tr className={surveyHeadRow}>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.date}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.district}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.districtManager}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.teamMember}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.yearsInRole}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.average}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.developmentPriorities}</th>
            <th className={surveyHeadCell} scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
            <tr className={surveyBodyRow} key={entry.id}>
              <td className={cn(surveyBodyCell, "tabular-nums text-slate-700")}>{formatSurveyDate(entry.surveyDate)}</td>
              <td className={cn(surveyBodyCell, "text-slate-700")}>{entry.districtName ?? "-"}</td>
              <td className={cn(surveyBodyCell, "text-slate-700")}>{entry.raterName}</td>
              <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>{entry.memberName}</td>
              <td className={surveyBodyCell}>
                <Years value={entry.yearsInRole} />
              </td>
              <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                <Score value={average(entry)} />
              </td>
              <td className={cn(surveyBodyCell, "whitespace-pre-line text-slate-700")}>{entry.developmentPriorities || "-"}</td>
              <td className={surveyBodyCell}>
                <Link className={cn(phxButtonGhostClassName, "w-full justify-center px-2")} href={href(entry)}>
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="hidden w-full table-fixed border-collapse text-xs @min-[700px]:table @min-[1080px]:hidden">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[16%]" />
          <col className="w-[10%]" />
          <col className="w-[32%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead>
          <tr className={surveyHeadRow}>
            <th className={surveyHeadCell} scope="col">
              {skillsSurveyFieldLabels.teamMember} · {skillsSurveyFieldLabels.district} · {skillsSurveyFieldLabels.districtManager}
            </th>
            <th className={surveyHeadCell} scope="col">
              {skillsSurveyFieldLabels.date} · {skillsSurveyFieldLabels.yearsInRole}
            </th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.average}</th>
            <th className={surveyHeadCell} scope="col">{skillsSurveyFieldLabels.developmentPriorities}</th>
            <th className={surveyHeadCell} scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
            <tr className={surveyBodyRow} key={entry.id}>
              <td className={surveyBodyCell}>
                <p className="font-bold text-slate-900">{entry.memberName}</p>
                <p className="mt-0.5 text-slate-600">{entry.districtName ?? "-"}</p>
                <p className="text-slate-500">{entry.raterName}</p>
              </td>
              <td className={cn(surveyBodyCell, "text-slate-700")}>
                <p className="tabular-nums">{formatSurveyDate(entry.surveyDate)}</p>
                <p className="mt-0.5">
                  <Years value={entry.yearsInRole} /> years
                </p>
              </td>
              <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                <Score value={average(entry)} />
              </td>
              <td className={cn(surveyBodyCell, "whitespace-pre-line text-slate-700")}>{entry.developmentPriorities || "-"}</td>
              <td className={surveyBodyCell}>
                <Link className={cn(phxButtonGhostClassName, "w-full justify-center px-2")} href={href(entry)}>
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="space-y-2 @min-[700px]:hidden">
        {sorted.map((entry) => (
          <li className="border border-slate-200 bg-white p-3 text-xs" key={entry.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-slate-900">{entry.memberName}</p>
                <p className="mt-0.5 text-slate-500">
                  {entry.districtName ?? "-"} · {entry.raterName}
                </p>
              </div>
              <p className="shrink-0 text-right text-lg font-black tabular-nums text-slate-900">
                <Score value={average(entry)} />
              </p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <CardField label={skillsSurveyFieldLabels.date}>{formatSurveyDate(entry.surveyDate)}</CardField>
              <CardField label={skillsSurveyFieldLabels.yearsInRole}>
                <Years value={entry.yearsInRole} />
              </CardField>
            </dl>
            <div className="mt-2">
              <CardField label={skillsSurveyFieldLabels.developmentPriorities}>
                <span className="whitespace-pre-line">{entry.developmentPriorities || "-"}</span>
              </CardField>
            </div>
            <Link className={cn(phxButtonGhostClassName, "mt-3 w-full justify-center")} href={href(entry)}>
              View the survey
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SurveyTab({ data, memberHrefBase }: { data: SkillsSurveyWorkspaceData; memberHrefBase: string }) {
  const quarterKey = skillsSurveyQuarterKey(data.quarter.year, data.quarter.quarter);
  const ratedCount = data.team.filter((member) => member.rated).length;
  return (
    <div className="space-y-4">
      <SurveyPanel lead={skillsSurveyInstructions.lead} title={skillsSurveyInstructions.heading}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
          <ol className="divide-y divide-slate-100 border border-slate-200">
            {skillsSurveyInstructions.steps.map((text, index) => (
              <li className="flex gap-3 px-4 py-2.5" key={text}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center border border-slate-300 text-phx-2xs font-black tabular-nums text-slate-500">
                  {index + 1}
                </span>
                <span className="min-w-0 text-sm leading-6 text-slate-700">{text}</span>
              </li>
            ))}
          </ol>
          <div className="flex items-start gap-2.5 border border-orange-200 bg-orange-50 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
            <p className="text-sm leading-6 text-slate-700">{skillsSurveyInstructions.privacy}</p>
          </div>
        </div>
      </SurveyPanel>

      {data.viewer.canRate ? (
        <SurveyPanel
          action={
            <p className="shrink-0 text-sm font-black tabular-nums text-slate-900">
              {ratedCount}
              <span className="font-bold text-slate-400"> / {data.team.length} rated</span>
            </p>
          }
          lead="Each team member is rated once a quarter. You can change a survey until the quarter ends."
          title={`Your team · ${skillsSurveyQuarterLabel(data.quarter.year, data.quarter.quarter)}`}
        >
          {data.team.length === 0 ? (
            <p className="text-sm text-slate-500">No Medical Representatives report to you yet.</p>
          ) : (
            <TeamTable data={data} memberHrefBase={memberHrefBase} />
          )}
        </SurveyPanel>
      ) : (
        <SurveyPanel
          action={
            <p className="shrink-0 text-sm font-black tabular-nums text-slate-900">
              {data.entries.length}
              <span className="font-bold text-slate-400"> {data.entries.length === 1 ? "survey" : "surveys"}</span>
            </p>
          }
          title={`Surveys · ${skillsSurveyQuarterLabel(data.quarter.year, data.quarter.quarter)}`}
        >
          {data.entries.length === 0 ? (
            <p className="text-sm text-slate-500">No surveys have been saved for this quarter yet.</p>
          ) : (
            <SurveysTable entries={data.entries} memberHrefBase={memberHrefBase} quarterKey={quarterKey} />
          )}
        </SurveyPanel>
      )}
    </div>
  );
}

// ─── Ranking tab ──────────────────────────────────────────────────────────────

function RankingSettings({ data }: { data: SkillsSurveyWorkspaceData }) {
  const settings = data.config.settings;
  const editable = data.viewer.canEditSettings;
  const [weight, setWeight] = useState(String(Math.round(settings.capabilityWeight * 100)));
  const [years, setYears] = useState(String(settings.fullExperienceYears));
  const { error, message, save, saving } = useSettingsSave();
  const weightNumber = Number(weight);
  const experienceWeight = Number.isFinite(weightNumber) ? Math.max(0, 100 - weightNumber) : null;

  return (
    <SurveyPanel lead={skillsSurveyOverallFormula(settings.capabilityWeight, settings.fullExperienceYears)} title="Settings">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="min-w-0">
          <FieldLabel htmlFor="skills-survey-weight">{skillsSurveyRankingLabels.capabilityWeight}</FieldLabel>
          {editable ? (
            <div className="flex items-stretch">
              <input
                className={phxFieldClassName}
                id="skills-survey-weight"
                inputMode="numeric"
                max={100}
                min={0}
                onChange={(event) => setWeight(event.target.value)}
                type="number"
                value={weight}
              />
              <span className="flex items-center border border-l-0 border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-500">%</span>
            </div>
          ) : (
            <p className="text-2xl font-black tabular-nums text-slate-900">{Math.round(settings.capabilityWeight * 100)}%</p>
          )}
          <span className="mt-1 block text-xs leading-relaxed text-slate-400">{skillsSurveyRankingLabels.capabilityWeightNote}</span>
        </div>
        <div className="min-w-0">
          <FieldLabel>{skillsSurveyRankingLabels.experienceWeight}</FieldLabel>
          <p className="flex min-h-[42px] items-center text-2xl font-black tabular-nums text-slate-900">
            {editable ? (experienceWeight === null ? "-" : `${experienceWeight}%`) : `${100 - Math.round(settings.capabilityWeight * 100)}%`}
          </p>
        </div>
        <div className="min-w-0">
          <FieldLabel htmlFor="skills-survey-years">{skillsSurveyRankingLabels.fullExperienceYears}</FieldLabel>
          {editable ? (
            <input
              className={phxFieldClassName}
              id="skills-survey-years"
              inputMode="decimal"
              min={0.5}
              onChange={(event) => setYears(event.target.value)}
              step={0.5}
              type="number"
              value={years}
            />
          ) : (
            <p className="text-2xl font-black tabular-nums text-slate-900">{settings.fullExperienceYears}</p>
          )}
          <span className="mt-1 block text-xs leading-relaxed text-slate-400">{skillsSurveyRankingLabels.fullExperienceYearsNote}</span>
        </div>
      </div>
      {editable ? (
        <SaveRow
          error={error}
          message={message}
          onSave={() =>
            void save({
              settings: { capabilityWeight: Number(weight) / 100, fullExperienceYears: Number(years) },
            })
          }
          saving={saving}
        />
      ) : null}
    </SurveyPanel>
  );
}

function RankingTab({ data }: { data: SkillsSurveyWorkspaceData }) {
  const rows = useMemo(() => buildSkillsSurveyRanking(data.entries, data.config.settings), [data]);
  const labels = skillsSurveyRankingLabels;

  return (
    <div className="space-y-4">
      <RankingSettings data={data} key={`${data.config.settings.capabilityWeight}-${data.config.settings.fullExperienceYears}`} />
      <SurveyPanel lead={labels.lead} title={`${labels.heading} · ${skillsSurveyQuarterLabel(data.quarter.year, data.quarter.quarter)}`}>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No team member has been rated in this quarter yet.</p>
        ) : (
          <div className="@container min-w-0">
            <table className="hidden w-full table-fixed border-collapse text-xs @min-[1080px]:table">
              <colgroup>
                <col className="w-[7%]" />
                <col className="w-[15%]" />
                <col className="w-[12%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead>
                <tr className={surveyHeadRow}>
                  <th className={surveyHeadCell} scope="col">{labels.overallRank}</th>
                  <th className={surveyHeadCell} scope="col">{labels.teamMember}</th>
                  <th className={surveyHeadCell} scope="col">{labels.district}</th>
                  <th className={surveyHeadCell} scope="col">{labels.districtManager}</th>
                  <th className={surveyHeadCell} scope="col">{labels.yearsInRole}</th>
                  <th className={surveyHeadCell} scope="col">{labels.capabilityAverage}</th>
                  <th className={surveyHeadCell} scope="col">{labels.capabilityRank}</th>
                  <th className={surveyHeadCell} scope="col">{labels.experienceScore}</th>
                  <th className={surveyHeadCell} scope="col">{labels.overallScore}</th>
                  <th className={surveyHeadCell} scope="col">{labels.performanceLevel}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className={surveyBodyRow} key={row.entry.id}>
                    <td className={cn(surveyBodyCell, "text-base font-black tabular-nums text-slate-900")}>{row.overallRank}</td>
                    <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>{row.entry.memberName}</td>
                    <td className={cn(surveyBodyCell, "text-slate-700")}>{row.entry.districtName ?? "-"}</td>
                    <td className={cn(surveyBodyCell, "text-slate-700")}>{row.entry.raterName}</td>
                    <td className={surveyBodyCell}>
                      <Years value={row.entry.yearsInRole} />
                    </td>
                    <td className={surveyBodyCell}>
                      <Score value={row.capabilityAverage} />
                    </td>
                    <td className={cn(surveyBodyCell, "tabular-nums text-slate-700")}>{row.capabilityRank}</td>
                    <td className={surveyBodyCell}>
                      <Score value={row.experienceScore} />
                    </td>
                    <td className={cn(surveyBodyCell, "font-black text-slate-900")}>
                      <Score value={row.overallScore} />
                    </td>
                    <td className={surveyBodyCell}>
                      <PerformanceLevelText level={row.performanceLevel} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="hidden w-full table-fixed border-collapse text-xs @min-[700px]:table @min-[1080px]:hidden">
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[34%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead>
                <tr className={surveyHeadRow}>
                  <th className={surveyHeadCell} scope="col">
                    {labels.overallRank} · {labels.capabilityRank}
                  </th>
                  <th className={surveyHeadCell} scope="col">
                    {labels.teamMember} · {labels.district} · {labels.districtManager}
                  </th>
                  <th className={surveyHeadCell} scope="col">
                    {labels.yearsInRole} · {labels.experienceScore}
                  </th>
                  <th className={surveyHeadCell} scope="col">
                    {labels.capabilityAverage} · {labels.overallScore}
                  </th>
                  <th className={surveyHeadCell} scope="col">{labels.performanceLevel}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className={surveyBodyRow} key={row.entry.id}>
                    <td className={surveyBodyCell}>
                      <p className="text-base font-black tabular-nums text-slate-900">{row.overallRank}</p>
                      <p className="tabular-nums text-slate-500">{row.capabilityRank}</p>
                    </td>
                    <td className={surveyBodyCell}>
                      <p className="font-bold text-slate-900">{row.entry.memberName}</p>
                      <p className="mt-0.5 text-slate-600">{row.entry.districtName ?? "-"}</p>
                      <p className="text-slate-500">{row.entry.raterName}</p>
                    </td>
                    <td className={surveyBodyCell}>
                      <p>
                        <Years value={row.entry.yearsInRole} />
                      </p>
                      <p className="text-slate-500">
                        <Score value={row.experienceScore} />
                      </p>
                    </td>
                    <td className={surveyBodyCell}>
                      <p className="text-slate-600">
                        <Score value={row.capabilityAverage} />
                      </p>
                      <p className="text-sm font-black text-slate-900">
                        <Score value={row.overallScore} />
                      </p>
                    </td>
                    <td className={surveyBodyCell}>
                      <PerformanceLevelText level={row.performanceLevel} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ol className="space-y-2 @min-[700px]:hidden">
              {rows.map((row) => (
                <li className="border border-slate-200 bg-white p-3 text-xs" key={row.entry.id}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-sm font-black tabular-nums text-white">
                      {row.overallRank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-black text-slate-900">{row.entry.memberName}</p>
                      <p className="mt-0.5 text-slate-500">
                        {row.entry.districtName ?? "-"} · {row.entry.raterName}
                      </p>
                    </div>
                    <p className="shrink-0 text-right text-lg font-black tabular-nums text-slate-900">
                      <Score value={row.overallScore} />
                    </p>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 @min-[420px]:grid-cols-4">
                    <CardField label={labels.yearsInRole}>
                      <Years value={row.entry.yearsInRole} />
                    </CardField>
                    <CardField label={labels.capabilityAverage}>
                      <Score value={row.capabilityAverage} />
                    </CardField>
                    <CardField label={labels.capabilityRank}>{row.capabilityRank}</CardField>
                    <CardField label={labels.experienceScore}>
                      <Score value={row.experienceScore} />
                    </CardField>
                  </dl>
                  <p className="mt-2">
                    <PerformanceLevelText level={row.performanceLevel} />
                  </p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </SurveyPanel>
    </div>
  );
}

// ─── Analysis tab ─────────────────────────────────────────────────────────────

function Figure({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="min-w-0 border border-slate-200 bg-white px-4 py-3">
      <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <div className="mt-1 text-2xl font-black tabular-nums text-slate-900">{children}</div>
      {note ? <p className="mt-1 text-xs leading-relaxed text-slate-400">{note}</p> : null}
    </div>
  );
}

function TargetFigure({ data }: { data: SkillsSurveyWorkspaceData }) {
  const [target, setTarget] = useState(String(data.config.settings.targetScore));
  const { error, message, save, saving } = useSettingsSave();
  const labels = skillsSurveyAnalysisLabels;
  if (!data.viewer.canEditSettings) {
    return (
      <Figure label={labels.targetScore} note={labels.targetScoreNote}>
        {data.config.settings.targetScore.toFixed(1)}
      </Figure>
    );
  }
  return (
    <div className="min-w-0 border border-slate-200 bg-white px-4 py-3">
      <label className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500" htmlFor="skills-survey-target">
        {labels.targetScore}
      </label>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          className={cn(phxFieldClassName, "text-lg font-black tabular-nums")}
          id="skills-survey-target"
          inputMode="decimal"
          max={5}
          min={0}
          onChange={(event) => setTarget(event.target.value)}
          step={0.1}
          type="number"
          value={target}
        />
        <button
          className={phxButtonAccentClassName}
          disabled={saving}
          onClick={() => void save({ settings: { targetScore: Number(target) } })}
          type="button"
        >
          {saving ? "Saving" : "Save"}
        </button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{labels.targetScoreNote}</p>
      {error ? <FormError className="mt-2">{error}</FormError> : null}
      {message && !error ? <p className="mt-2 text-xs font-bold text-emerald-700">{message}</p> : null}
    </div>
  );
}

function SkillAveragesGrid({ row, skills }: { row: SkillsSurveyGroupAverageRow; skills: SkillsSurveySkill[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-3">
      {skills.map((skill) => (
        <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-0.5" key={skill.key}>
          <dt className="min-w-0 break-words text-slate-600">{skill.name}</dt>
          <dd className="shrink-0 font-bold text-slate-900">
            <Score value={row.skillAverages[skill.key]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function GroupAverages({
  rows,
  skills,
  groupLabel,
  bandNote,
}: {
  rows: Array<SkillsSurveyGroupAverageRow & { from?: number; to?: number }>;
  skills: SkillsSurveySkill[];
  groupLabel: string;
  bandNote?: boolean;
}) {
  const labels = skillsSurveyAnalysisLabels;
  return (
    <ul className="@container min-w-0 space-y-2">
      {rows.map((row) => (
        <li className="border border-slate-200 bg-white text-xs" key={row.label}>
          <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between">
            <div className="min-w-0">
              <p className="text-phx-2xs font-bold uppercase text-slate-400">{groupLabel}</p>
              <p className="break-words text-sm font-black text-slate-900">
                {row.label}
                {bandNote && row.from !== undefined && row.to !== undefined ? (
                  <span className="ml-2 text-xs font-bold text-slate-400">
                    {row.from} to {row.to} years
                  </span>
                ) : null}
              </p>
            </div>
            <dl className="flex shrink-0 gap-6">
              <div>
                <dt className="text-phx-2xs font-bold uppercase text-slate-400">{labels.teamMembers}</dt>
                <dd className="text-sm font-black tabular-nums text-slate-900">{row.teamMembers}</dd>
              </div>
              <div>
                <dt className="text-phx-2xs font-bold uppercase text-slate-400">{labels.overallAverage}</dt>
                <dd className="text-sm font-black text-slate-900">
                  <Score value={row.overallAverage} />
                </dd>
              </div>
            </dl>
          </div>
          {row.teamMembers > 0 ? (
            <div className="px-3 py-2">
              <SkillAveragesGrid row={row} skills={skills} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BandSettings({ data }: { data: SkillsSurveyWorkspaceData }) {
  const [bands, setBands] = useState<Array<{ label: string; from: string; to: string }>>(() =>
    data.config.settings.experienceBands.map((band) => ({ from: String(band.from), label: band.label, to: String(band.to) })),
  );
  const { error, message, save, saving } = useSettingsSave();
  const labels = skillsSurveyAnalysisLabels;
  const update = (index: number, patch: Partial<{ label: string; from: string; to: string }>) =>
    setBands((current) => current.map((band, position) => (position === index ? { ...band, ...patch } : band)));

  return (
    <div className="mt-4 border border-slate-200">
      <FormBlockHeader label="Experience bands" />
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-slate-500">{labels.bandsNote}</p>
        {bands.map((band, index) => (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" key={index}>
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <FieldLabel htmlFor={`band-label-${index}`}>{labels.bandColumn}</FieldLabel>
              <input
                className={phxFieldClassName}
                id={`band-label-${index}`}
                onChange={(event) => update(index, { label: event.target.value })}
                value={band.label}
              />
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor={`band-from-${index}`}>{labels.bandFrom}</FieldLabel>
              <input
                className={phxFieldClassName}
                id={`band-from-${index}`}
                inputMode="decimal"
                onChange={(event) => update(index, { from: event.target.value })}
                type="number"
                value={band.from}
              />
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor={`band-to-${index}`}>{labels.bandTo}</FieldLabel>
              <input
                className={phxFieldClassName}
                id={`band-to-${index}`}
                inputMode="decimal"
                onChange={(event) => update(index, { to: event.target.value })}
                type="number"
                value={band.to}
              />
            </div>
            <div className="col-span-2 flex items-end sm:col-span-1">
              <button
                className={cn(phxButtonGhostClassName, "w-full justify-center")}
                disabled={bands.length === 1}
                onClick={() => setBands((current) => current.filter((_, position) => position !== index))}
                type="button"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <button
          className={phxButtonAddBlockClassName}
          onClick={() => setBands((current) => [...current, { from: "", label: "", to: "" }])}
          type="button"
        >
          <Plus className="h-4 w-4" />
          Add a band
        </button>
        <SaveRow
          error={error}
          label="Save the bands"
          message={message}
          onSave={() =>
            void save({
              settings: {
                experienceBands: bands.map(
                  (band): SkillsSurveyExperienceBand => ({ from: Number(band.from), label: band.label, to: Number(band.to) }),
                ),
              },
            })
          }
          saving={saving}
        />
      </div>
    </div>
  );
}

function AnalysisTab({ data }: { data: SkillsSurveyWorkspaceData }) {
  const labels = skillsSurveyAnalysisLabels;
  const analysis = useMemo(
    () => buildSkillsSurveyAnalysis(data.entries, data.config.skills, data.config.settings),
    [data],
  );
  const shownSkills = useMemo(() => skillsForAnalysis(data.config.skills, data.entries), [data]);
  const districts = useMemo(() => buildSkillsSurveyDistrictAverages(data.entries, data.config.skills), [data]);
  const bands = useMemo(
    () => buildSkillsSurveyExperienceBandAverages(data.entries, data.config.skills, data.config.settings),
    [data],
  );
  const byNeed = [...analysis.skills].sort(
    (left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER),
  );

  return (
    <div className="space-y-4">
      <SurveyPanel lead={labels.lead} title={`${labels.heading} · ${skillsSurveyQuarterLabel(data.quarter.year, data.quarter.quarter)}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TargetFigure data={data} key={data.config.settings.targetScore} />
          <Figure label={labels.teamMembersRated}>{analysis.teamMembersRated}</Figure>
          <Figure label={labels.overallAverage}>
            <Score value={analysis.overallAverage} />
          </Figure>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{labels.priorityLevels}</p>

        <div className="@container mt-4 min-w-0">
          <table className="hidden w-full table-fixed border-collapse text-xs @min-[860px]:table">
            <colgroup>
              <col className="w-[9%]" />
              <col className="w-[25%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[11%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr className={surveyHeadRow}>
                <th className={surveyHeadCell} scope="col">{labels.rank}</th>
                <th className={surveyHeadCell} scope="col">{labels.skill}</th>
                <th className={surveyHeadCell} scope="col">{labels.averageScore}</th>
                <th className={surveyHeadCell} scope="col">{labels.ratingsCount}</th>
                <th className={surveyHeadCell} scope="col">{labels.ratedLow}</th>
                <th className={surveyHeadCell} scope="col">{labels.ratedHigh}</th>
                <th className={surveyHeadCell} scope="col">{labels.gapToTarget}</th>
                <th className={surveyHeadCell} scope="col">{labels.trainingPriority}</th>
              </tr>
            </thead>
            <tbody>
              {byNeed.map((row) => (
                <tr className={surveyBodyRow} key={row.skill.key}>
                  <td className={cn(surveyBodyCell, "text-base font-black tabular-nums text-slate-900")}>{row.rank ?? "-"}</td>
                  <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                    {row.skill.name}
                    {!row.skill.isActive ? <span className="ml-1 font-semibold text-slate-400">(turned off)</span> : null}
                  </td>
                  <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>
                    <Score value={row.averageScore} />
                  </td>
                  <td className={cn(surveyBodyCell, "tabular-nums text-slate-700")}>{row.ratingsCount}</td>
                  <td className={surveyBodyCell}>
                    <Share value={row.shareRatedLow} />
                  </td>
                  <td className={surveyBodyCell}>
                    <Share value={row.shareRatedHigh} />
                  </td>
                  <td className={surveyBodyCell}>
                    <Score value={row.gapToTarget} />
                  </td>
                  <td className={surveyBodyCell}>
                    <TrainingPriorityText priority={row.trainingPriority} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ol className="space-y-2 @min-[860px]:hidden">
            {byNeed.map((row) => (
              <li className="border border-slate-200 bg-white p-3 text-xs" key={row.skill.key}>
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-sm font-black tabular-nums text-white">
                    {row.rank ?? "-"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-black text-slate-900">{row.skill.name}</p>
                    <p className="mt-0.5">
                      <TrainingPriorityText priority={row.trainingPriority} />
                    </p>
                  </div>
                  <p className="shrink-0 text-right text-lg font-black text-slate-900">
                    <Score value={row.averageScore} />
                  </p>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 @min-[420px]:grid-cols-4">
                  <CardField label={labels.ratingsCount}>{row.ratingsCount}</CardField>
                  <CardField label={labels.ratedLow}>
                    <Share value={row.shareRatedLow} />
                  </CardField>
                  <CardField label={labels.ratedHigh}>
                    <Share value={row.shareRatedHigh} />
                  </CardField>
                  <CardField label={labels.gapToTarget}>
                    <Score value={row.gapToTarget} />
                  </CardField>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      </SurveyPanel>

      <SurveyPanel title={labels.byDistrict}>
        {districts.length === 0 ? (
          <p className="text-sm text-slate-500">No team member has been rated in this quarter yet.</p>
        ) : (
          <GroupAverages groupLabel={labels.districtColumn} rows={districts} skills={shownSkills} />
        )}
      </SurveyPanel>

      <SurveyPanel lead={labels.bandsNote} title={labels.byExperienceBand}>
        <GroupAverages bandNote groupLabel={labels.bandColumn} rows={bands} skills={shownSkills} />
        {data.viewer.canEditSettings ? (
          <BandSettings data={data} key={JSON.stringify(data.config.settings.experienceBands)} />
        ) : null}
      </SurveyPanel>
    </div>
  );
}

// ─── Skills tab ───────────────────────────────────────────────────────────────

type SkillDraft = { key: string | null; name: string; goodLooksLike: string; isActive: boolean; localId: string };

function SkillsEditor({ data }: { data: SkillsSurveyWorkspaceData }) {
  const [drafts, setDrafts] = useState<SkillDraft[]>(() =>
    data.config.skills.map((skill) => ({
      goodLooksLike: skill.goodLooksLike,
      isActive: skill.isActive,
      key: skill.key,
      localId: skill.key,
      name: skill.name,
    })),
  );
  const { error, message, save, saving } = useSettingsSave();
  const update = (index: number, patch: Partial<SkillDraft>) =>
    setDrafts((current) => current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)));
  const move = (index: number, by: number) =>
    setDrafts((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <div className="space-y-3">
      {drafts.map((draft, index) => (
        <div className={cn("border", draft.isActive ? "border-slate-200" : "border-dashed border-slate-300 bg-slate-50")} key={draft.localId}>
          <FormBlockHeader
            action={
              <span className="flex shrink-0 items-center gap-1">
                <button
                  aria-label={`Move ${draft.name || "this skill"} up`}
                  className={cn(phxButtonGhostClassName, "px-2")}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  type="button"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
                <button
                  aria-label={`Move ${draft.name || "this skill"} down`}
                  className={cn(phxButtonGhostClassName, "px-2")}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                  type="button"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              </span>
            }
            label={
              <span className="break-words">
                <span className="tabular-nums text-slate-400">{String(index + 1).padStart(2, "0")}</span>{" "}
                {draft.name || "New skill"}
              </span>
            }
          />
          <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="min-w-0">
              <FieldLabel htmlFor={`skill-name-${draft.localId}`} required>
                {skillsSurveySkillsLabels.skill}
              </FieldLabel>
              <input
                className={phxFieldClassName}
                id={`skill-name-${draft.localId}`}
                maxLength={120}
                onChange={(event) => update(index, { name: event.target.value })}
                value={draft.name}
              />
              <CheckTile checked={draft.isActive} className="mt-3" onChange={(next) => update(index, { isActive: next })}>
                Used in the survey
              </CheckTile>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor={`skill-good-${draft.localId}`}>{skillsSurveySkillsLabels.goodLooksLike}</FieldLabel>
              <textarea
                className={phxTextareaClassName}
                id={`skill-good-${draft.localId}`}
                maxLength={600}
                onChange={(event) => update(index, { goodLooksLike: event.target.value })}
                rows={3}
                value={draft.goodLooksLike}
              />
            </div>
          </div>
        </div>
      ))}
      <button
        className={phxButtonAddBlockClassName}
        onClick={() =>
          setDrafts((current) => [
            ...current,
            { goodLooksLike: "", isActive: true, key: null, localId: `new-${Date.now()}`, name: "" },
          ])
        }
        type="button"
      >
        <Plus className="h-4 w-4" />
        Add a skill
      </button>
      <p className="text-xs leading-relaxed text-slate-500">
        A skill that is turned off leaves the form, but its old ratings stay in the analysis of the quarters that used it.
      </p>
      <SaveRow
        error={error}
        label="Save the skills"
        message={message}
        onSave={() =>
          void save({
            skills: drafts.map((draft) => ({
              goodLooksLike: draft.goodLooksLike,
              isActive: draft.isActive,
              key: draft.key,
              name: draft.name,
            })),
          })
        }
        saving={saving}
      />
    </div>
  );
}

function SkillsTab({ data }: { data: SkillsSurveyWorkspaceData }) {
  const skills = [...data.config.skills].sort((left, right) => left.displayOrder - right.displayOrder);
  const anyOff = skills.some((skill) => !skill.isActive);
  return (
    <SurveyPanel lead={skillsSurveySkillsLabels.lead} title={skillsSurveySkillsLabels.heading}>
      {data.viewer.canEditSettings ? (
        <SkillsEditor data={data} key={JSON.stringify(skills)} />
      ) : (
        <div className="@container min-w-0">
          <table className="hidden w-full table-fixed border-collapse text-xs @min-[640px]:table">
            <colgroup>
              <col className="w-[7%]" />
              <col className={anyOff ? "w-[25%]" : "w-[30%]"} />
              <col className={anyOff ? "w-[56%]" : "w-[63%]"} />
              {anyOff ? <col className="w-[12%]" /> : null}
            </colgroup>
            <thead>
              <tr className={surveyHeadRow}>
                <th className={surveyHeadCell} scope="col">{skillsSurveySkillsLabels.number}</th>
                <th className={surveyHeadCell} scope="col">{skillsSurveySkillsLabels.skill}</th>
                <th className={surveyHeadCell} scope="col">{skillsSurveySkillsLabels.goodLooksLike}</th>
                {anyOff ? <th className={surveyHeadCell} scope="col">In the survey</th> : null}
              </tr>
            </thead>
            <tbody>
              {skills.map((skill, index) => (
                <tr className={surveyBodyRow} key={skill.key}>
                  <td className={cn(surveyBodyCell, "font-black tabular-nums text-slate-400")}>{index + 1}</td>
                  <td className={cn(surveyBodyCell, "font-bold text-slate-900")}>{skill.name}</td>
                  <td className={cn(surveyBodyCell, "text-slate-700")}>{skill.goodLooksLike}</td>
                  {anyOff ? (
                    <td className={cn(surveyBodyCell, skill.isActive ? "text-emerald-700" : "text-slate-400", "font-bold")}>
                      {skill.isActive ? "Yes" : "Turned off"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <ol className="space-y-2 @min-[640px]:hidden">
            {skills.map((skill, index) => (
              <li className="border border-slate-200 bg-white p-3 text-xs" key={skill.key}>
                <p className="text-sm font-black text-slate-900">
                  <span className="tabular-nums text-slate-400">{index + 1}.</span> {skill.name}
                  {!skill.isActive ? <span className="ml-1 text-xs font-bold text-slate-400">(turned off)</span> : null}
                </p>
                <p className="mt-1 leading-relaxed text-slate-700">{skill.goodLooksLike}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </SurveyPanel>
  );
}

// ─── The screen ───────────────────────────────────────────────────────────────

export function SkillsSurveyWorkspace({
  data,
  initialTab = "survey",
  memberHrefBase,
}: {
  data: SkillsSurveyWorkspaceData;
  initialTab?: SkillsSurveyTab;
  /** Where one team member's form lives, e.g. /employee-portals/coaching-skills-survey. */
  memberHrefBase: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<SkillsSurveyTab>(initialTab);
  const quarterKey = skillsSurveyQuarterKey(data.quarter.year, data.quarter.quarter);

  const go = (nextTab: SkillsSurveyTab, nextQuarter: string) => {
    const params = new URLSearchParams();
    if (nextTab !== "survey") params.set("tab", nextTab);
    const current = skillsSurveyQuarterKey(data.currentQuarter.year, data.currentQuarter.quarter);
    if (nextQuarter !== current) params.set("quarter", nextQuarter);
    const query = params.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 border border-slate-200 bg-white lg:flex-row lg:items-stretch lg:justify-between">
        <nav aria-label="Survey sheets" className="grid grid-cols-4">
          {tabOrder.map((key) => {
            const active = key === tab;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative px-3 py-3 text-center text-phx-xs font-black uppercase tracking-wide transition sm:px-6",
                  active ? "bg-orange-50 text-slate-900" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
                )}
                key={key}
                onClick={() => {
                  setTab(key);
                  router.replace(go(key, quarterKey), { scroll: false });
                }}
                type="button"
              >
                {active ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-orange-500" /> : null}
                {skillsSurveyTabs[key]}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-2.5 lg:border-l lg:border-t-0">
          <label className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500" htmlFor="skills-survey-quarter">
            Quarter
          </label>
          <select
            className={cn(phxSelectClassName, "w-auto min-w-[9rem]")}
            id="skills-survey-quarter"
            onChange={(event) => router.push(go(tab, event.target.value))}
            value={quarterKey}
          >
            {data.quarters.map((quarter) => {
              const key = skillsSurveyQuarterKey(quarter.year, quarter.quarter);
              const isCurrent =
                quarter.year === data.currentQuarter.year && quarter.quarter === data.currentQuarter.quarter;
              return (
                <option key={key} value={key}>
                  {skillsSurveyQuarterLabel(quarter.year, quarter.quarter)}
                  {isCurrent ? " (this quarter)" : ""}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {tab === "survey" && <SurveyTab data={data} memberHrefBase={memberHrefBase} />}
      {tab === "ranking" && <RankingTab data={data} />}
      {tab === "analysis" && <AnalysisTab data={data} />}
      {tab === "skills" && <SkillsTab data={data} />}
    </div>
  );
}
