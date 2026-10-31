// THE TEAM COACHING SKILLS SURVEY — server side (owner, 2026-10-31). Reads and writes the three
// tables of migration 20261031210456 through the service role, after the caller's route or page has
// passed `assertPermission(access, "coaching_skills_survey", …)`; every read and write below is then
// narrowed again by ./access.ts. Nothing here sends an email, a bell or a Telegram message — the
// person rated is never told (Salma Labib, Training Manager).

import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { assertNotTestAccount } from "@/lib/auth/test-persona";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  parseTotalExperienceYears,
  readTotalExperienceByHrId,
  saveTotalExperienceYears,
  totalExperienceFor,
} from "@/lib/employees/total-experience";
import { hrIdForStorage, hrIdsMatch } from "@/lib/hr-id";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildSkillsSurveyChainIndex,
  canEditSkillsSurveySettings,
  canOpenSkillsSurvey,
  canRateSkillsSurveyMember,
  canRateSkillsSurveys,
  canReadSkillsSurveyMember,
  isSkillsSurveyMember,
  isSkillsSurveySubject,
} from "@/lib/coaching/skills-survey/access";
import {
  normalizeSkillsSurveyScores,
  normalizeSkillsSurveySettings,
  readSkillsSurveyScores,
  scoreSkillsSurveyEntry,
  skillsSurveyDefaultSettings,
  skillsSurveyQuarterOf,
  skillsSurveySkillKeyFor,
  yearsInRoleOn,
  type SkillsSurveyEntry,
  type SkillsSurveyExperienceBand,
  type SkillsSurveyScoreCard,
  type SkillsSurveySettings,
  type SkillsSurveySkill,
} from "@/lib/coaching/skills-survey/calculations";

export class SkillsSurveyError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

function forbidden(message: string): never {
  throw new SkillsSurveyError(`Forbidden: ${message}`, 403);
}

type SkillDbRow = {
  key: string;
  display_order: number;
  name: string;
  good_looks_like: string | null;
  is_active: boolean;
};

type SettingsDbRow = {
  target_score: number | string;
  capability_weight: number | string;
  full_experience_years: number | string;
  experience_bands: unknown;
  updated_at: string | null;
  updated_by: string | null;
};

type SurveyDbRow = {
  id: string;
  survey_date: string;
  survey_year: number;
  survey_quarter: number;
  rater_hr_id: string;
  rater_role: string;
  member_hr_id: string;
  member_role: string;
  district_name: string | null;
  years_in_role: number | string | null;
  scores: unknown;
  development_priorities: string | null;
  updated_at: string | null;
};

const surveyColumns =
  "id,survey_date,survey_year,survey_quarter,rater_hr_id,rater_role,member_hr_id,member_role,district_name,years_in_role,scores,development_priorities,updated_at";

export type SkillsSurveyConfig = {
  skills: SkillsSurveySkill[];
  settings: SkillsSurveySettings;
};

export type SkillsSurveyQuarter = { year: number; quarter: number };

export type SkillsSurveyTeamMember = {
  hrId: string;
  name: string;
  districtName: string | null;
  yearsInRole: number | null;
  rated: boolean;
  card: SkillsSurveyScoreCard | null;
  updatedAt: string | null;
};

export type SkillsSurveyWorkspace = {
  viewer: {
    name: string | null;
    canRate: boolean;
    canEditSettings: boolean;
  };
  config: SkillsSurveyConfig;
  today: string;
  currentQuarter: SkillsSurveyQuarter;
  quarter: SkillsSurveyQuarter;
  quarters: SkillsSurveyQuarter[];
  /** The District Manager's own team, rated or not, for the chosen quarter. Empty for everyone else. */
  team: SkillsSurveyTeamMember[];
  /** Every survey of the chosen quarter this viewer may read. */
  entries: SkillsSurveyEntry[];
};

