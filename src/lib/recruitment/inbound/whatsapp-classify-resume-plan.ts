// Recruitment / ATS — where a resumed WhatsApp conversation picks up (owner, 2026-10-20). Pure.
//
// "Ask again" sends an applicant the approved follow-up template; when they reply, the bot opens a
// NEW conversation for the candidate they already are, pre-filled with every answer already on their
// record, and asks only what is still missing — never question one again, never an answer HR typed
// in for them. The send is resumeClassification (whatsapp-classify-resume.ts); this file decides.
//
// THE PRE-FILL IS THE SKIP. The conversation's own columns mark a question answered, and the bot's
// one transition (`advanceAfterBuiltIn`) steps over a question the conversation already holds. So
// every answer on the candidate must land in a column that reads as answered — including one the
// conversation could never have produced itself (an experience typed by HR outside the five bands is
// kept raw: it reads as answered, and its label lookup answers nothing, so it is never written back).

import {
  candidateBackgroundLabels,
  candidateExperienceLabels,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  nextBuiltInQuestion,
  type BuiltInQuestionKey,
  type SavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";

/** The candidate columns a resumed conversation is pre-filled from. */
export type ResumeCandidateRow = {
  declared_role_family: string | null;
  applied_for_job_title: string | null;
  declared_background: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  expected_salary: number | string | null;
  screening_extra_answers: Record<string, unknown> | null;
};

export const RESUME_CANDIDATE_COLUMNS =
  "declared_role_family,applied_for_job_title,declared_background,preferred_region_code,preferred_region_name,preferred_area_name,declared_experience,declared_expected_salary,expected_salary,screening_extra_answers";

/** The conversation columns a resumed conversation starts with. */
export type ResumePrefill = {
  job_title_family: string | null;
  job_title_other_text: string | null;
  background: string | null;
  background_other_text: string | null;
  region_code: string | null;
  region_other_text: string | null;
  area_name: string | null;
  area_other_text: string | null;
  experience: string | null;
  expected_salary: string | null;
  extra_answers: Record<string, string>;
};

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The code whose label this is, ignoring case and spacing; null when it is no code's label. */
function codeForLabel<T extends string>(labels: Record<T, string>, label: string): T | null {
  const wanted = label.replace(/\s+/g, " ").trim().toLowerCase();
  for (const [code, candidateLabel] of Object.entries(labels) as Array<[T, string]>) {
    if (candidateLabel.replace(/\s+/g, " ").trim().toLowerCase() === wanted) return code;
    if (code.toLowerCase() === wanted) return code;
  }
  return null;
}

/** Every answer already on the candidate, as the conversation's own columns. */
export function sessionPrefillFromCandidate(row: ResumeCandidateRow): ResumePrefill {
  const family = text(row.declared_role_family);
  const background = text(row.declared_background);
  const backgroundCode = background ? codeForLabel(candidateBackgroundLabels, background) : null;
  const experience = text(row.declared_experience);
  const experienceCode = experience ? codeForLabel(candidateExperienceLabels, experience) : null;
  const regionCode = text(row.preferred_region_code);

  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.screening_extra_answers ?? {})) {
    const answer = text(value);
    if (answer) extras[key] = answer;
  }

  return {
    area_name: text(row.preferred_area_name),
    area_other_text: null,
    background: backgroundCode ?? (background ? "other" : null),
    background_other_text: backgroundCode ? null : background,
    // Kept raw when it is no band's label: answered, and never written back (see the header).
    experience: experienceCode ?? experience,
    expected_salary: text(row.declared_expected_salary) ?? text(row.expected_salary),
    extra_answers: extras,
    job_title_family: family,
    job_title_other_text: family === "other" ? text(row.applied_for_job_title) : null,
    region_code: regionCode,
    region_other_text: regionCode ? null : text(row.preferred_region_name),
  };
}

/** The built-in questions these columns hold an answer to. */
export function prefilledBuiltInKeys(columns: {
  job_title_family: string | null;
  background: string | null;
  background_other_text: string | null;
  region_code: string | null;
  region_other_text: string | null;
  area_name: string | null;
  area_other_text: string | null;
  experience: string | null;
  expected_salary: string | null;
}): Set<BuiltInQuestionKey> {
  const keys = new Set<BuiltInQuestionKey>();
  if (columns.job_title_family) keys.add("job_title");
  if (columns.background || columns.background_other_text) keys.add("background");
  if (columns.region_code || columns.region_other_text) keys.add("region");
  if (columns.area_name || columns.area_other_text) keys.add("area");
  if (columns.experience) keys.add("experience");
  if (columns.expected_salary) keys.add("salary");
  return keys;
}

/**
 * The first of the six this person is asked and has not answered, in the bot's own order and under
 * the same audiences — or null when every one that applies to them is answered.
 */
export function firstUnansweredBuiltIn(prefill: ResumePrefill, audiences: SavedAudiences): BuiltInQuestionKey | null {
  const answered = prefilledBuiltInKeys(prefill);
  if (!answered.has("job_title")) return "job_title";
  const hasRegion = answered.has("region");
  let after: BuiltInQuestionKey = "job_title";
  for (;;) {
    const next = nextBuiltInQuestion({ after, audiences, hasRegion, roleFamily: prefill.job_title_family });
    if (!next) return null;
    if (!answered.has(next)) return next;
    after = next;
  }
}
