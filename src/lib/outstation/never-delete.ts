/**
 * 🔴 An expense request is never deleted (owner, 24 Nov 2026, about 00:05 Cairo: "never delete any expense
 * request. If rejected, keep them as rejected, but never delete.").
 *
 * The two admin DELETE routes answer this refusal, the System Cleanup Center no longer lists expense
 * requests, and the database trigger `phx_outstation_requests_never_deleted` refuses a DELETE or TRUNCATE on
 * `outstation_expense_requests` whatever the caller. A request that should not be paid is rejected, and the
 * rejected request stays on the record.
 */

export const OUTSTATION_REQUEST_NEVER_DELETED_CODE = "requests_are_never_deleted";

export const OUTSTATION_REQUEST_NEVER_DELETED =
  "An expense request is never deleted. Reject it instead: a rejected request stays on the record as rejected.";

/** The body every DELETE on an expense request answers, with HTTP 405. */
export function outstationRequestNeverDeletedBody() {
  return {
    error: OUTSTATION_REQUEST_NEVER_DELETED_CODE,
    message: OUTSTATION_REQUEST_NEVER_DELETED,
    success: false as const,
  };
}
