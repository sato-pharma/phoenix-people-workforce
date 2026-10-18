// Recruitment / ATS — editing, or filling in, one of a candidate's WhatsApp answers from the pool.
//
// The owner, 2026-10-19, right after the pool's headers became the bot's questions: "make me able to
// edit or add a missing field and full control". Asked what that meant, he chose both: click any
// answer cell to change it or type in a missing one, and choose which question columns show.
//
// ONE ANSWER PER SAVE, WRITTEN TO THE SAME COLUMN THE BOT WRITES. So the edit shows on every screen
// that reads the answer — the pool, the profile panel, the workstation, WhatsApp Applicants, the
// printed record — and none of them needs to know an edit happened. An empty value CLEARS the
// answer; there is no other way to say "remove it", and nothing is left half-cleared.
//
// WHAT AN EDIT DOES NOT DO. It never stamps `preferences_declared_at`: that stamp says the APPLICANT
// answered the bot, and a recruiter's typing must not make the record claim it. A typed "What are you
// applying for?" therefore reaches the record as an entered title (the applied-for ladder's "stated"
// rung), which is what it is. The region keeps the bot's two shapes: a company region's name becomes
// its code, exactly as a tap would; anything else is kept as typed words.
//
// Gated on `candidates: update` — Super Admin and Talent Acquisition, the same grant as every other
// change to a candidate's record from the pool. The route asserts it; the audit row is the registry's.
//
// PURE — the rules alone, so the route can refuse a bad edit and the tests can pin every rule without
// loading the database client. The write is whatsapp-answer-edit.ts.

import { candidateRegionCodes, candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";

/** The six built-in questions a recruiter may edit — every one of them. */
export const editableBuiltInAnswerKeys = ["job_title", "background", "region", "area", "experience", "salary"] as const;
export type EditableBuiltInAnswerKey = (typeof editableBuiltInAnswerKeys)[number];

/** Long enough for any answer the bot has stored; short enough that a paste of a CV is refused. */
export const WHATSAPP_ANSWER_MAX_CHARS = 400;

/** An admin question's key, as the Screening Questions screen mints them. */
const EXTRA_QUESTION_KEY = /^[a-z][a-z0-9_]{0,62}$/;

export type WhatsAppAnswerEdit =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string };

function regionCodeFor(value: string): CandidateRegionCode | null {
  const folded = value.trim().toLowerCase();
  for (const code of candidateRegionCodes) {
    if (code.toLowerCase() === folded || candidateRegionLabels[code].toLowerCase() === folded) return code;
  }
  return null;
}

/**
 * The column update for one edited answer. PURE, so every rule here is tested without a database.
 *
 * `key` is `candidateWhatsAppAnswers`'s key — a built-in step's name, or `extra:<question key>`.
 * `existingExtra` is the record's current `screening_extra_answers`; an admin question's answer is
 * merged into it, never written over the others.
 */
export function whatsAppAnswerEditPayload(
  key: string,
  rawValue: unknown,
  existingExtra: Record<string, unknown> | null | undefined,
): WhatsAppAnswerEdit {
  if (rawValue !== null && rawValue !== undefined && typeof rawValue !== "string") {
    return { message: "An answer is text.", ok: false };
  }
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (value.length > WHATSAPP_ANSWER_MAX_CHARS) {
    return { message: `Keep an answer under ${WHATSAPP_ANSWER_MAX_CHARS} characters.`, ok: false };
  }
  const answer = value.length > 0 ? value : null;

  switch (key) {
    case "job_title":
      return { ok: true, payload: { applied_for_job_title: answer } };
    case "background":
      return { ok: true, payload: { declared_background: answer } };
    case "area":
      return { ok: true, payload: { preferred_area_name: answer } };
    case "experience":
      return { ok: true, payload: { declared_experience: answer } };
    case "salary":
      return { ok: true, payload: { declared_expected_salary: answer } };
    case "region": {
      const code = answer ? regionCodeFor(answer) : null;
      return {
        ok: true,
        payload: { preferred_region_code: code, preferred_region_name: code ? null : answer },
      };
    }
    default:
      break;
  }

  if (!key.startsWith("extra:")) return { message: "That is not one of the WhatsApp questions.", ok: false };
  const questionKey = key.slice("extra:".length);
  if (!EXTRA_QUESTION_KEY.test(questionKey)) return { message: "That is not one of the WhatsApp questions.", ok: false };
  const merged: Record<string, unknown> = { ...(existingExtra ?? {}) };
  if (answer === null) delete merged[questionKey];
  else merged[questionKey] = answer;
  return { ok: true, payload: { screening_extra_answers: merged } };
}