export type SkillsSurveyMemberForm = {
  config: SkillsSurveyConfig;
  today: string;
  quarter: SkillsSurveyQuarter;
  member: { hrId: string; name: string };
  districtName: string | null;
  districtManagerName: string | null;
  yearsInRole: number | null;
  survey: SkillsSurveyEntry | null;
  canEdit: boolean;
};

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readBands(value: unknown): SkillsSurveyExperienceBand[] {
  if (!Array.isArray(value)) return skillsSurveyDefaultSettings.experienceBands;
  const bands = value.flatMap((band) => {
    if (!band || typeof band !== "object") return [];
    const record = band as Record<string, unknown>;
    const from = Number(record.from);
    const to = Number(record.to);
    const label = String(record.label ?? "").trim();
    return label && Number.isFinite(from) && Number.isFinite(to) ? [{ from, label, to }] : [];
  });
  return bands.length > 0 ? bands : skillsSurveyDefaultSettings.experienceBands;
}

export async function getSkillsSurveyConfig(): Promise<SkillsSurveyConfig> {
  const supabase = getSupabaseAdmin();
  const [skillsResult, settingsResult] = await Promise.all([
    supabase
      .from("coaching_skills_survey_skills")
      .select("key,display_order,name,good_looks_like,is_active")
      .order("display_order", { ascending: true }),
    supabase
      .from("coaching_skills_survey_settings")
      .select("target_score,capability_weight,full_experience_years,experience_bands,updated_at,updated_by")
      .eq("id", 1)
      .maybeSingle(),
  ]);
  if (skillsResult.error) throw skillsResult.error;
  if (settingsResult.error) throw settingsResult.error;

  const skills = ((skillsResult.data ?? []) as SkillDbRow[]).map((row) => ({
    displayOrder: row.display_order,
    goodLooksLike: row.good_looks_like ?? "",
    isActive: row.is_active,
    key: row.key,
    name: row.name,
  }));
  const row = settingsResult.data as SettingsDbRow | null;
  const settings: SkillsSurveySettings = row
    ? {
        capabilityWeight: toNumber(row.capability_weight) ?? skillsSurveyDefaultSettings.capabilityWeight,
        experienceBands: readBands(row.experience_bands),
        fullExperienceYears: toNumber(row.full_experience_years) ?? skillsSurveyDefaultSettings.fullExperienceYears,
        targetScore: toNumber(row.target_score) ?? skillsSurveyDefaultSettings.targetScore,
      }
    : skillsSurveyDefaultSettings;
  return { settings, skills };
}

function findPerson(directory: readonly EmployeeDirectoryRow[], hrId: string | null | undefined) {
  if (!hrId) return null;
  return directory.find((person) => hrIdsMatch(person.hrId, hrId)) ?? null;
}

function personName(person: EmployeeDirectoryRow | null | undefined): string | null {
  return person ? person.displayName || person.fullName : null;
}

/** The district a survey belongs to: the District Manager seat's region, else the team's name. */
function districtFor(member: EmployeeDirectoryRow, manager: EmployeeDirectoryRow | null): string | null {
  return (
    manager?.regionName?.trim() ||
    member.regionName?.trim() ||
    member.teamName?.trim() ||
    manager?.teamName?.trim() ||
    null
  );
}

function toEntry(row: SurveyDbRow, directory: readonly EmployeeDirectoryRow[]): SkillsSurveyEntry {
  const member = findPerson(directory, row.member_hr_id);
  const rater = findPerson(directory, row.rater_hr_id);
  return {
    developmentPriorities: row.development_priorities,
    districtName: row.district_name,
    id: row.id,
    memberHrId: row.member_hr_id,
    memberName: personName(member) ?? "Former employee",
    raterHrId: row.rater_hr_id,
    raterName: personName(rater) ?? "Former employee",
    scores: readSkillsSurveyScores(row.scores),
    surveyDate: row.survey_date,
    surveyQuarter: row.survey_quarter,
    surveyYear: row.survey_year,
    updatedAt: row.updated_at,
    yearsInRole: toNumber(row.years_in_role),
  };
}

function quarterOrder(left: SkillsSurveyQuarter, right: SkillsSurveyQuarter) {
  return right.year - left.year || right.quarter - left.quarter;
}

async function readQuarterRows(quarter: SkillsSurveyQuarter): Promise<SurveyDbRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_skills_surveys")
    .select(surveyColumns)
    .eq("survey_year", quarter.year)
    .eq("survey_quarter", quarter.quarter);
  if (error) throw error;
  return (data ?? []) as SurveyDbRow[];
}

