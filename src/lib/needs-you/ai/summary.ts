/**
 * Tier 2 — the one written sentence in front of the board, and the rules that make it impossible
 * for it to reassure.
 *
 * WHAT TIER 2 IS FOR. Tier 1 answers "what is waiting on you" as a list. This turns the top of that
 * list into a sentence a tired person can read at 06:36 — "the oldest thing waiting is the Anti
 * Infective closing, six days now". It is phrasing and ordering. It is never a fact.
 *
 * 🔴 THE MODEL IS NEVER ON THE DELIVERY PATH FOR FACTS. The delivered message is ALWAYS the
 * deterministic render. What this file produces is a PREFIX STRING and nothing else — look at
 * {@link SummaryVerdict}: it cannot express a board, an item, or a count. There is no code path in
 * which a model output replaces or suppresses a fact, because there is no shape for one. That is
 * deliberate, and it is stronger than any amount of prompt discipline.
 *
 * Three independent structural facts make a calm summary impossible, any ONE of which suffices:
 *
 *   1. The verdict type cannot carry data (above).
 *   2. The model is never invoked when a source failed — {@link attachableSummary} refuses before
 *      the network call, so a day with an unreadable source never spends a token AND the
 *      reassuring sentence cannot exist to be shown.
 *   3. The model never SEES the verdict. {@link buildSummaryPrompt} passes only the waiting items.
 *      It is given no count of failures and no all-clear flag, so it has no vocabulary with which
 *      to tell him everything is fine.
 *
 * 🔴 AND WHEN THE SUMMARY IS DROPPED, THE DIGEST SAYS SO. Every rejection returns a `because`, and
 * the caller prints it. This is the 2026-09-02 lesson: a masked OPENAI_API_KEY made every AI
 * feature fail silently, because each call site degraded politely to "no suggestions", and it was
 * invisible for days until a human read an error off a screen. A tier 2 that degraded silently
 * would repeat that — and on this module it would also break the one rule the whole thing exists
 * for, since a missing summary would be indistinguishable from a quiet morning.
 *
 * WHY IT DECLARES ITS OWN INPUT TYPE. {@link SummaryBoardFacts} is minimal and owned here rather
 * than imported from the board's model, which is being built in parallel. Same reason as
 * `render/telegram.ts`: a consumer that reaches into a type someone else is still shaping either
 * blocks on it or duplicates it. The seam is one mapping function on the caller's side, and
 * everything below is pure — no clock, no network, no database.
 */

/** Recorded on the telemetry row so a cost question can be answered per purpose. */
export const NEEDS_YOU_SUMMARY_PURPOSE = "needs_you_daily_summary";

/** A lead longer than this is not a lead. Telegram's whole budget is 900 characters. */
export const SUMMARY_MAX_CHARS = 220;

/**
 * The one line that carries the word the Responses API demands — see {@link buildSummaryPrompt}.
 *
 * Named rather than inlined so the regression test asserts the WORD is in the input, which is what
 * OpenAI actually checks, rather than matching a sentence someone may reword.
 */
export const SUMMARY_JSON_WORD = "Reply with a json object.";

/** The minimal facts tier 2 needs. Note what is ABSENT: any verdict, and any failure count. */
export type SummaryBoardFacts = {
  /** The items waiting on him, in the board's own order. */
  items: readonly { name: string; reason: string }[];
  /**
   * How many sources could not be read. Used ONLY to refuse — it is never sent to the model, so
   * the model cannot mention it and cannot reason from its absence either.
   */
  notProvenCount: number;
};

export type SummaryVerdict =
  | { lead: string; order: number[]; because?: undefined }
  | { lead: null; order?: undefined; because: string };

/**
 * What the model is asked, and the only thing it is shown.
 *
 * It receives the waiting items and nothing else. It is asked for ordering and phrasing, and
 * forbidden — in words, though the real enforcement is {@link attachableSummary} — from adding an
 * item, removing one, stating a count, or saying that anything is complete.
 */
