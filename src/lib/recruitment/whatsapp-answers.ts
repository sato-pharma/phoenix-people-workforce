// Recruitment / ATS — every answer an applicant gave the WhatsApp bot, as one ordered list of
// question and answer.
//
// The owner, 2026-09-11: applicants who apply on WhatsApp are asked many questions — salary and much
// else — and he wants to read ALL of their answers while screening, beside the CV. Measured on
// production that day, two things stood in the way:
//
//   1. The questions an admin adds on /admin/screening-questions (age, MS Office, arranging travel,
//      start date) were answered by 116 candidates and displayed on NO screening screen. Only the CV
//      Library read them back.
//   2. The six built-in answers were on screen, but under the CV facts inside the Candidate snapshot,
//      labelled "Preferred area" and "Education (declared)" rather than as the questions they answer.
//
// So this turns a candidate record into the list a person reads: the six built-in questions in the
// order the applicant met them, then every admin-defined question in the admin's own order — retired
// questions included, because an answer given to a question since switched off is still an answer.
//
// PURE — no I/O. The wording of the admin-defined questions arrives as an argument, read on the
// server (screening-question-labels.ts), so client components can import this freely.

import {
  candidateRegionCodes,
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";

/**
 * One admin-defined question's wording, keyed the way `screening_extra_answers` is keyed, and who it
 * is asked to. `appliesToRoleFamilies` null or empty means everyone.
 */
export type ScreeningQuestionLabel = {
  questionKey: string;
  bodyText: string;
  appliesToRoleFamilies?: readonly string[] | null;
  /** False for a question the admin has switched off. Absent means unknown and is read as live. */
  isActive?: boolean;
};

export type WhatsAppAnswer = {
  /** Stable per candidate — the built-in step's name, or `extra:<question key>`. */
  key: string;
  /** The question, in words. Never a code. */
  question: string;
  /** Their answer, exactly as it was stored. */
  answer: string;
  /**
   * "Asked only to Office Coordinator applicants", or null for a question asked to everyone.
   *
   * Printed because one WhatsApp number can apply for several jobs, and the record keeps the answers
   * to a role-scoped question after a later application for another role replaces "Applying for".
   * Measured 2026-09-11: one number held nine conversations across four roles, and its record read
   * "Medical Representative" above six answers only an Office Coordinator applicant is ever asked —
   * which the owner read, reasonably, as the bot asking medical reps about commuting to Sheraton.
   */
  askedTo: string | null;
};

/** Just enough of a candidate to read the answers off. Structural, so `types.ts` need not import this. */
export type WhatsAppAnswersCandidateRow = {
  appliedForJobTitle?: string | null;
  declaredBackground?: string | null;
  declaredExperience?: string | null;
  declaredExpectedSalary?: string | null;
  preferencesDeclaredAt?: string | null;
  preferredAreaName?: string | null;
  preferredRegionCode?: string | null;
  preferredRegionName?: string | null;
  screeningExtraAnswers?: Record<string, unknown> | null;
};

/**
 * The six built-in questions, as the admin screen names them (whatsapp-question-prompts.ts, less the
 * number). Not the full prompt the applicant reads — several of those run to a paragraph, and this
 * list sits in a 322px panel. The test pins these against that screen's labels so the two cannot drift.
 */
export const BUILT_IN_ANSWER_QUESTIONS = {
  area: "Which area?",
  background: "What did you graduate in?",
  experience: "How much experience?",
  job_title: "What are you applying for?",
  region: "Which region?",
  salary: "Expected salary",
} as const;

/**
 * Where an answer's question cannot be named: the question list could not be read, or holds no row
 * for that key. The answer is still shown — hiding it would be exactly the gap this module closes —
 * but never under a raw key, and never under a question it may not answer.
 */
export const UNREADABLE_QUESTION_LABEL = "A screening question whose wording could not be loaded";

function text(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

/**
 * A question's audience in words — "Asked only to Office Coordinator applicants" — or null when it is
 * asked to everyone. A family with no label is left out rather than printed as a code; it matches no
 * applicant anyway (see screeningQuestionViolations).
 */
function askedToLine(families: readonly string[] | null | undefined): string | null {
  const labels = (families ?? [])
    .map((family) => (candidateRoleFamilyLabels as Record<string, string | undefined>)[family])
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? `Asked only to ${labels.join(" or ")} applicants` : null;
}

/**
 * The region they asked for: the company region's name for a tapped one, their own words for a typed
 * one. A stored code that is not a live region is not printed — it would be a raw code on screen.
 *
 * Deliberately NOT `candidateScreeningFacts`'s resolution, which turns a typed "Minya" into "Upper
 * Egypt" so the Region filter can file them. That is right for filing and wrong here: this list is
 * what the applicant said.
 */
function regionAnswer(candidate: WhatsAppAnswersCandidateRow): string | null {
  const tapped = text(candidate.preferredRegionCode);
  if (tapped && (candidateRegionCodes as readonly string[]).includes(tapped)) {
    return candidateRegionLabels[tapped as CandidateRegionCode];
  }
  return text(candidate.preferredRegionName);
}

/**
 * Every WhatsApp answer on this record, in the order it was asked. Empty when there are none.
 *
 * THE JOB TITLE IS GATED ON `preferencesDeclaredAt`, and it is the only one that is. Every other
 * column read here is written by the bot alone, but `applied_for_job_title` is also filled by the CV
 * reader and by people — three times in four by the reader, on the rows that never met the bot. The
 * stamp is written in the same update that writes the bot's job-title answer, so where it is present
 * the column holds what the applicant tapped or typed; where it is absent the column may be anybody's,
 * and printing it under "What are you applying for?" would put words in the applicant's mouth.
 * The header's "Applying for" line still shows that column either way, with its own provenance.
 *
 * `questions` is the admin's whole list in its own order, retired questions included. Null means it
 * could not be read, and every admin-defined answer is then listed under UNREADABLE_QUESTION_LABEL
 * rather than dropped.
 */
export function candidateWhatsAppAnswers(
  candidate: WhatsAppAnswersCandidateRow,
  questions: readonly ScreeningQuestionLabel[] | null,
): WhatsAppAnswer[] {
  const answers: WhatsAppAnswer[] = [];
  const add = (key: string, question: string, raw: unknown, askedTo: string | null = null) => {
    const answer = text(raw);
    if (answer) answers.push({ answer, askedTo, key, question });
  };

  if (text(candidate.preferencesDeclaredAt)) {
    add("job_title", BUILT_IN_ANSWER_QUESTIONS.job_title, candidate.appliedForJobTitle);
  }
  add("background", BUILT_IN_ANSWER_QUESTIONS.background, candidate.declaredBackground);
  add("region", BUILT_IN_ANSWER_QUESTIONS.region, regionAnswer(candidate));
  add("area", BUILT_IN_ANSWER_QUESTIONS.area, candidate.preferredAreaName);
  add("experience", BUILT_IN_ANSWER_QUESTIONS.experience, candidate.declaredExperience);
  // Verbatim, never the parsed figure: "25 k to 30 k" and "negotiable" are the answer. A figure typed
  // into the ATS by hand is not a WhatsApp answer and is shown by its caller, not here.
  add("salary", BUILT_IN_ANSWER_QUESTIONS.salary, candidate.declaredExpectedSalary);

  // Own keys only. A question key is any lower-case identifier, so one named `constructor` would
  // otherwise read Object's own member off a plain `{}` and list a function as an answer.
  const extra = candidate.screeningExtraAnswers ?? {};
  const own = (key: string): unknown => (Object.prototype.hasOwnProperty.call(extra, key) ? extra[key] : null);
  const named = new Set<string>();
  for (const question of questions ?? []) {
    named.add(question.questionKey);
    add(
      `extra:${question.questionKey}`,
      text(question.bodyText) ?? UNREADABLE_QUESTION_LABEL,
      own(question.questionKey),
      askedToLine(question.appliesToRoleFamilies),
    );
  }
  for (const key of Object.keys(extra)) {
    if (!named.has(key)) add(`extra:${key}`, UNREADABLE_QUESTION_LABEL, own(key));
  }
  return answers;
}
