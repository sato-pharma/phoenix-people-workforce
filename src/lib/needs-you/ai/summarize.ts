/**
 * Tier 2, the impure half: the one model call a day, and the decision not to make it.
 *
 * `summary.ts` beside this file is entirely pure — the prompt, and the six refusals that decide
 * whether an answer may be attached. This file is the only part that touches the network, and it is
 * deliberately thin: it refuses, it calls, it hands the raw answer straight to `attachableSummary`,
 * and it never interprets anything itself.
 *
 * 🔴 THE MODEL IS gpt-5.4, NOT THE NANO DEFAULT, AND THAT IS THE CHEAP CHOICE. One call a day is
 * roughly 1,200 input + 300 output tokens: about $2.75 a year against $0.23 for nano. The whole
 * spread is $2.52, so cheapness here is bought by the CADENCE, not by the model — and a weak model
 * writing the first sentence he reads each morning is a poor trade for a quarter of a cent a day.
 * There is deliberately NO nano→premium ladder: it would save $2.52 a year in exchange for a second
 * prompt to keep in step with this one.
 *
 * 🔴 THE TIMEOUT IS PASSED EXPLICITLY. `createOpenAiResponseText` defaults to
 * OPENAI_EMAIL_TIMEOUT_MS (25s), which its own comment records as calibrated for the fast nano tier
 * — a gpt-5.4 call routinely exceeds it, and that already cost one real timeout on the email
 * assist in July. This is a cron job with no one waiting, so it gets the route budget.
 *
 * 🔴 AND IT NEVER THROWS. A digest that fails because its optional garnish failed is worse than a
 * digest with no garnish. Every arm returns a verdict, and every refusal carries a reason the
 * digest prints — silent degradation is what hid the masked-key defect for days on 2026-09-02.
 */
import { OPENAI_ROUTE_BUDGET_MS, createOpenAiResponseText, hasAiApiKey } from "@/lib/ai/openai-client";
import { logStructured } from "@/lib/observability/log";

import {
  NEEDS_YOU_SUMMARY_PURPOSE,
  attachableSummary,
  buildSummaryPrompt,
  type SummaryBoardFacts,
  type SummaryVerdict,
} from "./summary";
import type { NeedsYouBoard } from "../types";

/** gpt-5.4, named here rather than imported from the copilot's constant — a model choice that moves for the payroll copilot must not silently move this one too. */
export const NEEDS_YOU_SUMMARY_MODEL = "gpt-5.4";

/** The board, reduced to the only facts tier 2 is allowed to see. */
export function summaryFactsFrom(board: NeedsYouBoard): SummaryBoardFacts {
  return {
    items: board.yours.map((item) => ({ name: item.label, reason: item.note ?? item.label })),
    notProvenCount: board.notProven.length,
  };
}

/**
 * Produce the lead, or say why there is none.
 *
 * 🔴 THE TWO REFUSALS THAT COST NOTHING ARE CHECKED BEFORE THE CALL. `attachableSummary` refuses an
 * unreadable-source day and an empty day anyway, but checking here as well is what makes those days
 * spend no tokens — and, more importantly, means the model is never even SHOWN a board it could
 * reassure about. The pure function is the guarantee; this is the economy.
 */
export async function summarizeNeedsYouBoard(board: NeedsYouBoard): Promise<SummaryVerdict> {
  const facts = summaryFactsFrom(board);

  // Cheap refusals first — no key, no tokens, no network.
  if (facts.notProvenCount > 0 || facts.items.length === 0) {
    return attachableSummary(facts, null);
  }
  if (!hasAiApiKey()) {
    return { lead: null, because: "the AI account is not configured on this runtime" };
  }

  const { instructions, input } = buildSummaryPrompt(facts);

  let raw: unknown = null;
  try {
    const result = await createOpenAiResponseText({
      component: "needs_you_summary",
      input,
      instructions,
      // A lead and an ordering. The ceiling is generous against the 220 characters that survive
      // `attachableSummary`, because a truncated answer is an unparseable one, and an unparseable
      // answer costs the whole summary rather than a few words of it.
      maxOutputTokens: 800,
      model: NEEDS_YOU_SUMMARY_MODEL,
      purpose: NEEDS_YOU_SUMMARY_PURPOSE,
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    // `createOpenAiResponseText` returns { model, outputText, requestId }. `outputText` is the
    // JSON string the model produced; `attachableSummary` parses it and refuses anything that is
    // not unambiguously good, so nothing here inspects it.
    raw = result.outputText;
  } catch (error) {
    logStructured("WARNING", "Needs You summary could not be produced", {
      labels: { event: "needs_you_summary_failed", purpose: NEEDS_YOU_SUMMARY_PURPOSE },
      error,
    });
    // The reason is printed in the digest, so it stays short and free of anything unbounded.
    const message = String((error as Error | undefined)?.message ?? "").split("\n")[0].trim();
    return { lead: null, because: message ? `the AI call failed — ${message}` : "the AI call failed" };
  }

  // Everything from here is the pure function's decision, not this file's.
  return attachableSummary(facts, raw);
}
