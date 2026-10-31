import assert from "node:assert/strict";

import {
  buildSkillsSurveyAnalysis,
  buildSkillsSurveyDistrictAverages,
  buildSkillsSurveyExperienceBandAverages,
  buildSkillsSurveyRanking,
  capabilityAverage,
  experienceScore,
  isSkillsSurveyQuarterOpen,
  normalizeSkillsSurveyScores,
  normalizeSkillsSurveySettings,
  overallScore,
  parseSkillsSurveyQuarterKey,
  performanceLevel,
  readSkillsSurveyScores,
  scoreSkillsSurveyEntry,
  skillsSurveyDefaultSettings,
  skillsSurveyQuarterOf,
  skillsSurveySkillKeyFor,
  yearsInRoleOn,
  type SkillsSurveyEntry,
  type SkillsSurveySettings,
  type SkillsSurveySkill,
} from "../src/lib/coaching/skills-survey/calculations.ts";
import {
  skillsSurveyDefaultSkills,
  skillsSurveyPerformanceLevels,
  skillsSurveyTrainingPriorities,
} from "../src/lib/coaching/skills-survey/vocabulary.ts";

// THE TEAM COACHING SKILLS SURVEY'S ARITHMETIC (owner, 2026-10-31: "the results are automated") —
// every formula of "Team Skills Survey 2026 (1).xlsx", pinned one for one. The workbook's own example
// row (Instructions sheet, rows 26-37) is the first case: Pre-call planning 3, Opening the call 4,
// Probing & active listening 2, 2 years in role.

const settings: SkillsSurveySettings = skillsSurveyDefaultSettings;

const skills: SkillsSurveySkill[] = skillsSurveyDefaultSkills.map((skill, index) => ({
  ...skill,
  displayOrder: index + 1,
  isActive: true,
}));

