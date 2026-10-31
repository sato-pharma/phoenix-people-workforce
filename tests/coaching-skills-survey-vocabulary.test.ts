import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  skillsSurveyAnalysisLabels,
  skillsSurveyDefaultExperienceBands,
  skillsSurveyDefaultSkills,
  skillsSurveyFieldLabels,
  skillsSurveyInstructions,
  skillsSurveyNotObserved,
  skillsSurveyOverallFormula,
  skillsSurveyPerformanceLevels,
  skillsSurveyRankingLabels,
  skillsSurveyRatingScale,
  skillsSurveySkillsLabels,
  skillsSurveyTitle,
  skillsSurveyTrainingPriorities,
} from "../src/lib/coaching/skills-survey/vocabulary.ts";

// THE TEAM COACHING SKILLS SURVEY SPEAKS THE WORKBOOK'S WORDS (owner, 2026-10-31: "use the vocab and
// expressions in the attached excel sheet 100%"). Every string below is copied from "Team Skills
// Survey 2026 (1).xlsx" — its Skills, Instructions, Survey, Ranking and Analysis sheets. Two changes
// are Salma Labib's (Training Manager), on the call: the last column is "Development priorities",
// never "Comments", and the steps about sending a file to the Training Manager are gone. A third is
// what a web form is: "Leave a cell empty" became "Leave a skill on Not observed". Change a word here
// only when the workbook changes.

const workbookSkills: ReadonlyArray<[string, string]> = [
  ["Pre-call planning", "Sets clear call objectives, reviews customer history and prepares key messages and questions before the visit."],
  ["Opening the call", "Builds rapport quickly, states the purpose of the visit and agrees the agenda with the customer."],
  ["Probing & active listening", "Asks open questions, listens carefully and uncovers the customer's real needs before presenting."],
  ["Message delivery", "Presents key product messages clearly, accurately and in approved wording, linked to the customer's needs."],
  ["Handling objections", "Listens, clarifies and answers concerns with facts and confidence, without becoming defensive."],
  ["Closing & gaining commitment", "Summarises what was agreed and secures a clear next step or commitment from the customer."],
  ["Post-call analysis & follow-up", "Reviews the call, records useful notes and follows up on actions on time."],
  ["Product & disease knowledge", "Shows accurate, up-to-date knowledge of products, indications and the market."],
  ["Compliance & ethics", "Follows promotional rules and company policies and reports adverse events correctly."],
  ["Territory & time management", "Plans visits and routes, prioritises key customers and uses field time efficiently."],
];

const workbookScale: ReadonlyArray<[string, string]> = [
  ["0 - Not demonstrated", "The skill is not shown at all; full development is needed."],
  ["1 - Very weak", "Rarely shown, often incorrect; needs intensive coaching."],
  ["2 - Below expectations", "Shown sometimes but inconsistent; needs regular coaching."],
  ["3 - Meets basic expectations", "Performs the skill adequately; room to improve."],
  ["4 - Strong", "Performs the skill well and consistently."],
  ["5 - Role model", "Excellent; can be an example for others."],
];

function runSkills() {
  assert.deepEqual(
    skillsSurveyDefaultSkills.map((skill) => [skill.name, skill.goodLooksLike]),
    workbookSkills,
    "the ten skills and what good looks like, word for word from the Skills sheet",
  );
  assert.equal(skillsSurveySkillsLabels.heading, "Coaching matrix skills");
  assert.equal(skillsSurveySkillsLabels.skill, "Skill");
  assert.equal(skillsSurveySkillsLabels.goodLooksLike, "What good looks like");

  // The migration seeds the same rows, so the first page anyone opens shows the workbook's skills.
  const migration = readFileSync(
    new URL("../supabase/migrations/20261031210456_coaching_skills_survey.sql", import.meta.url),
    "utf8",
  );
  skillsSurveyDefaultSkills.forEach((skill, index) => {
    const sql = (text: string) => `'${text.replace(/'/g, "''")}'`;
    assert.ok(
      migration.includes(`('${skill.key}', ${index + 1}, ${sql(skill.name)},`),
      `the migration must seed ${skill.name} as skill ${index + 1}`,
    );
    assert.ok(migration.includes(sql(skill.goodLooksLike)), `the migration must seed what good looks like for ${skill.name}`);
  });
}

