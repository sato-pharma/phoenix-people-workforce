// The spend ceiling on the paid AI read of CVs that arrive through the public careers form.
//
// WHY (23 Oct 2026 audit, P5-02). POST /api/public/apply is open to anyone. Its CV goes through the
// model read before anything checks whether the applicant is new, so a script that gets past the
// per-address limit (10 an hour) and the reCAPTCHA can still turn every post into a paid model call.
// This caps the MODEL calls from that one channel per rolling day, across all senders. Past the ceiling
// nothing is lost: the CV is still captured and read the free way (the rule engine, then OCR), exactly
// as when the model is down; a recruiter or a later re-read can ask the model afterwards.
//
// THE NUMBER IS A PROPOSAL, NOT A DECISION. 100 model reads a day is roughly ten times the careers
// form's realistic daily volume and, at the measured cost of a nano-tier read (~$0.004), about $0.40 a
// day at most. Change PUBLIC_APPLY_AI_READS_PER_DAY if the owner names another figure.
//
// Only the public careers form uses this. Email, WhatsApp and recruiter uploads are not gated.

import { ApiRateLimitError, assertApiRateLimit } from "@/lib/security/api-rate-limit";
import { logError } from "@/lib/observability/log";

export const PUBLIC_APPLY_AI_READS_PER_DAY = 100;
export const PUBLIC_APPLY_AI_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One counter for the whole channel — the ceiling is on spend, not on any one sender. */
const BUDGET_IDENTIFIER = "public-apply-ai-reads";
const BUDGET_SCOPE = "ai_spend_public_apply";

/**
 * Builds the gate `extractCvFieldsFromBytes` asks before a model call. `consume` spends one unit or
 * throws: ApiRateLimitError past the ceiling, anything else when the counter cannot be read. BOTH
 * answer "no model" — a ceiling that cannot be checked is not a ceiling, and the CV is still read
 * for free. Injectable so the tests need no database.
 */
export function createPublicApplyAiBudget(consume: () => Promise<void>): () => Promise<boolean> {
  return async () => {
    try {
      await consume();
      return true;
    } catch (error) {
      logError(
        error instanceof ApiRateLimitError
          ? "Public apply AI ceiling reached — this CV is read without the model"
          : "Public apply AI ceiling could not be checked — this CV is read without the model",
        {
          error: error instanceof ApiRateLimitError ? undefined : error,
          labels: {
            event: error instanceof ApiRateLimitError ? "public_apply_ai_ceiling_reached" : "public_apply_ai_ceiling_unreadable",
          },
        },
      );
      return false;
    }
  };
}

export const consumePublicApplyAiRead = createPublicApplyAiBudget(() =>
  assertApiRateLimit({
    identifier: BUDGET_IDENTIFIER,
    limit: PUBLIC_APPLY_AI_READS_PER_DAY,
    scope: BUDGET_SCOPE,
    windowMs: PUBLIC_APPLY_AI_WINDOW_MS,
  }),
);
