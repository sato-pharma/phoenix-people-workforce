import assert from "node:assert/strict";

import { menuViolations, parseClassifyRowId } from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  buildExtraQuestionMenu,
  extraQuestionRowId,
  isValidQuestionKey,
  parseExtraQuestionRowId,
  screeningQuestionViolations,
  type ScreeningQuestionContent,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * The pure half of the admin-configurable screening questions: row-id namespacing (never collides
 * with the fixed six's own row ids) and the Meta-limit validator the admin save path and the send
 * path both run — literally the same `menuViolations`, not a second copy that could drift.
 */

function question(overrides: Partial<ScreeningQuestionContent> = {}): ScreeningQuestionContent {
  return {
    bodyText: "Do you already have a valid driving license?",
    kind: "tappable",
    options: [
      { description: null, title: "Yes", value: "yes" },
      { description: null, title: "No", value: "no" },
    ],
    questionKey: "has_license",
    ...overrides,
  };
}

export function runWhatsAppScreeningQuestionsMenuTests() {
  // ── Row-id namespace: the two families must never collide ──────────────────────────────────────
  const extraId = extraQuestionRowId("has_license", "yes");
  assert.equal(extraId, "phx:extra:has_license:yes");
  assert.deepEqual(parseExtraQuestionRowId(extraId), { questionKey: "has_license", value: "yes" });
  // The fixed six's own parser must refuse an extra-question id (4 parts, "extra" is not a step).
  assert.equal(
    parseClassifyRowId(extraId),
    null,
    "an admin-defined question's row id must never be readable as one of the fixed six's",
  );

  const classifyId = "phx:region:GZ";
  assert.equal(
    parseExtraQuestionRowId(classifyId),
    null,
    "one of the fixed six's row ids must never be readable as an admin-defined question's",
  );

  assert.equal(parseExtraQuestionRowId("not:ours:at:all:extra:long"), null);
  assert.equal(parseExtraQuestionRowId(null), null);
  assert.equal(parseExtraQuestionRowId(undefined), null);
  assert.equal(parseExtraQuestionRowId(""), null);
  // A questionKey or value that is itself blank must not round-trip into a usable id.
  assert.equal(parseExtraQuestionRowId("phx:extra: :yes"), null);
  assert.equal(parseExtraQuestionRowId("phx:extra:has_license: "), null);

  // ── Question key format ─────────────────────────────────────────────────────────────────────────
  assert.equal(isValidQuestionKey("has_license"), true);
  assert.equal(isValidQuestionKey("q_2"), true);
  assert.equal(isValidQuestionKey(""), false);
  assert.equal(isValidQuestionKey("2_has_license"), false, "must start with a letter");
  assert.equal(isValidQuestionKey("Has_License"), false, "lowercase only");
  assert.equal(isValidQuestionKey("has license"), false, "no spaces");
  assert.equal(isValidQuestionKey("has:license"), false, "no colons — row-id namespace safety");

  // ── buildExtraQuestionMenu ───────────────────────────────────────────────────────────────────────
  const menu = buildExtraQuestionMenu(question());
  assert.equal(menu.step, "extra");
  assert.equal(menu.body, "Do you already have a valid driving license?");
  assert.deepEqual(
    menu.rows.map((row) => row.id),
    ["phx:extra:has_license:yes", "phx:extra:has_license:no"],
  );
  // Existing fixed-six menu builders must still pass menuViolations([]) unchanged — a drift guard on
  // the ClassifyMenu.step widening from ClassifyStep to ClassifyStep | "extra".
  assert.deepEqual(menuViolations(menu), []);

  // ── screeningQuestionViolations — reuses the real menuViolations, does not reimplement it ────────
  assert.deepEqual(screeningQuestionViolations(question()), [], "a well-formed question has no violations");

  // Bad question key.
  assert.ok(
    screeningQuestionViolations(question({ questionKey: "Has License" })).some((problem) =>
      /question key must be/.test(problem),
    ),
  );

  // Empty / over-length body text.
  assert.ok(screeningQuestionViolations(question({ bodyText: "" })).some((p) => /question text is empty/.test(p)));
  assert.ok(
    screeningQuestionViolations(question({ bodyText: "x".repeat(1025) })).some((p) => /over the 1024 limit/.test(p)),
  );

  // A tappable question needs at least one option.
  assert.ok(
    screeningQuestionViolations(question({ options: [] })).some((p) => /needs at least one option/.test(p)),
  );

  // More than 10 options — WhatsApp's own list cap, caught via the real menuViolations reuse too.
  const tooManyOptions = Array.from({ length: 11 }, (_, index) => ({
    description: null,
    title: `Option ${index}`,
    value: `option_${index}`,
  }));
  const tooManyProblems = screeningQuestionViolations(question({ options: tooManyOptions }));
  assert.ok(tooManyProblems.some((p) => /exceeds WhatsApp's 10-row limit/.test(p)));

  // Duplicate option values, and a value carrying a ":" (row-id namespace safety).
  const dupeProblems = screeningQuestionViolations(
    question({
      options: [
        { description: null, title: "Yes", value: "same" },
        { description: null, title: "No", value: "same" },
      ],
    }),
  );
  assert.ok(dupeProblems.some((p) => /duplicate option value/.test(p)));

  const colonProblems = screeningQuestionViolations(
    question({ options: [{ description: null, title: "Yes", value: "yes:no" }] }),
  );
  assert.ok(colonProblems.some((p) => /cannot contain ":"/.test(p)));

  // An over-length option title/description — caught via the real menuViolations reuse, not a
  // second length check that could disagree with what actually gets sent.
  const overLengthTitle = screeningQuestionViolations(
    question({ options: [{ description: null, title: "x".repeat(25), value: "opt" }] }),
  );
  assert.ok(overLengthTitle.some((p) => /over 24/.test(p)));

  const overLengthDescription = screeningQuestionViolations(
    question({ options: [{ description: "x".repeat(73), title: "Yes", value: "opt" }] }),
  );
  assert.ok(overLengthDescription.some((p) => /over 72/.test(p)));

  // free_text: no options allowed, and options are never checked against the row-cap or menu rules.
  assert.deepEqual(
    screeningQuestionViolations({ ...question(), kind: "free_text", options: null }),
    [],
    "a well-formed free-text question has no violations",
  );
  assert.ok(
    screeningQuestionViolations({ ...question(), kind: "free_text" }).some((p) =>
      /must not carry tappable options/.test(p),
    ),
    "a free-text question carrying leftover options from a kind switch must be rejected",
  );
}