function runScaleAndForm() {
  assert.deepEqual(
    skillsSurveyRatingScale.map((entry) => [entry.label, entry.meaning]),
    workbookScale,
    "the rating scale, word for word from the Instructions sheet",
  );
  assert.deepEqual(skillsSurveyRatingScale.map((entry) => entry.score), [0, 1, 2, 3, 4, 5]);
  assert.equal(skillsSurveyNotObserved.label, "Not observed");
  assert.match(skillsSurveyNotObserved.meaning, /^Skill not observed\./);
  assert.match(skillsSurveyNotObserved.meaning, /while 0 counts as a real score\.$/);

  assert.equal(skillsSurveyTitle, "Team Coaching Skills Survey");
  assert.equal(skillsSurveyInstructions.heading, "District Managers: Team Coaching Skills Survey");
  assert.equal(
    skillsSurveyInstructions.lead,
    "Rate each team member from 0 to 5 on the coaching matrix skills. Results feed the Training Needs Analysis (TNA).",
  );
  assert.equal(skillsSurveyInstructions.howTo, "How to fill in the survey");
  assert.ok(
    !skillsSurveyInstructions.steps.some((step) => /send your file|master|sheet/i.test(step)),
    "the steps about Excel files no longer apply and are gone",
  );
  assert.match(skillsSurveyInstructions.privacy, /Not visible to the team member/);

  assert.deepEqual(Object.values(skillsSurveyFieldLabels), [
    "Date",
    "District",
    "District Manager",
    "Team Member",
    "Years in Role",
    "Average (0-5)",
    "Development priorities",
  ]);
  const everyLabel = JSON.stringify([
    skillsSurveyFieldLabels,
    skillsSurveyInstructions,
    skillsSurveyRankingLabels,
    skillsSurveyAnalysisLabels,
  ]);
  assert.doesNotMatch(everyLabel, /Comments/, "Salma: the last column is Development priorities, never Comments");
}

function runRankingAndAnalysis() {
  assert.equal(skillsSurveyRankingLabels.heading, "Overall ranking: capabilities and experience");
  assert.deepEqual(
    [
      skillsSurveyRankingLabels.overallRank,
      skillsSurveyRankingLabels.teamMember,
      skillsSurveyRankingLabels.district,
      skillsSurveyRankingLabels.districtManager,
      skillsSurveyRankingLabels.yearsInRole,
      skillsSurveyRankingLabels.capabilityAverage,
      skillsSurveyRankingLabels.capabilityRank,
      skillsSurveyRankingLabels.experienceScore,
      skillsSurveyRankingLabels.overallScore,
      skillsSurveyRankingLabels.performanceLevel,
    ],
    [
      "Overall rank",
      "Team Member",
      "District",
      "District Manager",
      "Years in Role",
      "Capability average",
      "Capability rank",
      "Experience score",
      "Overall score (0-5)",
      "Performance level",
    ],
    "the Ranking sheet's columns, in order",
  );
  assert.equal(skillsSurveyRankingLabels.capabilityWeight, "Capability weight");
  assert.equal(skillsSurveyRankingLabels.fullExperienceYears, "Years for full experience score");
  assert.deepEqual(Object.values(skillsSurveyPerformanceLevels), [
    "At or above target",
    "Developing",
    "Priority for coaching",
  ]);
  assert.equal(
    skillsSurveyOverallFormula(0.8, 5),
    "Overall score = 80% x capability average + 20% x experience score. Experience score = years in role / 5 years x 5 (maximum 5). If years are not entered, the overall score equals the capability average.",
    "the Instructions sheet's note, with the Training Manager's live settings in it",
  );

  assert.equal(skillsSurveyAnalysisLabels.heading, "TNA Summary: team coaching skills");
  assert.equal(skillsSurveyAnalysisLabels.targetScore, "Target score (0-5)");
  assert.equal(skillsSurveyAnalysisLabels.teamMembersRated, "Team members rated");
  assert.equal(skillsSurveyAnalysisLabels.overallAverage, "Overall average");
  assert.deepEqual(
    [
      skillsSurveyAnalysisLabels.rank,
      skillsSurveyAnalysisLabels.skill,
      skillsSurveyAnalysisLabels.averageScore,
      skillsSurveyAnalysisLabels.ratingsCount,
      skillsSurveyAnalysisLabels.ratedLow,
      skillsSurveyAnalysisLabels.ratedHigh,
      skillsSurveyAnalysisLabels.gapToTarget,
      skillsSurveyAnalysisLabels.trainingPriority,
    ],
    [
      "Rank (1 = biggest need)",
      "Skill",
      "Average score",
      "Ratings count",
      "% rated 0-2",
      "% rated 4-5",
      "Gap to target",
      "Training priority",
    ],
    "the Analysis sheet's skill table columns, in order",
  );
  assert.equal(skillsSurveyAnalysisLabels.byDistrict, "Average score by district");
  assert.equal(skillsSurveyAnalysisLabels.byExperienceBand, "Average score by experience band");
  assert.equal(skillsSurveyAnalysisLabels.bandsNote, "Years in role: From (included) up to To (not included).");
  assert.equal(
    skillsSurveyAnalysisLabels.priorityLevels,
    "High = average is 1.0 or more below target. Medium = below target by less than 1.0. On target = at or above target.",
  );
  assert.deepEqual(Object.values(skillsSurveyTrainingPriorities), ["High", "Medium", "On target", "No data"]);
  assert.deepEqual(
    skillsSurveyDefaultExperienceBands.map((band) => band.label),
    ["Less than 1 year", "1 to 3 years", "3 to 5 years", "5 years or more"],
  );
}

export function runCoachingSkillsSurveyVocabularyTests() {
  runSkills();
  runScaleAndForm();
  runRankingAndAnalysis();
}
