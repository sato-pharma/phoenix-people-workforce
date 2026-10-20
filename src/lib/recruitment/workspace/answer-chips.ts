// Recruitment workspace — every answer an applicant gave, as the labelled chips on line 2 of a row,
// and the answer filters built from the same question set.
//
// FROM THE APPLICANT'S OWN REPLIES ONLY (owner, 2026-10-20: "we do not look at the cv"). Every value
// here is read from a column the WhatsApp bot or the careers form writes, or from
// `screening_extra_answers`, plus whatever HR typed in their place, which `answer_marks` labels
// "added by HR". No CV-reading column (`cv_*`, `extracted_*`, `faculty`, `years_experience`, …) is
// ever read into a chip: an answer the applicant never gave is the amber "Missing · add" chip, never
// a guess from the CV. The built-in VALUES go through `candidateWhatsAppAnswers`, the one reader
// every screening screen uses, so the job-title gate (`preferences_declared_at`) and the region
// read-back cannot drift from them.
//
// THE MEDICAL REP SIX LEAD, IN HIS ORDER: Applying for · Graduated in · Years of experience ·
// Expected monthly net salary · When could you start · Age. Those are his words for the six, and
// they are the labels those six questions carry on every tab ("one question, one name"). Every other
// label is the bot's own wording: the region and area questions as the Screening Questions screen
// names them (`BUILT_IN_ANSWER_QUESTIONS`), an admin-defined question by the sentence the admin wrote.
//
// WHICH QUESTIONS A ROW SHOWS. Every question the person's role is asked — the built-ins through
// their saved audiences (`resolveBuiltInAudience`), the extras through `questionAppliesToRole`, a
// follow-up only when its `show_if` condition was met (`questionIsVisible`), a retired question
// never — answered or missing; then any other answer they DID give (an earlier application for
// another role, a question since retired), answered only. A question they were never going to be
// asked is never "missing".
//
// The loader reads the question rows itself rather than through
// whatsapp-screening-questions-session.ts, which drags the whole webhook state machine in behind it
// (the same reason screening-question-labels.ts exists).

