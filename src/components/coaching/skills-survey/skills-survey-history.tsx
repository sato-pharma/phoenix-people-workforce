import Link from "next/link";

import {
  CardField,
  formatSurveyDate,
  PerformanceLevelText,
  Score,
  surveyBodyCell,
  surveyBodyRow,
  surveyHeadCell,
  surveyHeadRow,
} from "@/components/coaching/skills-survey/skills-survey-parts";
import {
  scoreSkillsSurveyEntry,
  skillsSurveyQuarterLabel,
  type SkillsSurveyEntry,
  type SkillsSurveySkill,
} from "@/lib/coaching/skills-survey/calculations";
import type { SkillsSurveyConfig } from "@/lib/coaching/skills-survey/service";
import {
  skillsSurveyFieldLabels,
  skillsSurveyRankingLabels,
  skillsSurveySkillsLabels,
} from "@/lib/coaching/skills-survey/vocabulary";

// One team member's Team Coaching Skills Survey, quarter by quarter, for the managers who open their
// Employee 360 (owner, 2026-10-31). The person rated never reaches this: the two Employee 360 detail
// pages pass it only when the viewer is someone else and the survey's own read rule allows it.
//
// Fits the screen: from 640px of its own width it is a table, one column per quarter, four quarters
// to a table (newest first) so a long history adds tables rather than squeezing columns; below that,
// one card per quarter. Every cell wraps — nothing is cut with an ellipsis.

export type SkillsSurveyHistoryData = { config: SkillsSurveyConfig; entries: SkillsSurveyEntry[] };

