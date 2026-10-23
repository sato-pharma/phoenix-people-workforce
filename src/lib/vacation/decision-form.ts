import { createHmac, timingSafeEqual } from "crypto";

import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

/**
 * The confirm-a-vacation-decision page (`/leave-management/vacation-decision/[id]`), the logic half.
 *
 * 🔴 A REFUSED DECISION COMES BACK TO THE FORM WITH A SENTENCE — NEVER THE OUTAGE SCREEN. The page's
 * Server Action called `decideVacationRequest` with no error handling, and the screen called the
 * rejection reason "recommended" while the service REQUIRES it. So a reject without a reason threw,
 * Next.js rendered its error boundary, and nothing was saved (technical audit 23 Oct 2026, P7-05).
 * Now the reason is `required` on the form, checked again here before the service is called, and
 * anything the service refuses returns to the same page with its message.
 *
 * Kept free of Next.js so the rules can be tested; the page does the redirecting.
 */

export const REJECTION_REASON_REQUIRED = "A rejection reason is required.";

// 🔴 NEVER "nothing was changed". An approval is several writes with no transaction around them
// (the approver's step, the paid-days call, the request row), so a failure part-way leaves the step
// recorded and the request open. A retry then reads "already has a final decision" or "not
// authorized", and the approver was told nothing had happened (risk review of #6295, 2026-10-23).
export const DECISION_FAILED =
  "The decision could not be completed. Part of it may already be recorded — check the request's status before trying again.";
const NOT_AUTHORIZED = "You are not authorized to decide this vacation request.";

// 🔴 THE PAGE SHOWS ONLY A SENTENCE THE SERVER WROTE. The refusal travels back in the address, so a
// crafted link could otherwise put any sentence of its own in a red alert on a trusted HR approval
// page (risk review of #6295). The message is signed with a key of its own, derived from
// PHOENIX_AUTH_SECRET under a fixed label, and bound to the request and the decision; anything that
// does not verify shows the fixed DECISION_FAILED sentence instead, never its own text.
const SIGNATURE_KEY_LABEL = "phoenix-vacation-decision-error-v1";

function signatureKey(): Buffer | null {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  return secret ? createHmac("sha256", secret).update(SIGNATURE_KEY_LABEL).digest() : null;
}

function signDecisionError(requestId: string, decision: string, message: string): string | null {
  const key = signatureKey();
  return key ? createHmac("sha256", key).update(`${requestId}\n${decision}\n${message}`).digest("base64url") : null;
}

/** What is wrong with the submitted form before it reaches the service, or null. */
export function vacationDecisionFormProblem(decision: string, comment: string): string | null {
  if (decision === "reject" && comment.trim() === "") return REJECTION_REASON_REQUIRED;
  return null;
}

/** The sentence a refused decision shows on the form — the service's own words, never Postgres's. */
export function vacationDecisionFailureMessage(error: unknown): string {
  const forbidden =
    (error instanceof ApiError && error.status === 403) ||
    (error instanceof Error && error.message.toLowerCase().startsWith("forbidden:"));
  if (forbidden) return NOT_AUTHORIZED;
  return clientSafeErrorMessage(error, DECISION_FAILED);
}

/** Back to the same confirmation page, on the same decision, carrying the message to show and its signature. */
export function vacationDecisionRetryPath(requestId: string, decision: string, message: string): string {
  // Trimmed and capped HERE, before signing, so the page verifies exactly the text it will show.
  const text = message.trim().slice(0, 300);
  const params = new URLSearchParams({ decision, decisionError: text });
  const signature = signDecisionError(requestId, decision, text);
  if (signature) params.set("decisionErrorSig", signature);
  return `/leave-management/vacation-decision/${encodeURIComponent(requestId)}?${params.toString()}`;
}

/**
 * The refusal sentence the page may show, or null when there is none. A message whose signature does
 * not match this request and decision — a crafted link, or a server with no signing secret — shows
 * the fixed DECISION_FAILED sentence, so the address can never choose the words on the page.
 */
export function vacationDecisionErrorToShow(
  requestId: string,
  decision: string,
  message: string | undefined,
  signature: string | undefined,
): string | null {
  const text = (message ?? "").trim();
  if (!text) return null;
  const expected = signDecisionError(requestId, decision, text);
  if (!expected || !signature) return DECISION_FAILED;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? text : DECISION_FAILED;
}