async function readQuartersWithSurveys(): Promise<SkillsSurveyQuarter[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_skills_surveys")
    .select("survey_year,survey_quarter")
    .limit(5000);
  if (error) throw error;
  const seen = new Map<string, SkillsSurveyQuarter>();
  for (const row of (data ?? []) as Array<{ survey_year: number; survey_quarter: number }>) {
    seen.set(`${row.survey_year}-${row.survey_quarter}`, { quarter: row.survey_quarter, year: row.survey_year });
  }
  return [...seen.values()];
}

function assertCanOpen(access: AccessContext) {
  if (!canOpenSkillsSurvey(access)) forbidden(`${access.role} cannot open the Team Coaching Skills Survey.`);
}

/** Everything the survey screen needs, for one quarter (today's when none is chosen). */
export async function getSkillsSurveyWorkspace(
  access: AccessContext,
  options: { quarter?: SkillsSurveyQuarter | null } = {},
): Promise<SkillsSurveyWorkspace> {
  assertCanOpen(access);
  const today = currentCairoDateOnlyIso();
  const currentQuarter = skillsSurveyQuarterOf(today);
  const quarter = options.quarter ?? currentQuarter;

  const [config, directory, rows, quartersWithSurveys, experience] = await Promise.all([
    getSkillsSurveyConfig(),
    getEmployeeDirectoryRows({ includeInactive: true }),
    readQuarterRows(quarter),
    readQuartersWithSurveys(),
    readTotalExperienceByHrId(),
  ]);

  const chainIndex = buildSkillsSurveyChainIndex(directory);
  const viewerKey = normalizeHrId(access.hrId);
  const entries = rows
    .filter((row) => {
      const member = findPerson(directory, row.member_hr_id);
      if (!member) return access.role === "Super Admin" && !isSkillsSurveySubject(access, row.member_hr_id);
      const ratedByViewer = Boolean(viewerKey && hrIdsMatch(row.rater_hr_id, access.hrId));
      return canReadSkillsSurveyMember(access, member, chainIndex, ratedByViewer);
    })
    .map((row) => toEntry(row, directory));

  const canRate = canRateSkillsSurveys(access);
  const team: SkillsSurveyTeamMember[] = [];
  if (canRate) {
    const viewer = findPerson(directory, access.hrId);
    for (const member of directory) {
      if (!isActiveMember(member)) continue;
      if (!canRateSkillsSurveyMember(access, member)) continue;
      const entry = entries.find((candidate) => hrIdsMatch(candidate.memberHrId, member.hrId)) ?? null;
      const years = entry
        ? entry.yearsInRole
        : yearsForMember(experience, member.hrId, today);
      team.push({
        card: entry ? scoreSkillsSurveyEntry(entry, config.settings) : null,
        districtName: entry?.districtName ?? districtFor(member, viewer),
        hrId: member.hrId,
        name: personName(member) ?? member.hrId,
        rated: Boolean(entry),
        updatedAt: entry?.updatedAt ?? null,
        yearsInRole: years,
      });
    }
    team.sort((left, right) => Number(left.rated) - Number(right.rated) || left.name.localeCompare(right.name));
  }

  const quarterKeys = new Map<string, SkillsSurveyQuarter>();
  for (const candidate of [currentQuarter, quarter, ...quartersWithSurveys]) {
    quarterKeys.set(`${candidate.year}-${candidate.quarter}`, candidate);
  }

  return {
    config,
    currentQuarter,
    entries,
    quarter,
    quarters: [...quarterKeys.values()].sort(quarterOrder),
    team,
    today,
    viewer: {
      canEditSettings: canEditSkillsSurveySettings(access),
      canRate,
      name: personName(findPerson(directory, access.hrId)),
    },
  };
}

function isActiveMember(member: EmployeeDirectoryRow) {
  const status = String(member.employmentStatus ?? "active").toLowerCase();
  return (status === "active" || status === "on_leave") && isSkillsSurveyMember(member);
}

function yearsForMember(
  experience: Awaited<ReturnType<typeof readTotalExperienceByHrId>>,
  hrId: string,
  onDate: string,
): number | null {
  const filled = totalExperienceFor(experience, hrId);
  return filled ? yearsInRoleOn(filled.years, filled.asOf, onDate) : null;
}

