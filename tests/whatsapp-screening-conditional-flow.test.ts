import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decideNextExtraStep,
  nextActiveQuestion,
  questionIsVisible,
  screeningQuestionViolations,
  type ScreeningQuestion,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * The HR Section Head flow: questions that depend on an earlier answer (`showIf`) and an answer that
 * ends the conversation with its own message (`endOn`).
 *
 * The rule under test, in the owner's words: a candidate who is not based in Cairo is thanked and told
 * why, and asked nothing more; a candidate with pharma experience is asked two follow-ups and one
 * without is not. The questions below are the same shape as the rows the migration seeds.
 */

const yesNo = [
  { description: null, title: "Yes", value: "yes" },
  { description: null, title: "No", value: "no" },
];

const STOP_MESSAGE = "Thank you for your interest in Sato Pharma. This role is based at our Cairo office.";

function q(overrides: Partial<ScreeningQuestion> & { questionKey: string }): ScreeningQuestion {
  return {
    appliesToRoleFamilies: ["hr_section_head"],
    bodyText: `Question ${overrides.questionKey}?`,
    endOn: null,
    id: overrides.questionKey,
    isActive: true,
    kind: "tappable",
    options: yesNo,
    showIf: null,
    sortOrder: 1,
    ...overrides,
  };
}

const cairo = q({ endOn: { message: STOP_MESSAGE, values: ["no"] }, questionKey: "hrsh_cairo" });
const residence = q({ questionKey: "hrsh_residence", showIf: { questionKey: "hrsh_cairo", values: ["yes"] } });
const age = q({ questionKey: "hrsh_age" });
const pharma = q({ questionKey: "hrsh_pharma" });
const medrep = q({ questionKey: "hrsh_medrep", showIf: { questionKey: "hrsh_pharma", values: ["yes"] } });
const ats = q({ questionKey: "hrsh_ats", showIf: { questionKey: "hrsh_pharma", values: ["yes"] } });
const salary = q({ bodyText: "Current salary?", kind: "free_text", options: null, questionKey: "hrsh_salary" });
const start = q({ questionKey: "hrsh_start" });
const flow = [cairo, residence, age, pharma, medrep, ats, salary, start];

function tap(
  current: ScreeningQuestion,
  value: string,
  answers: Record<string, string>,
) {
  return decideNextExtraStep({
    activeQuestions: flow,
    answer: { kind: "tapped", value },
    answeredKeysBeforeThis: new Set(Object.keys(answers)),
    answersBeforeThis: answers,
    currentQuestion: current,
  });
}