export function buildSummaryPrompt(facts: SummaryBoardFacts): { instructions: string; input: string } {
  const instructions = [
    "You are given a list of things waiting on one person's decision.",
    'Return JSON: { "lead": string, "order": number[] }.',
    '"lead" is at most two sentences naming the single most blocking item BY NAME.',
    '"order" is a permutation of the input indices, most blocking first.',
    "You may not add an item, remove an item, state a count, or say that anything is complete,",
    "fine, clear, calm, handled, or that nothing needs attention.",
    'If you cannot do this, return { "lead": "", "order": [] }.',
  ].join("\n");

  // Only `yours`. No notProvenCount, no verdict, no totals.
  const payload = JSON.stringify({
    items: facts.items.map((item, index) => ({ index, name: item.name, reason: item.reason })),
  });

  // 🔴 THE WORD "json" MUST APPEAR IN THE INPUT, NOT ONLY IN THE INSTRUCTIONS. The Responses API
  // refuses `text.format: { type: "json_object" }` with a 400 unless the INPUT messages contain
  // the word in some form — the `instructions` field does not satisfy it, however many times it
  // says JSON. Measured in production: every run since the feature shipped on 2026-09-28 returned
  // `400 Response input messages must contain the word 'json' in some form to use 'text.format'
  // of type 'json_object'.` in about a second, so tier 2 never produced a single summary — three
  // mornings of the digest printing the dropped-summary notice instead of a lead.
  //
  // It says nothing the model was not already told: no count, no verdict, no lane. The line below
  // is the whole fix, and {@link SUMMARY_JSON_WORD} exists so the test can name it.
  const input = `${SUMMARY_JSON_WORD}\n${payload}`;

  return { instructions, input };
}

/** Words that claim completeness. The model does not get to judge this; the board does. */
const COMPLETENESS_CLAIM = /\b(all clear|nothing|no items|nothing else|up to date|up-to-date|clear|calm|handled|fine|complete|completed|done|sorted|covered)\b/i;

function isPermutationOf(order: unknown, length: number): order is number[] {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set<number>();
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= length || seen.has(value as number)) return false;
    seen.add(value as number);
  }
  return true;
}

/**
 * Decide whether a model answer may be attached, and say why not when it may not.
 *
 * `raw` is whatever came back — a parsed object, a JSON string, null, anything. Every path that is
 * not unambiguously good returns `{ lead: null, because }`.
 */
export function attachableSummary(facts: SummaryBoardFacts, raw: unknown): SummaryVerdict {
  // 1. A day with an unreadable source never gets a written summary, full stop. This is checked
  //    FIRST and is also checked before the network call, so such a day spends no tokens either.
  if (facts.notProvenCount > 0) {
    return { lead: null, because: "a source could not be read, so no summary was attempted" };
  }

  // 2. Nothing waiting means there is nothing to lead with. This is the case where a fabricated
  //    reassurance would do the most damage, and it is the case the model never sees.
  if (facts.items.length === 0) {
    return { lead: null, because: "nothing is waiting, so there is nothing to lead with" };
  }

  let answer: { lead?: unknown; order?: unknown } | null = null;
  if (typeof raw === "string") {
    try {
      answer = JSON.parse(raw) as { lead?: unknown; order?: unknown };
    } catch {
      answer = null;
    }
  } else if (raw && typeof raw === "object") {
    answer = raw as { lead?: unknown; order?: unknown };
  }

  if (!answer || typeof answer.lead !== "string") {
    return { lead: null, because: "the model's answer did not fit the shape" };
  }

  const lead = answer.lead.trim();
  if (!lead) return { lead: null, because: "the model returned no lead" };

  // 3. An `order` that is not a permutation is how a model silently DROPS an item — an omission
  //    this module would then present as the whole list. Reject the answer rather than the order:
  //    a lead written about a reordering that was refused is a lead about a list he is not seeing.
  if (!isPermutationOf(answer.order, facts.items.length)) {
    return { lead: null, because: "the model's ordering did not cover every item exactly once" };
  }

  // 4. Completeness is the board's verdict, never the model's.
  if (COMPLETENESS_CLAIM.test(lead)) {
    return { lead: null, because: "the summary claimed completeness, which is not the model's to judge" };
  }

  // 5. Any number in the lead must be one the board actually holds. A hallucinated count reads as
  //    fact and is the most quietly wrong thing a summary can contain.
  const allowed = new Set<string>([String(facts.items.length)]);
  for (const item of facts.items) {
    for (const digits of `${item.name} ${item.reason}`.match(/\d+/g) ?? []) allowed.add(digits);
  }
  for (const digits of lead.match(/\d+/g) ?? []) {
    if (!allowed.has(digits)) {
      return { lead: null, because: `the summary stated a number the board does not hold (${digits})` };
    }
  }

  // 6. House rules that apply to anything this repository prints.
  if (/…|\.\.\./.test(lead)) {
    return { lead: null, because: "the summary used an ellipsis" };
  }
  if (lead.length > SUMMARY_MAX_CHARS) {
    return { lead: null, because: `the summary ran to ${lead.length} characters, past the ${SUMMARY_MAX_CHARS} allowed` };
  }

  return { lead, order: answer.order };
}

/**
 * The sentence the digest prints when a summary was dropped for any reason OTHER than there being
 * nothing to say. Exported so the caller cannot phrase it a second way, and so a test can assert
 * the digest contains it.
 */
export function summaryDroppedNotice(because: string, readAtCairo: string): string {
  return `The written summary could not be produced (${because}). The list below is complete and was read at ${readAtCairo}.`;
}
