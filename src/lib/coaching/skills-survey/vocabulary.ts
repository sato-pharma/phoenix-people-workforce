// THE TEAM COACHING SKILLS SURVEY'S WORDS (owner, 2026-10-31): "built in English, in easy words, and
// use the vocab and expressions in the attached Excel sheet 100%". Every label below is copied from
// "Team Skills Survey 2026 (1).xlsx" — its Instructions, Survey, Ranking, Analysis and Skills sheets
// — and this file is the only place a screen takes them from. Two deliberate changes, both Salma
// Labib's (Training Manager) on the call: the last column is "Development priorities", never
// "Comments", and the steps that told a manager to send his file to the Training Manager are gone,
// because the survey no longer travels as a file. Pinned by tests/coaching-skills-survey-vocabulary.test.ts.

export const skillsSurveyTitle = "Team Coaching Skills Survey";

export const skillsSurveyInstructions = {
  heading: "District Managers: Team Coaching Skills Survey",
  lead: "Rate each team member from 0 to 5 on the coaching matrix skills. Results feed the Training Needs Analysis (TNA).",
  howTo: "How to fill in the survey",
  steps: [
    "Each survey is ONE team member.",
    "The date, your district, your name, the team member's name and their years in the role are filled in automatically.",
    "Rate every skill from 0 to 5 using the scale below. Leave a skill on \"Not observed\" if the skill was not observed.",
    "Add short development priorities. The average is calculated automatically.",
  ],
  privacy: "Not visible to the team member. Only managers and the Training Manager see this survey.",
} as const;

export type SkillsSurveyScaleEntry = {
  score: number;
  label: string;
  meaning: string;
};

export const skillsSurveyRatingScaleHeading = "Rating scale";

export const skillsSurveyRatingScale: readonly SkillsSurveyScaleEntry[] = [
  { score: 0, label: "0 - Not demonstrated", meaning: "The skill is not shown at all; full development is needed." },
  { score: 1, label: "1 - Very weak", meaning: "Rarely shown, often incorrect; needs intensive coaching." },
  { score: 2, label: "2 - Below expectations", meaning: "Shown sometimes but inconsistent; needs regular coaching." },
  { score: 3, label: "3 - Meets basic expectations", meaning: "Performs the skill adequately; room to improve." },
  { score: 4, label: "4 - Strong", meaning: "Performs the skill well and consistently." },
  { score: 5, label: "5 - Role model", meaning: "Excellent; can be an example for others." },
];

export const skillsSurveyNotObserved = {
  label: "Not observed",
  meaning: "Skill not observed. Not observed skills are excluded from averages, while 0 counts as a real score.",
} as const;

/** The Survey sheet's columns, in order. */
export const skillsSurveyFieldLabels = {
  date: "Date",
  district: "District",
  districtManager: "District Manager",
  teamMember: "Team Member",
  yearsInRole: "Years in Role",
  average: "Average (0-5)",
  developmentPriorities: "Development priorities",
} as const;

export const skillsSurveyDevelopmentPrioritiesHint =
  "What should this team member work on first? The thing that has the most impact on the business.";

// Years of experience: HR fills it on the Employee Master, or the team member's own District Manager
// on this form (owner, 2026-10-31: "make hr or dm can fill years of experience of the rep").
export const skillsSurveyYearsInRoleHint =
  "Years of experience in the role, at Sato and before. Filled by HR or by the District Manager.";
export const skillsSurveyYearsEditHint =
  "Years of experience in the role, at Sato and before, for example 2 or 0.5. HR or you can fill it; saving the survey saves it to the team member's record.";
export const skillsSurveyYearsNotFilled = "Not filled yet";

/** The Skills sheet. */
export const skillsSurveySkillsLabels = {
  heading: "Coaching matrix skills",
  lead: "Edit the skill names or descriptions here. The Survey, Ranking and Analysis use these names.",
  number: "#",
  skill: "Skill",
  goodLooksLike: "What good looks like",
} as const;

/** The Ranking sheet. */
export const skillsSurveyRankingLabels = {
  heading: "Overall ranking: capabilities and experience",
  lead: "All team members ranked from highest to lowest overall score. Updates automatically from the Survey.",
  capabilityWeight: "Capability weight",
  capabilityWeightNote: "Change to your company view (experience weight = 100% minus capability weight).",
  experienceWeight: "Experience weight",
  fullExperienceYears: "Years for full experience score",
  fullExperienceYearsNote: "Years in role at which the experience score reaches the maximum of 5.",
  overallRank: "Overall rank",
  teamMember: "Team Member",
  district: "District",
  districtManager: "District Manager",
  yearsInRole: "Years in Role",
  capabilityAverage: "Capability average",
  capabilityRank: "Capability rank",
  experienceScore: "Experience score",
  overallScore: "Overall score (0-5)",
  performanceLevel: "Performance level",
} as const;

/** The Instructions sheet's "Overall ranking" note, with the Training Manager's live settings in it. */
export function skillsSurveyOverallFormula(capabilityWeight: number, fullExperienceYears: number): string {
  const capability = Math.round(capabilityWeight * 100);
  const experience = 100 - capability;
  const years = Number.isInteger(fullExperienceYears) ? String(fullExperienceYears) : fullExperienceYears.toFixed(1);
  return (
    `Overall score = ${capability}% x capability average + ${experience}% x experience score. ` +
    `Experience score = years in role / ${years} years x 5 (maximum 5). ` +
    "If years are not entered, the overall score equals the capability average."
  );
}

