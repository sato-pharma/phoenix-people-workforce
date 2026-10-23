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

const DECISION_FAILED = "The decision could not be saved. Nothing was changed — please try again.";
const NOT_AUTHORIZED = "You are not authorized to decide this vacation request.";

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

/** Back to the same confirmation page, on the same decision, carrying the message to show. */
export function vacationDecisionRetryPath(requestId: string, decision: string, message: string): string {
  const params = new URLSearchParams({ decision, decisionError: message });
  return `/leave-management/vacation-decision/${encodeURIComponent(requestId)}?${params.toString()}`;
}