export function runWhatsAppScreeningConditionalFlowTests() {
  // ── visibility ─────────────────────────────────────────────────────────────────────────────────
  assert.equal(questionIsVisible(age, {}, flow), true, "a question with no rule is always shown");
  assert.equal(
    questionIsVisible(residence, {}, flow),
    false,
    "a follow-up is NOT shown to someone who never answered the question it depends on",
  );
  assert.equal(questionIsVisible(residence, { hrsh_cairo: "Yes" }, flow), true);
  assert.equal(questionIsVisible(residence, { hrsh_cairo: "No" }, flow), false);
  assert.equal(
    questionIsVisible(residence, { hrsh_cairo: "Some title nobody offered" }, flow),
    false,
    "an answer matching no option reads as not shown — the safe direction",
  );
  // The rule is written in option CODES, so retitling an answer on the screen must not break it.
  const retitled = q({
    options: [
      { description: null, title: "Yes, I live in Cairo", value: "yes" },
      { description: null, title: "No", value: "no" },
    ],
    questionKey: "hrsh_cairo",
  });
  assert.equal(
    questionIsVisible(residence, { hrsh_cairo: "Yes, I live in Cairo" }, [retitled, residence]),
    true,
    "the rule follows the option code, not its wording",
  );

  // ── the Cairo answer: Yes continues to residence, No ends it ───────────────────────────────────
  const cairoYes = tap(cairo, "yes", {});
  assert.equal(cairoYes.outcome, "advance");
  assert.equal(cairoYes.outcome === "advance" && cairoYes.nextQuestion.questionKey, "hrsh_residence");

  const cairoNo = tap(cairo, "no", {});
  assert.equal(cairoNo.outcome, "ended", "THE HEADLINE: a non-Cairo applicant's conversation ENDS on that answer");
  assert.equal(cairoNo.outcome === "ended" && cairoNo.message, STOP_MESSAGE, "and the owner's message is what is sent");
  assert.equal(cairoNo.outcome === "ended" && cairoNo.answerValue, "No", "the answer is still recorded");

  // Residence answered -> age (not skipped past)
  const afterResidence = tap(residence, "yes", { hrsh_cairo: "Yes" });
  assert.equal(afterResidence.outcome === "advance" && afterResidence.nextQuestion.questionKey, "hrsh_age");

  // ── pharma: Yes asks both follow-ups, No skips both ────────────────────────────────────────────
  const base = { hrsh_age: "Yes", hrsh_cairo: "Yes", hrsh_residence: "Yes" };
  const pharmaYes = tap(pharma, "yes", base);
  assert.equal(pharmaYes.outcome === "advance" && pharmaYes.nextQuestion.questionKey, "hrsh_medrep");
  const afterMedrep = tap(medrep, "yes", { ...base, hrsh_pharma: "Yes" });
  assert.equal(afterMedrep.outcome === "advance" && afterMedrep.nextQuestion.questionKey, "hrsh_ats");
  const afterAts = tap(ats, "yes", { ...base, hrsh_medrep: "Yes", hrsh_pharma: "Yes" });
  assert.equal(afterAts.outcome === "advance" && afterAts.nextQuestion.questionKey, "hrsh_salary");

  const pharmaNo = tap(pharma, "no", base);
  assert.equal(
    pharmaNo.outcome === "advance" && pharmaNo.nextQuestion.questionKey,
    "hrsh_salary",
    "an applicant with no pharma experience skips BOTH follow-ups and goes straight to salary",
  );

  // ── the very first question can never be a conditional one ─────────────────────────────────────
  assert.equal(nextActiveQuestion(flow, new Set())?.questionKey, "hrsh_cairo");
  assert.equal(
    nextActiveQuestion([residence, age], new Set())?.questionKey,
    "hrsh_age",
    "a conditional question is skipped when nothing has been answered yet",
  );
  assert.equal(
    nextActiveQuestion([residence], new Set()),
    null,
    "a list holding only conditional questions asks nothing",
  );

  // ── an answer that is not in the end rule does not end it ──────────────────────────────────────
  const unknown = tap(cairo, "maybe", {});
  assert.equal(unknown.outcome, "unknown_value");

  // ── validation ─────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(screeningQuestionViolations(cairo), [], "the seeded Cairo question is valid");
  assert.deepEqual(screeningQuestionViolations(residence), [], "the seeded residence question is valid");
  assert.ok(
    screeningQuestionViolations({ ...residence, showIf: { questionKey: "hrsh_residence", values: ["yes"] } }).some(
      (problem) => problem.includes("its own answer"),
    ),
    "a question cannot wait for its own answer",
  );
  assert.ok(
    screeningQuestionViolations({ ...residence, showIf: { questionKey: "hrsh_cairo", values: [] } }).length > 0,
    "a show-if rule needs at least one answer",
  );
  assert.ok(
    screeningQuestionViolations({ ...cairo, endOn: { message: "  ", values: ["no"] } }).length > 0,
    "an ending with no words would send an empty message",
  );
  assert.ok(
    screeningQuestionViolations({ ...cairo, endOn: { message: STOP_MESSAGE, values: ["perhaps"] } }).some((problem) =>
      problem.includes("not one of this question's answers"),
    ),
    "an end rule must name answers the question actually offers",
  );
  assert.ok(
    screeningQuestionViolations({ ...salary, endOn: { message: STOP_MESSAGE, values: ["no"] } }).some((problem) =>
      problem.includes("only a tappable question"),
    ),
    "a typed question has no answer code to end on",
  );

  // ── wiring: the loop must hand the ending message to the finish flow, and pass answers along ──
  const session = readFileSync("src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts", "utf8");
  assert.ok(
    session.includes('decision.outcome === "ended" ? decision.message : undefined'),
    "the extra-question loop must send an ending answer's own message instead of the closing summary",
  );
  assert.equal(
    (session.match(/answersBeforeThis: session\.extra_answers/g) ?? []).length,
    2,
    "both the tapped and the typed reply paths must pass the answers so far, or a follow-up is never shown",
  );
  assert.ok(
    session.includes("show_if,end_on"),
    "the question list must be read WITH its show_if and end_on columns or the rules never reach the bot",
  );
  const classify = readFileSync("src/lib/recruitment/inbound/whatsapp-classify-session.ts", "utf8");
  assert.ok(
    classify.includes("options?.closingText"),
    "finishSession must send the ending message when it is given one, and the usual summary otherwise",
  );
}