const QUARTERS_PER_TABLE = 4;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** The skills to list: every active one, plus a retired one that still carries a score in this history. */
function skillsToShow(skills: readonly SkillsSurveySkill[], entries: readonly SkillsSurveyEntry[]): SkillsSurveySkill[] {
  const scored = new Set(entries.flatMap((entry) => Object.keys(entry.scores)));
  return skills
    .filter((skill) => skill.isActive || scored.has(skill.key))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export function SkillsSurveyHistory({
  history,
  memberHref,
}: {
  history: SkillsSurveyHistoryData;
  /** The member's survey page in the viewer's shell. */
  memberHref: string;
}) {
  const { config, entries } = history;
  const newestFirst = [...entries].sort(
    (left, right) => right.surveyYear - left.surveyYear || right.surveyQuarter - left.surveyQuarter,
  );
  const skills = skillsToShow(config.skills, newestFirst);
  const scored = newestFirst.map((entry) => ({ entry, card: scoreSkillsSurveyEntry(entry, config.settings) }));

  if (scored.length === 0) {
    return (
      <div className="space-y-3 text-sm text-slate-600">
        <p>No survey yet for this team member.</p>
        <Link className="font-bold text-orange-700 underline-offset-2 hover:underline" href={memberHref}>
          Open the survey
        </Link>
      </div>
    );
  }

  return (
    <div className="@container space-y-4">
      {/* Phone and narrow columns: one card per quarter. */}
      <div className="space-y-3 @[640px]:hidden">
        {scored.map(({ entry, card }) => (
          <article className="border border-slate-200 bg-white" key={entry.id}>
            <header className="flex items-baseline justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
              <span className="text-sm font-black text-slate-900">
                {skillsSurveyQuarterLabel(entry.surveyYear, entry.surveyQuarter)}
              </span>
              <PerformanceLevelText level={card.performanceLevel} />
            </header>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-3 text-sm">
              <CardField label={skillsSurveyFieldLabels.average}>
                <Score value={card.capabilityAverage} />
              </CardField>
              <CardField label={skillsSurveyRankingLabels.overallScore}>
                <Score value={card.overallScore} />
              </CardField>
              {skills.map((skill) => (
                <CardField key={skill.key} label={skill.name}>
                  <Score digits={0} value={entry.scores[skill.key]} />
                </CardField>
              ))}
              <div className="col-span-2">
                <CardField label={skillsSurveyFieldLabels.developmentPriorities}>
                  {entry.developmentPriorities?.trim() || <span className="text-slate-400">-</span>}
                </CardField>
              </div>
              <CardField label={skillsSurveyFieldLabels.districtManager}>{entry.raterName}</CardField>
              <CardField label={skillsSurveyFieldLabels.date}>{formatSurveyDate(entry.surveyDate)}</CardField>
            </dl>
          </article>
        ))}
      </div>

      {/* Wide: one column per quarter. */}
      <div className="hidden space-y-4 @[640px]:block">
        {chunk(scored, QUARTERS_PER_TABLE).map((group) => (
          <table className="w-full table-fixed border-collapse text-left text-sm" key={group[0].entry.id}>
            <colgroup>
              <col className="w-[28%]" />
              {group.map(({ entry }) => (
                <col key={entry.id} />
              ))}
            </colgroup>
            <thead>
              <tr className={surveyHeadRow}>
                <th className={surveyHeadCell} scope="col">
                  {skillsSurveySkillsLabels.skill}
                </th>
                {group.map(({ entry }) => (
                  <th className={surveyHeadCell} key={entry.id} scope="col">
                    {skillsSurveyQuarterLabel(entry.surveyYear, entry.surveyQuarter)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr className={surveyBodyRow} key={skill.key}>
                  <th className={`${surveyBodyCell} font-bold text-slate-800`} scope="row">
                    {skill.name}
                  </th>
                  {group.map(({ entry }) => (
                    <td className={surveyBodyCell} key={entry.id}>
                      <Score digits={0} value={entry.scores[skill.key]} />
                    </td>
                  ))}
                </tr>
              ))}
              <tr className={`${surveyBodyRow} font-bold`}>
                <th className={`${surveyBodyCell} text-slate-900`} scope="row">
                  {skillsSurveyFieldLabels.average}
                </th>
                {group.map(({ entry, card }) => (
                  <td className={surveyBodyCell} key={entry.id}>
                    <Score value={card.capabilityAverage} />
                  </td>
                ))}
              </tr>
              <tr className={`${surveyBodyRow} font-bold`}>
                <th className={`${surveyBodyCell} text-slate-900`} scope="row">
                  {skillsSurveyRankingLabels.overallScore}
                </th>
                {group.map(({ entry, card }) => (
                  <td className={surveyBodyCell} key={entry.id}>
                    <Score value={card.overallScore} />
                  </td>
                ))}
              </tr>
              <tr className={surveyBodyRow}>
                <th className={`${surveyBodyCell} font-bold text-slate-800`} scope="row">
                  {skillsSurveyRankingLabels.performanceLevel}
                </th>
                {group.map(({ entry, card }) => (
                  <td className={surveyBodyCell} key={entry.id}>
                    <PerformanceLevelText level={card.performanceLevel} />
                  </td>
                ))}
              </tr>
              <tr className={surveyBodyRow}>
                <th className={`${surveyBodyCell} font-bold text-slate-800`} scope="row">
                  {skillsSurveyFieldLabels.developmentPriorities}
                </th>
                {group.map(({ entry }) => (
                  <td className={`${surveyBodyCell} whitespace-pre-line`} key={entry.id}>
                    {entry.developmentPriorities?.trim() || <span className="text-slate-400">-</span>}
                  </td>
                ))}
              </tr>
              <tr className={surveyBodyRow}>
                <th className={`${surveyBodyCell} font-bold text-slate-800`} scope="row">
                  {skillsSurveyFieldLabels.districtManager}
                </th>
                {group.map(({ entry }) => (
                  <td className={surveyBodyCell} key={entry.id}>
                    {entry.raterName}
                    <span className="block text-xs text-slate-500">{formatSurveyDate(entry.surveyDate)}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        ))}
      </div>

      <Link className="inline-block text-sm font-bold text-orange-700 underline-offset-2 hover:underline" href={memberHref}>
        Open the survey
      </Link>
    </div>
  );
}