export const skillsSurveyPerformanceLevels = {
  atOrAboveTarget: "At or above target",
  developing: "Developing",
  priorityForCoaching: "Priority for coaching",
} as const;

export type SkillsSurveyPerformanceLevel =
  (typeof skillsSurveyPerformanceLevels)[keyof typeof skillsSurveyPerformanceLevels];

/** The Analysis sheet. */
export const skillsSurveyAnalysisLabels = {
  heading: "TNA Summary: team coaching skills",
  lead: "Calculated automatically from the Survey. Lowest averages = biggest training needs.",
  targetScore: "Target score (0-5)",
  targetScoreNote: "Change to your company standard.",
  teamMembersRated: "Team members rated",
  overallAverage: "Overall average",
  rank: "Rank (1 = biggest need)",
  skill: "Skill",
  averageScore: "Average score",
  ratingsCount: "Ratings count",
  ratedLow: "% rated 0-2",
  ratedHigh: "% rated 4-5",
  gapToTarget: "Gap to target",
  trainingPriority: "Training priority",
  byDistrict: "Average score by district",
  districtColumn: "District",
  teamMembers: "Team members",
  byExperienceBand: "Average score by experience band",
  bandColumn: "Experience band",
  bandsNote: "Years in role: From (included) up to To (not included).",
  bandFrom: "From (years)",
  bandTo: "To (years)",
  priorityLevels:
    "High = average is 1.0 or more below target. Medium = below target by less than 1.0. On target = at or above target.",
} as const;

export const skillsSurveyTrainingPriorities = {
  high: "High",
  medium: "Medium",
  onTarget: "On target",
  noData: "No data",
} as const;

export type SkillsSurveyTrainingPriority =
  (typeof skillsSurveyTrainingPriorities)[keyof typeof skillsSurveyTrainingPriorities];

export type SkillsSurveySkillSeed = {
  key: string;
  name: string;
  goodLooksLike: string;
};

/** The Skills sheet's ten skills, word for word — the same rows the migration seeds. */
export const skillsSurveyDefaultSkills: readonly SkillsSurveySkillSeed[] = [
  {
    key: "pre_call_planning",
    name: "Pre-call planning",
    goodLooksLike: "Sets clear call objectives, reviews customer history and prepares key messages and questions before the visit.",
  },
  {
    key: "opening_the_call",
    name: "Opening the call",
    goodLooksLike: "Builds rapport quickly, states the purpose of the visit and agrees the agenda with the customer.",
  },
  {
    key: "probing_active_listening",
    name: "Probing & active listening",
    goodLooksLike: "Asks open questions, listens carefully and uncovers the customer's real needs before presenting.",
  },
  {
    key: "message_delivery",
    name: "Message delivery",
    goodLooksLike: "Presents key product messages clearly, accurately and in approved wording, linked to the customer's needs.",
  },
  {
    key: "handling_objections",
    name: "Handling objections",
    goodLooksLike: "Listens, clarifies and answers concerns with facts and confidence, without becoming defensive.",
  },
  {
    key: "closing_gaining_commitment",
    name: "Closing & gaining commitment",
    goodLooksLike: "Summarises what was agreed and secures a clear next step or commitment from the customer.",
  },
  {
    key: "post_call_analysis_follow_up",
    name: "Post-call analysis & follow-up",
    goodLooksLike: "Reviews the call, records useful notes and follows up on actions on time.",
  },
  {
    key: "product_disease_knowledge",
    name: "Product & disease knowledge",
    goodLooksLike: "Shows accurate, up-to-date knowledge of products, indications and the market.",
  },
  {
    key: "compliance_ethics",
    name: "Compliance & ethics",
    goodLooksLike: "Follows promotional rules and company policies and reports adverse events correctly.",
  },
  {
    key: "territory_time_management",
    name: "Territory & time management",
    goodLooksLike: "Plans visits and routes, prioritises key customers and uses field time efficiently.",
  },
];

/** The workbook's own assumptions, used until the Training Manager changes them. */
export const skillsSurveyDefaultExperienceBands = [
  { label: "Less than 1 year", from: 0, to: 1 },
  { label: "1 to 3 years", from: 1, to: 3 },
  { label: "3 to 5 years", from: 3, to: 5 },
  { label: "5 years or more", from: 5, to: 100 },
] as const;

export const skillsSurveyTabs = {
  survey: "Survey",
  ranking: "Ranking",
  analysis: "Analysis",
  skills: "Skills",
} as const;

export type SkillsSurveyTab = keyof typeof skillsSurveyTabs;

export const skillsSurveyTabOrder: readonly SkillsSurveyTab[] = ["survey", "ranking", "analysis", "skills"];

/** The tab named in a page's `?tab=`, or the Survey tab. */
export function parseSkillsSurveyTab(value: string | null | undefined): SkillsSurveyTab {
  return skillsSurveyTabOrder.includes(value as SkillsSurveyTab) ? (value as SkillsSurveyTab) : "survey";
}

export const skillsSurveyStatus = {
  rated: "Rated",
  notRated: "Not rated yet",
} as const;

export const skillsSurveyOldFormRetiredMessage =
  "The coaching report form was replaced by the Team Coaching Skills Survey.";