/**
 * One team member's survey, for the form: this quarter's by default (editable by his District
 * Manager), or an earlier quarter's, read only.
 */
export async function getSkillsSurveyMemberForm(
  access: AccessContext,
  memberHrId: string,
  options: { quarter?: SkillsSurveyQuarter | null } = {},
): Promise<SkillsSurveyMemberForm> {
  assertCanOpen(access);
  if (isSkillsSurveySubject(access, memberHrId)) forbidden("the person rated never sees this survey.");
  const today = currentCairoDateOnlyIso();
  const currentQuarter = skillsSurveyQuarterOf(today);
  const quarter = options.quarter ?? currentQuarter;
  const isCurrentQuarter = quarter.year === currentQuarter.year && quarter.quarter === currentQuarter.quarter;

  const [config, directory, experience] = await Promise.all([
    getSkillsSurveyConfig(),
    getEmployeeDirectoryRows({ includeInactive: true }),
    readTotalExperienceByHrId(),
  ]);
  const member = findPerson(directory, memberHrId);
  if (!member) throw new SkillsSurveyError("This team member was not found.", 404);

  const { data, error } = await getSupabaseAdmin()
    .from("coaching_skills_surveys")
    .select(surveyColumns)
    .eq("member_hr_id", member.hrId)
    .eq("survey_year", quarter.year)
    .eq("survey_quarter", quarter.quarter)
    .maybeSingle();
  if (error) throw error;
  const survey = data ? toEntry(data as SurveyDbRow, directory) : null;

  const chainIndex = buildSkillsSurveyChainIndex(directory);
  const ratedByViewer = Boolean(survey && hrIdsMatch(survey.raterHrId, access.hrId));
  const canEdit = isCurrentQuarter && canRateSkillsSurveyMember(access, member) && isActiveMember(member);
  if (!canEdit && !canReadSkillsSurveyMember(access, member, chainIndex, ratedByViewer)) {
    forbidden(`${access.role} cannot read this team member's survey.`);
  }
  if (!canEdit && !survey && !isCurrentQuarter) {
    throw new SkillsSurveyError("There is no survey for this team member in that quarter.", 404);
  }

  const manager = canEdit ? findPerson(directory, access.hrId) : findPerson(directory, member.managerHrId);
  return {
    canEdit,
    config,
    districtManagerName: survey && !canEdit ? survey.raterName : personName(manager),
    districtName: survey && !canEdit ? survey.districtName : districtFor(member, manager),
    member: { hrId: member.hrId, name: personName(member) ?? member.hrId },
    quarter,
    survey,
    today,
    yearsInRole: canEdit || !survey ? yearsForMember(experience, member.hrId, today) : survey.yearsInRole,
  };
}

export type SkillsSurveySaveInput = {
  memberHrId: string;
  scores: unknown;
  developmentPriorities: unknown;
  /** The quarter the form was opened in — a form left open past the quarter's end is refused. */
  year?: number | null;
  quarter?: number | null;
  /**
   * The team member's total years of experience, typed by his District Manager on the form (owner,
   * 2026-10-31: "make hr or dm can fill years of experience of the rep"). Left out or empty keeps
   * the value on his record as it is.
   */
  totalExperienceYears?: unknown;
};

const developmentPrioritiesMaxLength = 2000;

