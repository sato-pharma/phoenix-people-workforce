/**
 * One Google Routes failure, as a sentence a person can read.
 *
 * Until 2026-09-28 `googleDirectionsRoute` threw `Google Routes API failed with 400: <the first 240
 * characters of the response body>`, and `service.ts` stored that message as an outstation
 * request's eligibility reason. Reviewers read raw JSON on the card, and every export copied it.
 *
 * The SOURCE now throws this sentence (the raw body goes to the server log, where it belongs), and
 * the READING side (`outstation/eligibility-reason.ts`) rewrites the rows stored before the fix with
 * the same function — so a row written before the fix and one written after read identically for
 * the same fault. Pure and client-safe.
 */

/** Google's own message out of a JSON error body, or null. Tolerates a truncated body. */
export function googleErrorMessage(body: string | null | undefined): string | null {
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(body ?? ""));
  return match ? match[1].replace(/\\"/g, '"').trim() || null : null;
}

export function describeRoutesFailure(status: number | null, body: string | null | undefined): string {
  const message = googleErrorMessage(body);
  if (message && /coordinates must not be \(0,\s*0\)/i.test(message)) {
    return "No home coordinate was on file when this request was filed, so Google could not measure a route from it.";
  }
  if (message) {
    return `Google could not measure a driving route for this request (${message.replace(/\.$/, "")}).`;
  }
  return status
    ? `Google could not measure a driving route for this request (it answered ${status}).`
    : "Google could not measure a driving route for this request.";
}
