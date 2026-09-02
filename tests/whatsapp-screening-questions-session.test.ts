import assert from "node:assert/strict";

import {
  decideNextExtraStep,
  nextActiveQuestion,
  type ScreeningQuestion,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * The pure step-transition decision behind the admin-defined extra-question loop — unit-testable
 * without a database, the same way askAreaForRole() is tested for the fixed six.
 *
 * The one property everything else here serves: a question is tracked by KEY, never by position, so
 * a reorder or a mid-flight deactivation self-heals on the applicant's very next reply instead of
 * stranding them on a question that no longer exists.
 */

function q(overrides: Partial<ScreeningQuestion> = {}): ScreeningQuestion {
  return {
    appliesToRoleFamilies: null,
    bodyText: "Do you already have a valid driving license?",
    id: "q-1",
    isActive: true,
    kind: "tappable",
    options: [
      { description: null, title: "Yes", value: "yes" },
      { description: null, title: "No", value: "no" },
    ],
    questionKey: "has_license",
    sortOrder: 1,
    ...overrides,
  };
}

export function runWhatsAppScreeningQuestionsSessionTests() {
  const license = q({ id: "q-1", questionKey: "has_license", sortOrder: 1 });
  const shift = q({
    id: "q-2",
    kind: "free_text",
    options: null,
    questionKey: "preferred_shift",
    sortOrder: 2,
  });
  const years = q({
    id: "q-3",
    kind: "free_text",
    options: null,
    questionKey: "years_driving",
    sortOrder: 3,
  });
  const list = [license, shift, years];

  // ── nextActiveQuestion ───────────────────────────────────────────────────────────────────────────
  assert.equal(nextActiveQuestion(list, new Set()), license, "the loop starts at the first active question");
  assert.equal(nextActiveQuestion(list, new Set(["has_license"])), shift);
  assert.equal(nextActiveQuestion(list, new Set(["has_license", "preferred_shift"])), years);
  assert.equal(
    nextActiveQuestion(list, new Set(["has_license", "preferred_shift", "years_driving"])),
    null,
    "every question answered means the loop is over",
  );
  assert.equal(nextActiveQuestion([], new Set()), null, "no questions configured means nothing to ask");

  // ── A tapped answer to a tappable question, mid-list ────────────────────────────────────────────
  const tapped = decideNextExtraStep({
    activeQuestions: list,
    answer: { kind: "tapped", value: "yes" },
    answeredKeysBeforeThis: new Set(),
    currentQuestion: license,
  });
  assert.deepEqual(tapped, { answerValue: "Yes", nextQuestion: shift, outcome: "advance" });

  // The stored answerValue is the option's TITLE (what a human reads back later), not its internal
  // row-id value.
  assert.notEqual((tapped as { answerValue: string }).answerValue, "yes");

  // ── A typed answer to a free-text question, finishing the loop ──────────────────────────────────
  const finished = decideNextExtraStep({
    activeQuestions: list,
    answer: { kind: "typed", text: "  3 years  " },
    answeredKeysBeforeThis: new Set(["has_license", "preferred_shift"]),
    currentQuestion: years,
  });
  assert.deepEqual(finished, { answerValue: "3 years", outcome: "finished" });

  // ── Kind narrowness: a tap against a free-text question, and text against a tappable one ────────
  assert.deepEqual(
    decideNextExtraStep({
      activeQuestions: list,
      answer: { kind: "tapped", value: "anything" },
      answeredKeysBeforeThis: new Set(),
      currentQuestion: shift,
    }),
    { outcome: "unknown_value" },
    "a tap against a free-text question makes no sense and must be rejected",
  );
  assert.deepEqual(
    decideNextExtraStep({
      activeQuestions: list,
      answer: { kind: "typed", text: "Yes please" },
      answeredKeysBeforeThis: new Set(),
      currentQuestion: license,
    }),
    { outcome: "unknown_value" },
    "typed text against a tappable question must be rejected — only its own options are valid answers",
  );

  // ── An unknown tapped value (stale menu, or a row from a since-changed question) ────────────────
  assert.deepEqual(
    decideNextExtraStep({
      activeQuestions: list,
      answer: { kind: "tapped", value: "not_an_option" },
      answeredKeysBeforeThis: new Set(),
      currentQuestion: license,
    }),
    { outcome: "unknown_value" },
  );

  // ── Unusable free text (blank after cleaning, or over the length cap) ───────────────────────────
  assert.deepEqual(
    decideNextExtraStep({
      activeQuestions: list,
      answer: { kind: "typed", text: "   " },
      answeredKeysBeforeThis: new Set(),
      currentQuestion: shift,
    }),
    { outcome: "unusable_text" },
  );
  assert.deepEqual(
    decideNextExtraStep({
      activeQuestions: list,
      answer: { kind: "typed", text: "x".repeat(201) },
      answeredKeysBeforeThis: new Set(),
      currentQuestion: shift,
    }),
    { outcome: "unusable_text" },
    "an answer over EXTRA_FREE_TEXT_ANSWER_MAX must be rejected the same way an unusable one is",
  );

  // ── THE REGRESSION TEST: a mid-list deactivation is skipped, not stranded on ────────────────────
  // The applicant already answered has_license. Between that reply and this one, the admin
  // deactivated "preferred_shift" — it is simply missing from the now-live active list. The
  // conversation must move straight to years_driving, not get stuck asking for a question that no
  // longer exists.
  const liveListAfterDeactivation = [license, years];
  const afterDeactivation = decideNextExtraStep({
    activeQuestions: liveListAfterDeactivation,
    answer: { kind: "tapped", value: "yes" },
    answeredKeysBeforeThis: new Set(),
    currentQuestion: license,
  });
  assert.deepEqual(afterDeactivation, { answerValue: "Yes", nextQuestion: years, outcome: "advance" });

  // ── A REORDER between two replies is also picked up correctly ──────────────────────────────────
  // years_driving now sorts before preferred_shift. Having just answered has_license, the applicant
  // must be asked years_driving next, not preferred_shift.
  const reordered = [license, years, shift];
  const afterReorder = decideNextExtraStep({
    activeQuestions: reordered,
    answer: { kind: "tapped", value: "yes" },
    answeredKeysBeforeThis: new Set(),
    currentQuestion: license,
  });
  assert.equal((afterReorder as { nextQuestion: ScreeningQuestion }).nextQuestion.questionKey, "years_driving");

  // ── A NEW question inserted between two replies is picked up too, not just skipped/reordered ────
  const withNewQuestion = [
    license,
    q({ id: "q-4", kind: "free_text", options: null, questionKey: "car_ownership", sortOrder: 2 }),
    shift,
    years,
  ];
  const afterInsert = decideNextExtraStep({
    activeQuestions: withNewQuestion,
    answer: { kind: "tapped", value: "yes" },
    answeredKeysBeforeThis: new Set(),
    currentQuestion: license,
  });
  assert.equal((afterInsert as { nextQuestion: ScreeningQuestion }).nextQuestion.questionKey, "car_ownership");

  // ── The completed answers bag, across a mixed tappable + free_text sequence ─────────────────────
  // decideNextExtraStep itself only returns one step at a time; this walks the whole sequence the
  // way the session module does, building up the answers bag exactly as applyPendingExtraAnswers /
  // finishExtraQuestionLoop would.
  const answers: Record<string, string> = {};
  let answeredKeys = new Set<string>();
  let current: ScreeningQuestion | null = license;
  const replies: Array<{ kind: "tapped"; value: string } | { kind: "typed"; text: string }> = [
    { kind: "tapped", value: "no" },
    { kind: "typed", text: "Evening" },
    { kind: "typed", text: "5" },
  ];
  for (const reply of replies) {
    if (!current) break;
    const step = decideNextExtraStep({
      activeQuestions: list,
      answer: reply,
      answeredKeysBeforeThis: answeredKeys,
      currentQuestion: current,
    });
    assert.ok(step.outcome === "advance" || step.outcome === "finished", `unexpected outcome ${step.outcome}`);
    answers[current.questionKey] = (step as { answerValue: string }).answerValue;
    answeredKeys = new Set(answeredKeys).add(current.questionKey);
    current = step.outcome === "advance" ? step.nextQuestion : null;
  }
  assert.deepEqual(answers, { has_license: "No", preferred_shift: "Evening", years_driving: "5" });
  assert.equal(current, null, "the loop must terminate after the last active question");
}