/** Saves the District Manager's survey: creates this quarter's, or updates it until the quarter ends. */
export async function saveSkillsSurvey(access: AccessContext, input: SkillsSurveySaveInput): Promise<SkillsSurveyEntry> {
  assertNotTestAccount(access);
  if (isSkillsSurveySubject(access, input.memberHrId)) forbidden("nobody rates their own survey.");
  const today = currentCairoDateOnlyIso();
  const quarter = skillsSurveyQuarterOf(today);
  if (
    (input.year !== undefined && input.year !== null && input.year !== quarter.year) ||
    (input.quarter !== undefined && input.quarter !== null && input.quarter !== quarter.quarter)
  ) {
    throw new SkillsSurveyError("This quarter has ended. Its survey can no longer be changed.", 409);
  }

  const [config, directory, experience] = await Promise.all([
    getSkillsSurveyConfig(),
    getEmployeeDirectoryRows({ includeInactive: true }),
    readTotalExperienceByHrId(),
  ]);
  const member = findPerson(directory, input.memberHrId);
  if (!member) throw new SkillsSurveyError("This team member was not found.", 404);
  if (!isActiveMember(member) || !canRateSkillsSurveyMember(access, member)) {
    forbidden("only the team member's own District Manager fills this survey.");
  }

  const activeKeys = new Set(config.skills.filter((skill) => skill.isActive).map((skill) => skill.key));
  const scores = normalizeSkillsSurveyScores(input.scores, activeKeys);
  const priorities = typeof input.developmentPriorities === "string" ? input.developmentPriorities.trim() : "";
  if (priorities.length > developmentPrioritiesMaxLength) {
    throw new SkillsSurveyError(`Keep the development priorities under ${developmentPrioritiesMaxLength} characters.`);
  }

  // Years of experience is ONE field on the employee record: HR fills it on the Employee Master, and
  // the team member's own District Manager may fill or correct it here — only after the check above
  // that this is his team member. Writing it restarts its as-of day (the database trigger), so HR,
  // the next survey and the Ranking all read the new figure. An unchanged figure writes nothing.
  let yearsInRole = yearsForMember(experience, member.hrId, today);
  const typedYears = input.totalExperienceYears;
  if (typedYears !== undefined && typedYears !== null && String(typedYears).trim() !== "") {
    let entered: number | null;
    try {
      entered = parseTotalExperienceYears(typedYears);
    } catch (cause) {
      throw new SkillsSurveyError(cause instanceof Error ? cause.message : "Check the years of experience.");
    }
    if (entered !== null && entered !== yearsInRole) {
      await saveTotalExperienceYears(member.hrId, entered);
      yearsInRole = entered;
    }
  }

  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("coaching_skills_surveys")
    .select("id,scores")
    .eq("member_hr_id", member.hrId)
    .eq("survey_year", quarter.year)
    .eq("survey_quarter", quarter.quarter)
    .maybeSingle();
  if (existingResult.error) throw existingResult.error;
  const existing = existingResult.data as { id: string; scores: unknown } | null;

  // A rating for a skill the Training Manager has since turned off is kept, never wiped by a re-save.
  const kept = existing ? readSkillsSurveyScores(existing.scores) : {};
  for (const key of Object.keys(kept)) if (activeKeys.has(key)) delete kept[key];

  const viewer = findPerson(directory, access.hrId);
  const actor = hrIdForStorage(access.hrId);
  const row = {
    area_id: member.areaId,
    development_priorities: priorities || null,
    district_name: districtFor(member, viewer),
    line_id: member.lineId,
    member_hr_id: member.hrId,
    member_role: "Medical Rep",
    rater_hr_id: viewer?.hrId ?? actor,
    rater_role: access.role,
    scores: { ...kept, ...scores },
    survey_date: today,
    survey_quarter: quarter.quarter,
    survey_year: quarter.year,
    team_id: member.teamId,
    updated_at: new Date().toISOString(),
    updated_by: actor,
    years_in_role: yearsInRole,
  };

  const saved = existing
    ? await supabase.from("coaching_skills_surveys").update(row).eq("id", existing.id).select(surveyColumns).single()
    : await supabase
        .from("coaching_skills_surveys")
        .insert({ ...row, created_by: actor })
        .select(surveyColumns)
        .single();
  if (saved.error) throw saved.error;
  return toEntry(saved.data as SurveyDbRow, directory);
}

