import assert from "node:assert/strict";

import {
  SUMMARY_MAX_CHARS,
  attachableSummary,
  buildSummaryPrompt,
  summaryDroppedNotice,
  type SummaryBoardFacts,
} from "../src/lib/needs-you/ai/summary.ts";

/**
 * Tier 2 may phrase and order. It may never reassure, never count, and never quietly drop an item.
 *
 * WHY THIS EXISTS. The board is the surface the owner trusts so he can stop checking a dozen screens
 * himself. Putting a model sentence at the top of it introduces the one failure that surface cannot
 * survive: a fluent, confident line saying everything is handled, on a morning when it is not.
 *
 * The defence is structural rather than prompted — the model never sees the verdict, is never called
 * on a day a source failed, and returns a PREFIX STRING whose type cannot carry a board. These
 * assertions pin those properties, plus the four ways a plausible answer is still refused.
 *
 * Every rejection also carries a `because` that the digest prints. That is the 2026-09-02 lesson: a
 * masked API key made every AI feature fail silently because each call site degraded politely to
 * "no suggestions", and it stayed invisible for days. Here a silent degradation would be worse
 * still — a missing summary would look exactly like a quiet morning.
 */
export function runNeedsYouSummaryGuardTests() {
  const facts = (over: Partial<SummaryBoardFacts> = {}): SummaryBoardFacts => ({
    items: [
      { name: "Anti Infective — August closing", reason: "not published, 6 days" },
      { name: "Contract renewal — Mona Adel", reason: "expires in 12 days" },
      { name: "Outstation claim — 3 held", reason: "awaiting your decision" },
    ],
    notProvenCount: 0,
    ...over,
  });

  const good = { lead: "The Anti Infective closing has been unpublished for 6 days.", order: [0, 1, 2] };

  // ── 0. A good answer IS attached — a guard that refuses everything is not a guard ──
  const ok = attachableSummary(facts(), good);
  assert.equal(ok.lead, good.lead, "a well-formed answer must be usable, or tier 2 is dead weight");
  assert.deepEqual(ok.order, [0, 1, 2]);
  // Structural: the verdict cannot carry facts. There is no field a model could populate with a
  // board, an item or a count — which is what makes "the model is never on the delivery path" true
  // by construction rather than by discipline.
  assert.deepEqual(
    Object.keys(ok).sort(),
    ["lead", "order"],
    "SummaryVerdict must expose nothing but a lead and an ordering — any data-carrying field would " +
      "create a path where a model output replaces a fact",
  );

  // ── 1. A day with an unreadable source gets NO written summary, whatever the model said ──
  const blind = attachableSummary(facts({ notProvenCount: 1 }), good);
  assert.equal(
    blind.lead,
    null,
    "a source could not be read and the model still got to write the opening line. That is the calm " +
      "sentence on the morning something was waiting — the single failure this module exists to prevent.",
  );
  assert.match(blind.because ?? "", /could not be read/);

  // ── 2. Completeness is the board's verdict, never the model's ──────────────
  for (const claim of [
    "All clear this morning.",
    "Nothing needs your attention today.",
    "Everything is handled.",
    "You are up to date.",
    "The queue is complete.",
  ]) {
    const verdict = attachableSummary(facts(), { lead: claim, order: [0, 1, 2] });
    assert.equal(verdict.lead, null, `"${claim}" was attached. The model does not get to declare completeness.`);
    assert.match(verdict.because ?? "", /completeness/);
  }

  // ── 3. A number the board does not hold is a hallucinated fact ─────────────
  const invented = attachableSummary(facts(), { lead: "You have 47 decisions waiting.", order: [0, 1, 2] });
  assert.equal(invented.lead, null, "a fabricated count reads as fact and is the quietest way to be wrong");
  assert.match(invented.because ?? "", /number the board does not hold \(47\)/);

  // Numbers that ARE on the board pass — the item count, and any figure inside an item.
  const real = attachableSummary(facts(), { lead: "3 things are waiting; the closing is 6 days old.", order: [0, 1, 2] });
  assert.equal(real.lead, "3 things are waiting; the closing is 6 days old.", "the board's own numbers are fine");

  // ── 4. An ordering that drops an item is refused ───────────────────────────
  // This is how a model omits something silently: the lead reads fine and the list it describes is
  // shorter than the one he was owed.
  for (const order of [[0, 1], [0, 1, 1], [0, 1, 3], [0, 1, 2, 2], "nope", null, undefined]) {
    const verdict = attachableSummary(facts(), { lead: "The closing is oldest.", order });
    assert.equal(verdict.lead, null, `order ${JSON.stringify(order)} was accepted — it does not cover every item once`);
    assert.match(verdict.because ?? "", /ordering/);
  }

  // ── 5. Shape failures, and house rules ─────────────────────────────────────
  for (const raw of [null, undefined, "not json at all", 42, {}, { lead: 7, order: [0, 1, 2] }]) {
    const verdict = attachableSummary(facts(), raw);
    assert.equal(verdict.lead, null, `${JSON.stringify(raw)} was accepted`);
    assert.ok((verdict.because ?? "").length > 0, "every refusal names its reason");
  }
  // A JSON STRING is accepted and parsed — the Responses API hands text back.
  assert.equal(attachableSummary(facts(), JSON.stringify(good)).lead, good.lead);

  assert.equal(attachableSummary(facts(), { lead: "The closing is oldest…", order: [0, 1, 2] }).lead, null);
  assert.match(
    attachableSummary(facts(), { lead: "The closing is oldest...", order: [0, 1, 2] }).because ?? "",
    /ellipsis/,
    "no ellipsis — AGENTS.md §4",
  );
  const tooLong = attachableSummary(facts(), { lead: "x".repeat(SUMMARY_MAX_CHARS + 1), order: [0, 1, 2] });
  assert.equal(tooLong.lead, null);
  assert.match(tooLong.because ?? "", /past the 220 allowed/);

  // ── 6. The model is never given the vocabulary to reassure ─────────────────
  const prompt = buildSummaryPrompt(facts({ notProvenCount: 2 }));
  assert.doesNotMatch(
    prompt.input,
    /notProven|allClear|verdict/i,
    "the prompt input carries the board's failure count or its verdict. The model must not know a " +
      "source failed, nor that the board considers itself clear — give it those words and it will " +
      "eventually use them.",
  );
  assert.match(prompt.input, /Anti Infective/, "it does receive the items, which is all it needs");
  assert.doesNotMatch(prompt.input, /"count"|"total"/i, "and no totals to echo back as a count");
  assert.match(prompt.instructions, /may not add an item, remove an item, state a count/i);

  // ── 7. A dropped summary is VISIBLE, not silent ────────────────────────────
  const notice = summaryDroppedNotice("the model timed out", "06:38 Cairo");
  assert.match(notice, /could not be produced/);
  assert.match(notice, /the model timed out/, "the reason travels to the screen");
  assert.match(notice, /list below is complete/, "and it says the FACTS are still whole, which they are");
  assert.match(notice, /06:38 Cairo/);

  // The one case that needs no notice: nothing was waiting, so there was nothing to lead with.
  const empty = attachableSummary(facts({ items: [] }), good);
  assert.equal(empty.lead, null);
  assert.match(empty.because ?? "", /nothing is waiting/);
}