import { candidateRoleFamilies, candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  candidateBackgroundLabels,
  candidateExperienceLabels,
  parseDeclaredSalaryFigure,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  audienceAppliesToRole,
  builtInQuestionKeys,
  resolveBuiltInAudience,
  type BuiltInQuestionKey,
  type QuestionAudience,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import { loadQuestionPromptOverrides } from "@/lib/recruitment/inbound/whatsapp-question-prompts-store";
import {
  questionAppliesToRole,
  questionIsVisible,
  showIfFromRow,
  type ScreeningQuestionShowIf,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import {
  BUILT_IN_ANSWER_QUESTIONS,
  UNREADABLE_QUESTION_LABEL,
  candidateWhatsAppAnswers,
} from "@/lib/recruitment/whatsapp-answers";
import { MISSING_ANSWER } from "@/lib/recruitment/workspace/filters";
import { roleTabForFamily, type WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceAnswerChip, WorkspaceAnswerFilter } from "@/lib/recruitment/workspace/types";

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

/** The chip keys of the six built-in answers, in the order an applicant meets them. "role" is the bot's `job_title` step. */
export const BUILT_IN_CHIP_KEYS = ["role", "background", "region", "area", "experience", "salary"] as const;
export type BuiltInChipKey = (typeof BUILT_IN_CHIP_KEYS)[number];

const BUILT_IN_STEP: Record<BuiltInChipKey, BuiltInQuestionKey> = {
  area: "area",
  background: "background",
  experience: "experience",
  region: "region",
  role: "job_title",
  salary: "salary",
};

function isBuiltInChipKey(key: string): key is BuiltInChipKey {
  return (BUILT_IN_CHIP_KEYS as readonly string[]).includes(key);
}

/** The owner's six, in his order (20 Oct 2026). Two are admin-defined questions, read by their live key. */
export const MEDICAL_REP_LEAD_KEYS = ["role", "background", "experience", "salary", "oc_start_date", "field_age_band"] as const;

/** His words for the six — the labels those questions carry on every tab. */
export const OWNER_ANSWER_LABELS: Readonly<Record<string, string>> = {
  background: "Graduated in",
  experience: "Years of experience",
  field_age_band: "Age",
  oc_start_date: "When could you start",
  role: "Applying for",
  salary: "Expected monthly net salary",
};

/**
 * The built-ins the database filter can match (`ats_candidate_answer_value`, foundation migration).
 * Role, region and area are the tabs themselves, so they are never answer filters.
 */
export const FILTERABLE_BUILT_IN_KEYS: readonly BuiltInChipKey[] = ["background", "experience", "salary"];

export const NOT_ANSWERED_LABEL = "Not answered";

function isMoneyKey(key: string): boolean {
  return /salary/.test(key);
}

const MONEY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * How an answer reads on screen. A salary typed as a bare figure reads "30,000 EGP"; anything else —
 * a range, "negotiable", Arabic words — is the answer exactly as stored.
 */
export function answerDisplayValue(key: string, stored: string): string {
  if (isMoneyKey(key)) {
    const figure = parseDeclaredSalaryFigure(stored);
    if (figure !== null) return `${MONEY.format(figure)} EGP`;
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------------------------

export type ChipQuestion = {
  key: string;
  bodyText: string;
  kind: "tappable" | "free_text";
  /** The options in the admin's order. The stored answer is the TITLE the applicant tapped. */
  options: { value: string; title: string }[];
  appliesToRoleFamilies: string[] | null;
  isActive: boolean;
  showIf: ScreeningQuestionShowIf | null;
};

export type AnswerChipContext = {
  /** Every admin-defined question, retired ones included, in the admin's order. */
  questions: ChipQuestion[];
  /** The audience in force for each built-in step (saved, else the code default). */
  builtInAudience: Record<BuiltInQuestionKey, QuestionAudience>;
};

/** A chip's label: his words for the six, the bot's words for region and area, the admin's sentence for the rest. */
export function answerChipLabel(key: string, question?: Pick<ChipQuestion, "bodyText"> | null): string {
  if (OWNER_ANSWER_LABELS[key]) return OWNER_ANSWER_LABELS[key];
  if (key === "region") return BUILT_IN_ANSWER_QUESTIONS.region;
  if (key === "area") return BUILT_IN_ANSWER_QUESTIONS.area;
  const body = String(question?.bodyText ?? "").trim();
  return body || UNREADABLE_QUESTION_LABEL;
}

/** The bot families a tab holds. Null = every family (Folders, or a search across tabs); [] = none known (Needs placing). */
export function familiesForTab(tab: WorkspaceTabKey | null): string[] | null {
  if (tab === null || tab === "folders") return null;
  if (tab === "needs_placing") return [];
  return candidateRoleFamilies.filter((family) => roleTabForFamily(family) === tab);
}

function visibilityList(context: AnswerChipContext) {
  return context.questions.map((question) => ({
    options: question.options.map((option) => ({ description: null, title: option.title, value: option.value })),
    questionKey: question.key,
  }));
}

// ---------------------------------------------------------------------------------------------
// One candidate's chips
// ---------------------------------------------------------------------------------------------

/** The reply columns, and only those. Never a CV-reading column. */
export type AnswerChipCandidate = {
  declaredRoleFamily: string | null;
  appliedForJobTitle: string | null;
  preferencesDeclaredAt: string | null;
  declaredBackground: string | null;
  declaredExperience: string | null;
  declaredExpectedSalary: string | null;
  preferredRegionCode: string | null;
  preferredRegionName: string | null;
  preferredAreaName: string | null;
  screeningExtraAnswers: Record<string, unknown> | null;
  answerMarks: Record<string, unknown> | null;
};

type HrMark = { hrId: string; at: string };

/** `answer_marks` is `{key: {by: "hr", hr_id, at}}` (foundation migration). First key that carries one wins. */
function markFor(marks: Record<string, unknown> | null, keys: readonly string[]): HrMark | null {
  if (!marks) return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(marks, key)) continue;
    const raw = marks[key] as { hr_id?: unknown; at?: unknown } | null;
    if (!raw || typeof raw !== "object") continue;
    const hrId = String(raw.hr_id ?? "").trim();
    if (hrId) return { at: String(raw.at ?? ""), hrId };
  }
  return null;
}

function markKeysFor(key: string): string[] {
  if (key === "role") return ["role", "job_title"];
  if (isBuiltInChipKey(key)) return [key];
  return [key, `extra:${key}`];
}

/** Every hr id that typed an answer on this record — for one batched name read per page. */
export function answerMarkHrIds(marks: Record<string, unknown> | null): string[] {
  if (!marks) return [];
  const ids = new Set<string>();
  for (const value of Object.values(marks)) {
    const hrId = String((value as { hr_id?: unknown } | null)?.hr_id ?? "").trim();
    if (hrId) ids.add(hrId);
  }
  return [...ids];
}

function textOf(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  return value.length > 0 ? value : null;
}

/**
 * The chips for one candidate in one tab. PURE.
 *
 * WHICH UNANSWERED QUESTIONS SHOW AS "MISSING". When the stored completeness exists
 * (`missing_answer_keys`, completeness.ts), exactly those keys — so the amber chips, the "5 of 6
 * answered" mark and the Missing-data filter can never disagree, all three reading one column. Only
 * when it has not been computed yet does this work the expectation out itself, by the same rules:
 * `roleFamily` is the family whose questions apply — the placement's own tapped family for this tab,
 * else the role they declared; null when nothing is known (Needs placing), and then only the
 * questions asked to everyone are expected, the bot's own rule for an unknown role.
 */
export function answerChipsFor(
  candidate: AnswerChipCandidate,
  options: {
    tab: WorkspaceTabKey | null;
    roleFamily: string | null;
    context: AnswerChipContext;
    nameOf: (hrId: string) => string | null;
    /** The stored `missing_answer_keys`; null when completeness has not been computed for them. */
    missingKeys?: readonly string[] | null;
  },
): WorkspaceAnswerChip[] {
  const { context, roleFamily, tab } = options;
  const extras = candidate.screeningExtraAnswers ?? {};
  const ownExtra = (key: string): string | null =>
    Object.prototype.hasOwnProperty.call(extras, key) ? textOf(extras[key]) : null;

  // The built-in values, through the one reader every screening screen uses (extras passed as none,
  // so only the six come back).
  const read = new Map(
    candidateWhatsAppAnswers(
      {
        appliedForJobTitle: candidate.appliedForJobTitle,
        declaredBackground: candidate.declaredBackground,
        declaredExpectedSalary: candidate.declaredExpectedSalary,
        declaredExperience: candidate.declaredExperience,
        preferencesDeclaredAt: candidate.preferencesDeclaredAt,
        preferredAreaName: candidate.preferredAreaName,
        preferredRegionCode: candidate.preferredRegionCode,
        preferredRegionName: candidate.preferredRegionName,
        screeningExtraAnswers: null,
      },
      [],
    ).map((answer) => [answer.key, answer.answer] as const),
  );
  const familyLabel = (family: string | null): string | null =>
    family ? ((candidateRoleFamilyLabels as Record<string, string | undefined>)[family] ?? null) : null;
  // The role they tapped; failing that, the role their placement says (HR filed them, or a tab with
  // one role) — the same "role is known" rule completeness.ts counts by.
  const declaredRoleLabel = familyLabel(candidate.declaredRoleFamily) ?? familyLabel(roleFamily);
  const jobTitle = read.get("job_title") ?? null;

  const builtIn: Record<BuiltInChipKey, { value: string | null; raw: string | null }> = {
    area: { raw: textOf(candidate.preferredAreaName), value: read.get("area") ?? null },
    background: { raw: textOf(candidate.declaredBackground), value: read.get("background") ?? null },
    experience: { raw: textOf(candidate.declaredExperience), value: read.get("experience") ?? null },
    region: {
      raw: textOf(candidate.preferredRegionCode) ?? textOf(candidate.preferredRegionName),
      value: read.get("region") ?? null,
    },
    // Their own words for the role when the bot stamped them (`preferences_declared_at`); otherwise
    // the family they tapped. Never the CV reader's guess at a title.
    role: {
      raw: textOf(candidate.declaredRoleFamily) ?? jobTitle,
      value: jobTitle ?? declaredRoleLabel,
    },
    salary: { raw: textOf(candidate.declaredExpectedSalary), value: read.get("salary") ?? null },
  };

  const questionByKey = new Map(context.questions.map((question) => [question.key, question]));
  const givenTitles: Record<string, string> = {};
  for (const key of Object.keys(extras)) {
    const value = ownExtra(key);
    if (value) givenTitles[key] = value;
  }
  const visibility = visibilityList(context);

  const storedMissing = options.missingKeys ? new Set(options.missingKeys) : null;
  const expected = (key: string): boolean => {
    if (storedMissing) return storedMissing.has(key);
    if (isBuiltInChipKey(key)) {
      return audienceAppliesToRole(context.builtInAudience[BUILT_IN_STEP[key]], roleFamily);
    }
    const question = questionByKey.get(key);
    return Boolean(
      question &&
        question.isActive &&
        questionAppliesToRole(question, roleFamily) &&
        questionIsVisible(question, givenTitles, visibility),
    );
  };
  const valueOf = (key: string): { value: string | null; raw: string | null } => {
    if (isBuiltInChipKey(key)) return builtIn[key];
    const value = ownExtra(key);
    return { raw: value, value };
  };

  // The order: his six on the Medical Rep tab, then the built-ins in the order the bot asks them,
  // then the admin's questions in his order, then any other answer they gave.
  const order: string[] = [];
  const seen = new Set<string>();
  const enqueue = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    order.push(key);
  };
  if (tab === "medical_rep") MEDICAL_REP_LEAD_KEYS.forEach(enqueue);
  BUILT_IN_CHIP_KEYS.forEach(enqueue);
  context.questions.forEach((question) => enqueue(question.key));
  Object.keys(givenTitles).forEach(enqueue);
  storedMissing?.forEach(enqueue);

  const lead = new Set<string>(tab === "medical_rep" ? MEDICAL_REP_LEAD_KEYS : []);
  const chips: WorkspaceAnswerChip[] = [];
  for (const key of order) {
    const { raw, value } = valueOf(key);
    if (!value && !expected(key)) continue;
    const mark = value ? markFor(candidate.answerMarks, markKeysFor(key)) : null;
    chips.push({
      addedByHr: mark ? { at: mark.at, hrId: mark.hrId, name: options.nameOf(mark.hrId) } : null,
      key,
      label: answerChipLabel(key, questionByKey.get(key)),
      lead: lead.has(key),
      rawValue: value ? raw : null,
      value: value ? answerDisplayValue(key, value) : null,
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------------------------
// The answer filters
// ---------------------------------------------------------------------------------------------

/** Stored values seen in the tab, per answer key — read by the caller so the list offers what people actually typed. */
export type StoredAnswerValues = Partial<Record<string, readonly string[]>>;

function appliesToAny(audience: QuestionAudience, families: string[] | null): boolean {
  if (!audience || audience.length === 0) return true;
  if (families === null) return true;
  return families.some((family) => audience.includes(family));
}

function uniqueOptions(values: Iterable<string>, key: string, into: { value: string; label: string }[]) {
  const have = new Set(into.map((option) => option.value));
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || have.has(value)) continue;
    have.add(value);
    into.push({ label: answerDisplayValue(key, value), value });
  }
}

/**
 * The answer filters a tab offers. PURE.
 *
 * One per question that tab's people are asked: the filterable built-ins (background, experience,
 * salary — the three `ats_candidate_answer_value` reads) and every ACTIVE admin-defined question. The
 * values are the STORED answers (the built-ins store the label tapped; an extra stores its option's
 * title), so a ticked value matches the database exactly. Each list is the question's own options in
 * the admin's order, then any other stored value (typed "Other" answers, retired options), then
 * "Not answered". Needs placing offers only the questions asked to everyone; Folders offers them all.
 */
export function buildAnswerFilters(
  tab: WorkspaceTabKey | null,
  context: AnswerChipContext,
  stored: StoredAnswerValues = {},
): WorkspaceAnswerFilter[] {
  const families = familiesForTab(tab);
  const filters: WorkspaceAnswerFilter[] = [];

  for (const key of FILTERABLE_BUILT_IN_KEYS) {
    if (!appliesToAny(context.builtInAudience[BUILT_IN_STEP[key]], families)) continue;
    const options: { value: string; label: string }[] = [];
    if (key === "background") uniqueOptions(Object.values(candidateBackgroundLabels), key, options);
    if (key === "experience") uniqueOptions(Object.values(candidateExperienceLabels), key, options);
    uniqueOptions(stored[key] ?? [], key, options);
    options.push({ label: NOT_ANSWERED_LABEL, value: MISSING_ANSWER });
    filters.push({ key, label: answerChipLabel(key), options });
  }

  for (const question of context.questions) {
    if (!question.isActive) continue;
    if (!appliesToAny(question.appliesToRoleFamilies, families)) continue;
    const options: { value: string; label: string }[] = [];
    uniqueOptions(question.options.map((option) => option.title), question.key, options);
    uniqueOptions(stored[question.key] ?? [], question.key, options);
    options.push({ label: NOT_ANSWERED_LABEL, value: MISSING_ANSWER });
    filters.push({ key: question.key, label: answerChipLabel(question.key, question), options });
  }

  if (tab === "medical_rep") {
    const rank = (key: string) => {
      const at = (MEDICAL_REP_LEAD_KEYS as readonly string[]).indexOf(key);
      return at === -1 ? MEDICAL_REP_LEAD_KEYS.length : at;
    };
    filters.sort((a, b) => rank(a.key) - rank(b.key));
  }
  return filters;
}

/** Every key `buildAnswerFilters` can offer, so a caller reads stored values for exactly those. */
export function filterableAnswerKeys(context: AnswerChipContext): string[] {
  return [...FILTERABLE_BUILT_IN_KEYS, ...context.questions.filter((q) => q.isActive).map((q) => q.key)];
}

// ---------------------------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------------------------

export type ScreeningQuestionRow = {
  question_key: string | null;
  body_text: string | null;
  kind: string | null;
  options: unknown;
  applies_to_role_families: string[] | null;
  is_active: boolean | null;
  show_if: unknown;
};

function readOptions(raw: unknown): { value: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { value: string; title: string }[] = [];
  for (const entry of raw) {
    const option = entry as { value?: unknown; title?: unknown } | null;
    const title = typeof option?.title === "string" ? option.title.trim() : "";
    const value = typeof option?.value === "string" ? option.value : "";
    if (title) out.push({ title, value });
  }
  return out;
}

/** Fold the question rows and the saved built-in audiences into the context. PURE. */
export function foldAnswerChipContext(
  rows: readonly ScreeningQuestionRow[],
  savedAudiences: ReadonlyMap<string, { appliesToRoleFamilies?: readonly string[] | undefined }>,
): AnswerChipContext {
  const builtInAudience = {} as Record<BuiltInQuestionKey, QuestionAudience>;
  for (const key of builtInQuestionKeys) {
    builtInAudience[key] = resolveBuiltInAudience(key, savedAudiences.get(key)?.appliesToRoleFamilies);
  }
  const questions: ChipQuestion[] = [];
  for (const row of rows) {
    const key = String(row.question_key ?? "").trim();
    if (!key) continue;
    questions.push({
      appliesToRoleFamilies:
        Array.isArray(row.applies_to_role_families) && row.applies_to_role_families.length > 0
          ? row.applies_to_role_families
          : null,
      bodyText: String(row.body_text ?? ""),
      isActive: row.is_active !== false,
      key,
      kind: row.kind === "tappable" ? "tappable" : "free_text",
      options: readOptions(row.options),
      showIf: showIfFromRow(row.show_if),
    });
  }
  return { builtInAudience, questions };
}

/**
 * The question set as it stands now. Uncached: a handful of rows, and a cache would keep showing an
 * admin's old wording after he saved new (screening-question-labels.ts makes the same call). The
 * built-in audiences come from the prompt store, which caches and never throws.
 */
export async function loadAnswerChipContext(): Promise<AnswerChipContext> {
  const [questionsResult, overrides] = await Promise.all([
    recruitmentDb()
      .from("ats_whatsapp_screening_questions")
      .select("question_key,body_text,kind,options,applies_to_role_families,is_active,show_if,sort_order")
      .order("sort_order", { ascending: true }),
    loadQuestionPromptOverrides(),
  ]);
  if (questionsResult.error) throw new Error(questionsResult.error.message);
  return foldAnswerChipContext((questionsResult.data ?? []) as ScreeningQuestionRow[], overrides);
}
