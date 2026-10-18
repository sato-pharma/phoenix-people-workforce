// Recruitment / ATS — the candidate pool's columns ARE the WhatsApp bot's questions, and the reader
// decides which of them show.
//
// The owner, 2026-10-19: "in /recruitment make the headers as per the whatsapp questions and match the
// candidates as per their whatsapp applications and answers". Asked how, since each role is asked
// different questions (an Office Coordinator five of their own, a Product Manager five, an HR Section
// Head eight) and one fixed header row cannot hold them all without scrolling sideways, he chose
// "switch by role":
//
//   • No role picked — the headers are the questions everyone meets: what they applied for, what they
//     graduated in, region and area, experience, expected salary (`POOL_SHARED_COLUMNS`).
//   • A role picked in the Role filter — the headers become every question THAT role is asked, in the
//     order every other screen lists answers (`poolRoleQuestionColumns`), and each cell is that
//     candidate's own answer (`poolAnswersByColumn`).
//
// Then, the same day: "make me able to edit or add a missing field and full control" — and he chose
// both halves. Any answer cell can be edited or filled in (whatsapp-answer-edit.ts), and the reader can
// add a column for any question, hide one and reorder them (`poolColumnCatalogue`,
// `applyPoolColumnLayout`). The layout is kept per view, so "Office Coordinator" keeps its own.
//
// ONE COLUMN MODEL FOR BOTH VIEWS. A built-in question is always the same column — region and area
// share one, "place" — so it shows the same cell whichever view it appears in, with the CV standing in
// where the bot never asked. An admin question is `extra:<key>`.
//
// PURE — no I/O. The question wording and the saved audiences arrive as arguments, read on the server
// (screening-question-labels.ts, loadSavedAudiences), so the client table can import this freely.
//
// WHO IS ASKED WHAT is never re-derived here: the built-in six go through
// `builtInQuestionAppliesToRole` (the bot's own rule), the admin's questions through their own
// `appliesToRoleFamilies`. A RETIRED question stays a column only while somebody on screen answered
// it — an answer given before it was switched off is still an answer, and an empty column is noise.