function close(actual: number | null, expected: number, message: string) {
  assert.ok(actual !== null, `${message}: expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

let nextId = 0;
function entry(overrides: Partial<SkillsSurveyEntry> = {}): SkillsSurveyEntry {
  nextId += 1;
  return {
    developmentPriorities: null,
    districtName: "District 1",
    id: `survey-${nextId}`,
    memberHrId: `R-${nextId}`,
    memberName: `Member ${String(nextId).padStart(2, "0")}`,
    raterHrId: "B-1",
    raterName: "Sample Manager",
    scores: {},
    surveyDate: "2026-11-05",
    surveyQuarter: 4,
    surveyYear: 2026,
    updatedAt: null,
    yearsInRole: null,
    ...overrides,
  };
}

function runWorkbookExampleRow() {
  const example = entry({
    scores: { opening_the_call: 4, pre_call_planning: 3, probing_active_listening: 2 },
    yearsInRole: 2,
  });
  const card = scoreSkillsSurveyEntry(example, settings);
  close(card.capabilityAverage, 3, "Average (0-5) of 3, 4, 2");
  close(card.experienceScore, 2, "Experience score for 2 years at 5 years for full score");
  close(card.overallScore, 2.8, "Overall score = 80% x 3.0 + 20% x 2.0");
  assert.equal(
    card.performanceLevel,
    skillsSurveyPerformanceLevels.priorityForCoaching,
    "2.8 against a target of 4 is below target - 1, so Priority for coaching",
  );
}

function runAverageRules() {
  assert.equal(capabilityAverage({}), null, "nothing rated: the Average is blank, never 0");
  close(capabilityAverage({ a: 0, b: 4 }), 2, "0 counts as a real score");
  close(capabilityAverage({ a: 4 }), 4, "a skill left as Not observed is not in the average");

  const allowed = new Set(["a", "b", "c"]);
  assert.deepEqual(
    normalizeSkillsSurveyScores({ a: 0, b: null, c: "" }, allowed),
    { a: 0 },
    "an empty value is Not observed and dropped; 0 is kept",
  );
  assert.deepEqual(normalizeSkillsSurveyScores({ a: "3" }, allowed), { a: 3 });
  assert.throws(() => normalizeSkillsSurveyScores({ a: 6 }, allowed), /0 to 5/);
  assert.throws(() => normalizeSkillsSurveyScores({ a: 2.5 }, allowed), /0 to 5/);
  assert.throws(() => normalizeSkillsSurveyScores({ a: -1 }, allowed), /0 to 5/);
  assert.throws(() => normalizeSkillsSurveyScores({ z: 3 }, allowed), /Unknown skill/);
  assert.throws(() => normalizeSkillsSurveyScores([3], allowed), /one score per skill/);
  assert.deepEqual(
    readSkillsSurveyScores({ a: 3, b: 9, c: "x", d: "4" }),
    { a: 3, d: 4 },
    "a stored score outside 0..5 is ignored on read, never shown",
  );
}

function runExperienceAndOverall() {
  assert.equal(yearsInRoleOn(null, null, "2026-11-05"), null, "HR has not filled the years");
  close(yearsInRoleOn(2, "2026-11-05", "2026-11-05"), 2, "same day: HR's years");
  close(yearsInRoleOn(2, "2025-11-05", "2026-11-05"), 3, "a year after HR typed 2, the survey reads 3.0");
  close(yearsInRoleOn(2, null, "2026-11-05"), 2, "no as-of date: HR's years as they are");
  close(yearsInRoleOn(2, "2027-01-01", "2026-11-05"), 2, "an as-of date after the survey never subtracts");

  assert.equal(experienceScore(null, settings), null);
  close(experienceScore(0, settings), 0, "no years in role");
  close(experienceScore(5, settings), 5, "full experience at 5 years");
  close(experienceScore(12, settings), 5, "capped at 5");

  close(overallScore(3, null, settings), 3, "no years: Overall score = Capability average");
  assert.equal(overallScore(null, 4, settings), null, "nothing rated: no Overall score");
  close(overallScore(3, 5, { ...settings, capabilityWeight: 0.5 }), 4, "the Training Manager's weight applies");
}

function runPerformanceLevelEdges() {
  assert.equal(performanceLevel(4, 4), skillsSurveyPerformanceLevels.atOrAboveTarget, "exactly the target");
  assert.equal(performanceLevel(3, 4), skillsSurveyPerformanceLevels.developing, "exactly target - 1");
  assert.equal(performanceLevel(2.99, 4), skillsSurveyPerformanceLevels.priorityForCoaching);
  assert.equal(performanceLevel(null, 4), null);
}

function runRanking() {
  const high = entry({ memberName: "Bassem", scores: { pre_call_planning: 5 }, yearsInRole: 5 });
  const tieB = entry({ memberName: "Nour", scores: { pre_call_planning: 3 }, yearsInRole: 0 });
  const tieA = entry({ memberName: "Amr", scores: { pre_call_planning: 3 }, yearsInRole: 0 });
  // A low capability average with long experience: 0.8 x 2 + 0.2 x 5 = 2.6, above the two 2.4s.
  const experienced = entry({ memberName: "Hala", scores: { pre_call_planning: 2 }, yearsInRole: 10 });
  const unrated = entry({ memberName: "Zeina", scores: {} });

  const ranking = buildSkillsSurveyRanking([tieB, unrated, experienced, high, tieA], settings);
  assert.deepEqual(
    ranking.map((row) => row.entry.memberName),
    ["Bassem", "Hala", "Amr", "Nour"],
    "highest overall first; a tie goes to the higher capability average, then the name; nobody unrated is ranked",
  );
  assert.deepEqual(
    ranking.map((row) => row.overallRank),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    Object.fromEntries(ranking.map((row) => [row.entry.memberName, row.capabilityRank])),
    { Amr: 2, Bassem: 1, Hala: 4, Nour: 3 },
    "Capability rank orders by the capability average alone",
  );
}

function runAnalysis() {
  const first = entry({ scores: { opening_the_call: 4, pre_call_planning: 2 } });
  const second = entry({ scores: { opening_the_call: 5, pre_call_planning: 3 } });
  const third = entry({ scores: { opening_the_call: 3, pre_call_planning: 2 } });
  const analysis = buildSkillsSurveyAnalysis([first, second, third], skills, settings);

  assert.equal(analysis.teamMembersRated, 3);
  close(analysis.overallAverage, (4 + 2 + 5 + 3 + 3 + 2) / 6, "Overall average is over every single rating");

  const row = (key: string) => {
    const found = analysis.skills.find((item) => item.skill.key === key);
    assert.ok(found, `${key} must be in the analysis`);
    return found;
  };
  const planning = row("pre_call_planning");
  close(planning.averageScore, 7 / 3, "Pre-call planning average");
  assert.equal(planning.ratingsCount, 3);
  close(planning.shareRatedLow, 2 / 3, "% rated 0-2");
  close(planning.shareRatedHigh, 0, "% rated 4-5");
  close(planning.gapToTarget, 4 - 7 / 3, "Gap to target");
  assert.equal(planning.trainingPriority, skillsSurveyTrainingPriorities.high, "a gap of 1.0 or more is High");
  assert.equal(planning.rank, 1, "the lowest average is rank 1 = biggest need");

  const opening = row("opening_the_call");
  close(opening.averageScore, 4, "Opening the call average");
  close(opening.gapToTarget, 0, "at the target there is no gap");
  assert.equal(opening.trainingPriority, skillsSurveyTrainingPriorities.onTarget);
  assert.equal(opening.rank, 2);

  const unrated = row("compliance_ethics");
  assert.equal(unrated.averageScore, null);
  assert.equal(unrated.ratingsCount, 0);
  assert.equal(unrated.rank, null, "a skill nobody rated has no rank");
  assert.equal(unrated.trainingPriority, skillsSurveyTrainingPriorities.noData);

  const medium = buildSkillsSurveyAnalysis([entry({ scores: { message_delivery: 3 } }), entry({ scores: { message_delivery: 4 } })], skills, settings);
  const delivery = medium.skills.find((item) => item.skill.key === "message_delivery");
  assert.equal(delivery?.trainingPriority, skillsSurveyTrainingPriorities.medium, "below target by less than 1.0 is Medium");

  const tied = buildSkillsSurveyAnalysis(
    [entry({ scores: { compliance_ethics: 2, handling_objections: 2, message_delivery: 4 } })],
    skills,
    settings,
  );
  const tiedRanks = Object.fromEntries(tied.skills.filter((item) => item.rank !== null).map((item) => [item.skill.key, item.rank]));
  assert.deepEqual(tiedRanks, { compliance_ethics: 1, handling_objections: 1, message_delivery: 3 }, "ties share a rank, as RANK does");

  const retired = skills.map((skill) => (skill.key === "compliance_ethics" ? { ...skill, isActive: false } : skill));
  assert.ok(
    buildSkillsSurveyAnalysis([entry({ scores: { compliance_ethics: 1 } })], retired, settings).skills.some(
      (item) => item.skill.key === "compliance_ethics",
    ),
    "a turned-off skill that still carries ratings is shown, so an old rating is never hidden",
  );
  assert.ok(
    !buildSkillsSurveyAnalysis([entry({ scores: { pre_call_planning: 1 } })], retired, settings).skills.some(
      (item) => item.skill.key === "compliance_ethics",
    ),
    "a turned-off skill with no ratings is left out",
  );
}

function runGroupAverages() {
  const surveys = [
    entry({ districtName: "Delta (1)", scores: { pre_call_planning: 4, opening_the_call: 2 }, yearsInRole: 0.5 }),
    entry({ districtName: "Delta (1)", scores: { pre_call_planning: 5 }, yearsInRole: 1 }),
    entry({ districtName: "Upper Egypt", scores: { pre_call_planning: 1 }, yearsInRole: 3 }),
    entry({ districtName: null, scores: { pre_call_planning: 2 }, yearsInRole: 5 }),
    entry({ districtName: "Upper Egypt", scores: { pre_call_planning: 3 }, yearsInRole: null }),
  ];

  const districts = buildSkillsSurveyDistrictAverages(surveys, skills);
  assert.deepEqual(
    districts.map((row) => [row.label, row.teamMembers]),
    [
      ["Delta (1)", 2],
      ["No district", 1],
      ["Upper Egypt", 2],
    ],
    "the districts come from the surveys themselves, never typed in",
  );
  close(districts[0].overallAverage, (3 + 5) / 2, "by district, Overall average is the mean of the row averages");

  const bands = buildSkillsSurveyExperienceBandAverages(surveys, skills, settings);
  assert.deepEqual(
    bands.map((row) => [row.label, row.teamMembers]),
    [
      ["Less than 1 year", 1],
      ["1 to 3 years", 1],
      ["3 to 5 years", 1],
      ["5 years or more", 1],
    ],
    "bands run From (included) up to To (not included); a survey with no years is in no band",
  );
}

function runQuartersAndSettings() {
  assert.deepEqual(skillsSurveyQuarterOf("2026-11-05"), { quarter: 4, year: 2026 });
  assert.deepEqual(skillsSurveyQuarterOf("2026-01-01"), { quarter: 1, year: 2026 });
  assert.deepEqual(skillsSurveyQuarterOf("2026-03-31"), { quarter: 1, year: 2026 });
  assert.deepEqual(skillsSurveyQuarterOf("2026-04-01"), { quarter: 2, year: 2026 });
  assert.deepEqual(parseSkillsSurveyQuarterKey("2026-Q4"), { quarter: 4, year: 2026 });
  assert.equal(parseSkillsSurveyQuarterKey("2026-Q5"), null);
  assert.equal(parseSkillsSurveyQuarterKey(null), null);
  assert.equal(isSkillsSurveyQuarterOpen(2026, 4, "2026-12-31"), true, "editable until the quarter ends");
  assert.equal(isSkillsSurveyQuarterOpen(2026, 4, "2027-01-01"), false, "closed once the quarter is over");
  assert.equal(isSkillsSurveyQuarterOpen(2026, 3, "2026-10-31"), false);

  assert.equal(skillsSurveyDefaultSettings.targetScore, 4, "the workbook's target score");
  assert.equal(skillsSurveyDefaultSettings.capabilityWeight, 0.8, "the workbook's capability weight");
  assert.equal(skillsSurveyDefaultSettings.fullExperienceYears, 5, "the workbook's years for full experience score");
  assert.deepEqual(
    skillsSurveyDefaultSettings.experienceBands.map((band) => [band.from, band.to]),
    [
      [0, 1],
      [1, 3],
      [3, 5],
      [5, 100],
    ],
  );

  assert.equal(normalizeSkillsSurveySettings({ targetScore: 3.5 }, settings).targetScore, 3.5);
  assert.throws(() => normalizeSkillsSurveySettings({ targetScore: 6 }, settings), /0 to 5/);
  assert.throws(() => normalizeSkillsSurveySettings({ capabilityWeight: 1.2 }, settings), /0% to 100%/);
  assert.throws(() => normalizeSkillsSurveySettings({ fullExperienceYears: 0 }, settings), /more than 0/);
  assert.throws(() => normalizeSkillsSurveySettings({ experienceBands: [] }, settings), /at least one/);
  assert.throws(
    () => normalizeSkillsSurveySettings({ experienceBands: [{ from: 3, label: "Odd", to: 1 }] }, settings),
    /lower number of years to a higher one/,
  );

  assert.equal(skillsSurveySkillKeyFor("Probing & active listening", new Set()), "probing_active_listening");
  assert.equal(skillsSurveySkillKeyFor("Message delivery", new Set(["message_delivery"])), "message_delivery_2");
}

export function runCoachingSkillsSurveyCalculationTests() {
  runWorkbookExampleRow();
  runAverageRules();
  runExperienceAndOverall();
  runPerformanceLevelEdges();
  runRanking();
  runAnalysis();
  runGroupAverages();
  runQuartersAndSettings();
}