/** Every quarter's survey of one person, oldest first — the Employee 360 section. Null when the viewer may not read it. */
export async function getSkillsSurveyHistoryForMember(
  access: AccessContext,
  memberHrId: string,
): Promise<{ config: SkillsSurveyConfig; entries: SkillsSurveyEntry[] } | null> {
  if (!canOpenSkillsSurvey(access) || isSkillsSurveySubject(access, memberHrId)) return null;
  const [config, directory] = await Promise.all([
    getSkillsSurveyConfig(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const member = findPerson(directory, memberHrId);
  if (!member) return null;
  const chainIndex = buildSkillsSurveyChainIndex(directory);

  const { data, error } = await getSupabaseAdmin()
    .from("coaching_skills_surveys")
    .select(surveyColumns)
    .eq("member_hr_id", member.hrId)
    .order("survey_year", { ascending: true })
    .order("survey_quarter", { ascending: true });
  if (error) throw error;

  const entries = ((data ?? []) as SurveyDbRow[])
    .filter((row) => canReadSkillsSurveyMember(access, member, chainIndex, hrIdsMatch(row.rater_hr_id, access.hrId)))
    .map((row) => toEntry(row, directory));
  if (entries.length === 0 && !canReadSkillsSurveyMember(access, member, chainIndex)) return null;
  return { config, entries };
}

export type SkillsSurveySkillInput = {
  key?: string | null;
  name: string;
  goodLooksLike?: string | null;
  isActive?: boolean;
};

export type SkillsSurveySettingsInput = {
  settings?: Partial<SkillsSurveySettings>;
  /** The whole list, in the order to show it. A skill left out is kept, turned off — never deleted. */
  skills?: SkillsSurveySkillInput[];
};

/** The Training Manager's settings and skills list. */
export async function saveSkillsSurveySettings(
  access: AccessContext,
  input: SkillsSurveySettingsInput,
): Promise<SkillsSurveyConfig> {
  assertNotTestAccount(access);
  if (!canEditSkillsSurveySettings(access)) {
    forbidden("only the Training Manager changes the survey settings and skills.");
  }
  const current = await getSkillsSurveyConfig();
  const supabase = getSupabaseAdmin();
  const actor = hrIdForStorage(access.hrId);
  const now = new Date().toISOString();

  if (input.settings) {
    let next: SkillsSurveySettings;
    try {
      next = normalizeSkillsSurveySettings(input.settings, current.settings);
    } catch (error) {
      throw new SkillsSurveyError(error instanceof Error ? error.message : "The settings could not be saved.");
    }
    const { error } = await supabase.from("coaching_skills_survey_settings").upsert({
      capability_weight: next.capabilityWeight,
      experience_bands: next.experienceBands,
      full_experience_years: next.fullExperienceYears,
      id: 1,
      target_score: next.targetScore,
      updated_at: now,
      updated_by: actor,
    });
    if (error) throw error;
  }

  if (input.skills) {
    if (!Array.isArray(input.skills)) throw new SkillsSurveyError("Send the skills as a list.");
    const existingKeys = new Set(current.skills.map((skill) => skill.key));
    const usedKeys = new Set(existingKeys);
    const sent = new Set<string>();
    const rows = input.skills.map((skill, index) => {
      const name = String(skill?.name ?? "").trim();
      if (!name) throw new SkillsSurveyError(`Skill ${index + 1} needs a name.`);
      if (name.length > 120) throw new SkillsSurveyError(`Keep the skill name "${name}" under 120 characters.`);
      const goodLooksLike = String(skill.goodLooksLike ?? "").trim();
      if (goodLooksLike.length > 600) throw new SkillsSurveyError(`Keep what good looks like for "${name}" under 600 characters.`);
      let key = skill.key && existingKeys.has(skill.key) ? skill.key : null;
      if (!key) {
        key = skillsSurveySkillKeyFor(name, usedKeys);
        usedKeys.add(key);
      }
      if (sent.has(key)) throw new SkillsSurveyError(`The skill "${name}" is in the list twice.`);
      sent.add(key);
      return {
        display_order: index + 1,
        good_looks_like: goodLooksLike,
        is_active: skill.isActive !== false,
        key,
        name,
        updated_at: now,
        updated_by: actor,
      };
    });
    if (!rows.some((row) => row.is_active)) throw new SkillsSurveyError("Keep at least one skill turned on.");
    const leftOut = current.skills
      .filter((skill) => !sent.has(skill.key))
      .map((skill, index) => ({
        display_order: rows.length + index + 1,
        good_looks_like: skill.goodLooksLike,
        is_active: false,
        key: skill.key,
        name: skill.name,
        updated_at: now,
        updated_by: actor,
      }));
    const { error } = await supabase.from("coaching_skills_survey_skills").upsert([...rows, ...leftOut], { onConflict: "key" });
    if (error) throw error;
  }

  return getSkillsSurveyConfig();
}
