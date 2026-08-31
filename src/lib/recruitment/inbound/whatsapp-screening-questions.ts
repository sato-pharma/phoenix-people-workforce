// Recruitment / ATS — Super-Admin-defined extra screening questions, asked after the fixed six.
//
// The fixed six (role, background, region, area, experience, salary — whatsapp-classify-menus.ts)
// stay hardcoded on purpose: their vocabularies are read far beyond this bot. This module is the
// SEPARATE, generic path for whatever the owner wants to ask next, defined entirely through the
// admin screen at /admin/screening-questions — no code change, no deploy, ever again.
//
// PURE — no I/O — same split as whatsapp-classify-menus.ts vs whatsapp-classify-session.ts, so the
// admin UI can call `screeningQuestionViolations` for live feedback without a network round trip,
// and so the step-transition logic (`decideNextExtraStep`) is unit-testable without a database.

import type { ClassifyMenu } from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import {
  cleanTypedAnswer,
  menuViolations,
  WHATSAPP_BODY_MAX,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";

export type ScreeningQuestionKind = "tappable" | "free_text";

export type ScreeningQuestionOption = {
  /** Row-id namespace safety: must never contain ":" — checked by screeningQuestionViolations. */
  value: string;
  title: string;
  description: string | null;
};

/** The fields that decide what gets asked and how — shared by a persisted row and a draft being
 *  validated before it is saved. */
export type ScreeningQuestionContent = {
  questionKey: string;
  bodyText: string;
  kind: ScreeningQuestionKind;
  /** Non-null (1-10 elements) iff kind is "tappable". Null for "free_text". */
  options: ScreeningQuestionOption[] | null;
};

/** A persisted question, as read from the database. */
export type ScreeningQuestion = ScreeningQuestionContent & {
  id: string;
  sortOrder: number;
  isActive: boolean;
};

/** An answer typed to a free-text question. Generous relative to EXPECTED_SALARY_MAX (60) because
 *  an admin-defined question is not guaranteed to be asking for a short figure. */
export const EXTRA_FREE_TEXT_ANSWER_MAX = 200;

export function cleanExtraAnswerText(raw: string | null | undefined): string | null {
  return cleanTypedAnswer(raw, EXTRA_FREE_TEXT_ANSWER_MAX);
}

/** Same shape as salaryTooLongText/jobTitleOtherTooLongText: names the limit, quotes nothing back. */
export function extraAnswerTooLongText(): string {
  return [
    "That looks a little long for an answer.",
    "",
    `Please send something shorter — up to ${EXTRA_FREE_TEXT_ANSWER_MAX} characters.`,
  ].join("\n");
}

// ── Row ids ──────────────────────────────────────────────────────────────────────────────────────
// `phx:extra:<questionKey>:<value>` — four parts, so parseClassifyRowId (which requires exactly
// three) always returns null on one of these, and this parser always returns null on one of the
// fixed six's three-part ids. The two namespaces cannot collide; pinned in
// whatsapp-screening-questions-menu.test.ts.
const EXTRA_ID_PREFIX = "phx";
const EXTRA_ID_SEGMENT = "extra";

export function extraQuestionRowId(questionKey: string, optionValue: string): string {
  return `${EXTRA_ID_PREFIX}:${EXTRA_ID_SEGMENT}:${questionKey}:${optionValue}`;
}

export type ParsedExtraQuestionRowId = { questionKey: string; value: string };

/** Reads one of our row ids back, or null for anything we did not send. Never throws. */
export function parseExtraQuestionRowId(raw: string | null | undefined): ParsedExtraQuestionRowId | null {
  const parts = String(raw ?? "").split(":");
  if (parts.length !== 4) return null;
  const [prefix, segment, questionKey, value] = parts;
  if (prefix !== EXTRA_ID_PREFIX || segment !== EXTRA_ID_SEGMENT) return null;
  if (!questionKey.trim() || !value.trim()) return null;
  return { questionKey, value };
}

const QUESTION_KEY_FORMAT = /^[a-z][a-z0-9_]{1,62}$/;

export function isValidQuestionKey(key: string): boolean {
  return QUESTION_KEY_FORMAT.test(key);
}

/** Builds the interactive-list menu for a tappable question. Callers must not call this for a
 *  free_text question — there is nothing to tap, so it is sent as plain text instead
 *  (see whatsapp-screening-questions-session.ts). */
export function buildExtraQuestionMenu(question: ScreeningQuestionContent): ClassifyMenu {
  const options = question.options ?? [];
  return {
    body: question.bodyText,
    buttonLabel: "Choose an option",
    rows: options.map((option) => ({
      description: option.description ?? undefined,
      id: extraQuestionRowId(question.questionKey, option.value),
      title: option.title,
    })),
    sectionTitle: "Options",
    // Widened on ClassifyMenu.step so this real menu can reuse menuViolations and sendClassifyMenu
    // verbatim — the same send-time defense the fixed six get, with no new send-side code.
    step: "extra",
  };
}

/**
 * The Meta-limit + shape validator, run at admin save time. For a tappable question this builds the
 * real menu and calls the SAME menuViolations() the fixed six are checked against and every send
 * goes through — literal reuse, not a second implementation that could drift from what actually gets
 * sent. Everything else here is a check menuViolations cannot make on its own (the key format, and
 * option-value uniqueness/row-id safety).
 */
export function screeningQuestionViolations(question: ScreeningQuestionContent): string[] {
  const problems: string[] = [];
  const label = question.questionKey || "(new question)";

  if (!isValidQuestionKey(question.questionKey)) {
    problems.push(`${label}: question key must be lowercase letters, digits and underscores, starting with a letter`);
  }
  if (!question.bodyText.trim()) problems.push(`${label}: the question text is empty`);
  if (question.bodyText.length > WHATSAPP_BODY_MAX) {
    problems.push(`${label}: the question text is ${question.bodyText.length} characters, over the ${WHATSAPP_BODY_MAX} limit`);
  }

  if (question.kind === "free_text") {
    if (question.options && question.options.length > 0) {
      problems.push(`${label}: a free-text question must not carry tappable options`);
    }
    return problems;
  }

  const options = question.options ?? [];
  if (options.length === 0) {
    problems.push(`${label}: a tappable question needs at least one option`);
    return problems;
  }
  if (options.length > 10) {
    problems.push(`${label}: ${options.length} options exceeds WhatsApp's 10-row limit`);
  }

  const seenValues = new Set<string>();
  for (const option of options) {
    if (!option.value.trim()) problems.push(`${label}: an option has no value`);
    if (option.value.includes(":")) problems.push(`${label}: option value "${option.value}" cannot contain ":"`);
    if (seenValues.has(option.value)) problems.push(`${label}: duplicate option value "${option.value}"`);
    seenValues.add(option.value);
  }

  // Reuse the real send-time validator via the real menu builder — see the function comment above.
  problems.push(...menuViolations(buildExtraQuestionMenu(question)));

  return problems;
}

// ── The pure step-transition decision ───────────────────────────────────────────────────────────

export type ExtraAnswerOutcome =
  | { outcome: "unknown_value" }
  | { outcome: "unusable_text" }
  | { outcome: "advance"; answerValue: string; nextQuestion: ScreeningQuestion }
  | { outcome: "finished"; answerValue: string };

/**
 * The next active question the applicant has not already answered, in the live list's own order.
 *
 * Deliberately keyed on "have I collected an answer for this key" rather than a stored position
 * index — a question inserted, reordered or deactivated between two of this applicant's replies is
 * therefore picked up (or skipped) correctly on the very next step, with nothing to migrate and
 * nothing that can strand a conversation on a question that no longer exists.
 */
export function nextActiveQuestion(
  activeQuestions: readonly ScreeningQuestion[],
  answeredKeys: ReadonlySet<string>,
): ScreeningQuestion | null {
  return activeQuestions.find((question) => !answeredKeys.has(question.questionKey)) ?? null;
}

/**
 * Validates one reply against the question the applicant was just asked, and decides what happens
 * next: advance to another active question, or finish the loop. `answeredKeysBeforeThis` must NOT
 * include `currentQuestion.questionKey` — this function adds it before computing what comes next.
 */
export function decideNextExtraStep(input: {
  currentQuestion: ScreeningQuestion;
  activeQuestions: readonly ScreeningQuestion[];
  answeredKeysBeforeThis: ReadonlySet<string>;
  answer: { kind: "tapped"; value: string } | { kind: "typed"; text: string };
}): ExtraAnswerOutcome {
  const { currentQuestion, activeQuestions, answeredKeysBeforeThis, answer } = input;

  let answerValue: string;
  if (currentQuestion.kind === "tappable") {
    if (answer.kind !== "tapped") return { outcome: "unknown_value" };
    const option = (currentQuestion.options ?? []).find((candidate) => candidate.value === answer.value);
    if (!option) return { outcome: "unknown_value" };
    answerValue = option.title;
  } else {
    if (answer.kind !== "typed") return { outcome: "unknown_value" };
    const cleaned = cleanExtraAnswerText(answer.text);
    if (!cleaned) return { outcome: "unusable_text" };
    answerValue = cleaned;
  }

  const answeredKeys = new Set(answeredKeysBeforeThis);
  answeredKeys.add(currentQuestion.questionKey);
  const next = nextActiveQuestion(activeQuestions, answeredKeys);
  if (next) return { answerValue, nextQuestion: next, outcome: "advance" };
  return { answerValue, outcome: "finished" };
}