import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import {
  builtInQuestionAppliesToRole,
  builtInQuestionKeys,
  type BuiltInQuestionKey,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import {
  BUILT_IN_ANSWER_QUESTIONS,
  candidateWhatsAppAnswers,
  type ScreeningQuestionLabel,
  type WhatsAppAnswersCandidateRow,
} from "@/lib/recruitment/whatsapp-answers";

/** The built-in questions as pool columns. Region and area are ONE column: the area is the region answered more precisely. */
export const poolSharedColumnKeys = ["appliedFor", "background", "place", "experience", "salary"] as const;
export type PoolSharedColumnKey = (typeof poolSharedColumnKeys)[number];
export type PoolColumnKey = PoolSharedColumnKey | `extra:${string}`;

/**
 * The headers, in the bot's own words, from the one list the answers panel and the Screening
 * Questions screen already share — never a second spelling.
 */
export const POOL_SHARED_QUESTION_HEADERS: Record<PoolSharedColumnKey, string> = {
  appliedFor: BUILT_IN_ANSWER_QUESTIONS.job_title,
  background: BUILT_IN_ANSWER_QUESTIONS.background,
  experience: BUILT_IN_ANSWER_QUESTIONS.experience,
  place: `${BUILT_IN_ANSWER_QUESTIONS.region} · ${BUILT_IN_ANSWER_QUESTIONS.area}`,
  salary: BUILT_IN_ANSWER_QUESTIONS.salary,
};

/** The answer keys (whatsapp-answer-edit.ts) each built-in column edits. Place edits two. */
export const POOL_SHARED_COLUMN_EDIT_KEYS: Record<PoolSharedColumnKey, readonly BuiltInQuestionKey[]> = {
  appliedFor: ["job_title"],
  background: ["background"],
  experience: ["experience"],
  place: ["region", "area"],
  salary: ["salary"],
};

/** The saved built-in audiences, as a plain object so it can cross into a client component. */
export type PoolSavedAudiences = Readonly<Record<string, readonly string[]>>;

/** What the server hands the pool so its headers can follow the bot. */
export type PoolWhatsAppQuestions = {
  /** Every admin-defined question, active and retired, in the admin's own order. */
  questions: ScreeningQuestionLabel[];
  /** Built-in question key → the role families it is limited to. A key absent means its default. */
  audiences: PoolSavedAudiences;
};

export type PoolTableColumn = {
  key: PoolColumnKey;
  /** The question, in the words the bot asks it. */
  header: string;
  /** "Asked only to Office Coordinator applicants", so two questions worded alike can be told apart. */
  askedTo: string | null;
  /** The answer keys a save writes, in order. */
  editKeys: readonly string[];
};

/** A built-in question as returned by `poolRoleQuestionColumns`, before it is folded into a pool column. */
export type PoolQuestionColumn = {
  /** `candidateWhatsAppAnswers`'s key: the built-in step's name, or `extra:<question key>`. */
  key: string;
  header: string;
  builtIn: BuiltInQuestionKey | null;
};

function askedToLine(families: readonly string[] | null | undefined): string | null {
  const labels = (families ?? [])
    .map((family) => (candidateRoleFamilyLabels as Record<string, string | undefined>)[family])
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? `Asked only to ${labels.join(" or ")} applicants` : null;
}

function sharedColumn(key: PoolSharedColumnKey): PoolTableColumn {
  return { askedTo: null, editKeys: POOL_SHARED_COLUMN_EDIT_KEYS[key], header: POOL_SHARED_QUESTION_HEADERS[key], key };
}

function extraColumn(question: ScreeningQuestionLabel): PoolTableColumn | null {
  const header = question.bodyText.trim();
  if (!header) return null;
  const key = `extra:${question.questionKey}` as const;
  return { askedTo: askedToLine(question.appliesToRoleFamilies), editKeys: [key], header, key };
}

/**
 * Every question a role is asked: built-in six first in the order an applicant meets them, then the
 * admin's questions in his own order. "What are you applying for?" is left off — the Role filter
 * already answers it for every row shown.
 *
 * `answeredKeys` is the set of answer keys present on the rows on screen; it keeps a retired question
 * (or a built-in outside its audience) that somebody answered, and only that. `whatsapp` null (the
 * question list could not be read) leaves the built-in questions on their default audiences and no
 * admin question at all — never a column under a raw key.
 */
export function poolRoleQuestionColumns(input: {
  roleFamily: CandidateRoleFamily;
  whatsapp: PoolWhatsAppQuestions | null;
  answeredKeys: ReadonlySet<string>;
}): PoolQuestionColumn[] {
  const { answeredKeys, roleFamily, whatsapp } = input;
  const columns: PoolQuestionColumn[] = [];
  for (const key of builtInQuestionKeys) {
    if (key === "job_title") continue;
    const saved = whatsapp && Object.prototype.hasOwnProperty.call(whatsapp.audiences, key) ? whatsapp.audiences[key] : undefined;
    if (!builtInQuestionAppliesToRole(key, saved, roleFamily) && !answeredKeys.has(key)) continue;
    columns.push({ builtIn: key, header: BUILT_IN_ANSWER_QUESTIONS[key], key });
  }
  for (const question of whatsapp?.questions ?? []) {
    const key = `extra:${question.questionKey}`;
    const families = question.appliesToRoleFamilies ?? null;
    const askedToRole = !families || families.length === 0 || families.includes(roleFamily);
    if (!askedToRole) continue;
    if (question.isActive === false && !answeredKeys.has(key)) continue;
    if (!question.bodyText.trim()) continue;
    columns.push({ builtIn: null, header: question.bodyText.trim(), key });
  }
  return columns;
}

/** The built-in question → the pool column that shows it. Region and area both land on "place". */
function sharedColumnFor(builtIn: BuiltInQuestionKey): PoolSharedColumnKey {
  if (builtIn === "job_title") return "appliedFor";
  if (builtIn === "region" || builtIn === "area") return "place";
  return builtIn;
}

/**
 * The columns a view starts with, before the reader changes anything: the shared five with no role
 * picked, or that role's own questions.
 */
export function poolDefaultColumns(input: {
  roleFamily: CandidateRoleFamily | null;
  whatsapp: PoolWhatsAppQuestions | null;
  answeredKeys: ReadonlySet<string>;
}): PoolTableColumn[] {
  if (!input.roleFamily) return poolSharedColumnKeys.map(sharedColumn);
  const questions = new Map((input.whatsapp?.questions ?? []).map((question) => [`extra:${question.questionKey}`, question]));
  const columns: PoolTableColumn[] = [];
  const seen = new Set<string>();
  for (const question of poolRoleQuestionColumns({ ...input, roleFamily: input.roleFamily })) {
    const column = question.builtIn
      ? sharedColumn(sharedColumnFor(question.builtIn))
      : extraColumn(questions.get(question.key)!);
    if (!column || seen.has(column.key)) continue;
    seen.add(column.key);
    columns.push(column);
  }
  return columns;
}

/**
 * Every column the reader may add: the shared five, then every admin question — active ones, and a
 * retired one only while somebody on screen answered it.
 */
export function poolColumnCatalogue(whatsapp: PoolWhatsAppQuestions | null, answeredKeys: ReadonlySet<string>): PoolTableColumn[] {
  const columns = poolSharedColumnKeys.map(sharedColumn);
  for (const question of whatsapp?.questions ?? []) {
    if (question.isActive === false && !answeredKeys.has(`extra:${question.questionKey}`)) continue;
    const column = extraColumn(question);
    if (column) columns.push(column);
  }
  return columns;
}

/**
 * The columns actually drawn: the reader's saved order for this view, or the view's defaults when
 * nothing is saved. A saved key no longer in the catalogue (a question deleted since) is dropped, so a
 * layout can never show a column under a raw key.
 */
export function applyPoolColumnLayout(
  defaults: readonly PoolTableColumn[],
  catalogue: readonly PoolTableColumn[],
  saved: readonly string[] | null | undefined,
): PoolTableColumn[] {
  if (!saved) return [...defaults];
  const byKey = new Map([...catalogue, ...defaults].map((column) => [column.key, column]));
  const out: PoolTableColumn[] = [];
  const seen = new Set<string>();
  for (const key of saved) {
    const column = byKey.get(key as PoolColumnKey);
    if (!column || seen.has(column.key)) continue;
    seen.add(column.key);
    out.push(column);
  }
  return out;
}

/** The storage key of one view's layout: "all" with no role picked, else the role family. */
export function poolColumnViewKey(roleFamily: CandidateRoleFamily | null): string {
  return roleFamily ?? "all";
}

/**
 * One candidate's WhatsApp answers keyed by answer key — exactly `candidateWhatsAppAnswers`, so the
 * pool, the profile panel and the workstation can never disagree about what somebody said.
 */
export function poolAnswersByColumn(
  candidate: WhatsAppAnswersCandidateRow,
  whatsapp: PoolWhatsAppQuestions | null,
): Map<string, string> {
  return new Map(candidateWhatsAppAnswers(candidate, whatsapp?.questions ?? null).map((entry) => [entry.key, entry.answer]));
}

/** The caption above a role's table, so the reader knows the headers changed and why. */
export function poolRoleQuestionsCaption(roleFamily: CandidateRoleFamily, columnCount: number): string {
  const role = candidateRoleFamilyLabels[roleFamily];
  if (columnCount === 0) return `${role} applicants are not asked any WhatsApp questions beyond the job title.`;
  return `The columns are the ${columnCount === 1 ? "question" : `${columnCount} questions`} the WhatsApp bot asks ${role} applicants, each with the candidate's own answer.`;
}
