// The "Approved requests" email (owner, 2026-11-08): the Marketing Manager sends ONE shared email from
// CEO Approvals (To: Finance, Cc: the requesters, their managers, Dr Anwar and Omar Anwar), and each of
// those people also gets the same notice in the app and on Telegram.
//
// The Telegram-failure fallback re-sends a failed Telegram notice as ["email", "in_app", "push"]. For
// anyone who never linked Telegram that is every time, and it would mail them a second copy of the
// email they already hold. Both channels it adds are redundant here, so the whole fallback is skipped —
// the same shape as closingPublishBlocksTelegramFallback.

export const APPROVED_REQUESTS_EMAIL_MODULE = "marketing_requests";
export const APPROVED_REQUESTS_EMAIL_EVENT = "approved_requests_sent";

/** Whether a FAILED Telegram delivery may be covered by the email/in-app/push re-send. False for this notice. */
export function approvedRequestsBlocksTelegramFallback(module: string | null | undefined, eventType?: string | null): boolean {
  return (
    String(module ?? "").trim().toLowerCase() === APPROVED_REQUESTS_EMAIL_MODULE &&
    String(eventType ?? "").trim().toLowerCase() === APPROVED_REQUESTS_EMAIL_EVENT
  );
}
