import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { logWarning } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Push the owner's live Marketing Request Google Sheet the moment a request changes.
//
// WHY A WEBHOOK AND NOT THE SHEETS API
// Same reasoning as the Direct Orders equivalent: the Sheets API wants a service-account key, and
// Google's own `iam.disableServiceAccountKeyCreation` org policy blocks creating one — correctly,
// because long-lived JSON keys leak. The sheet's own Apps Script is already deployed as a Web App
// running as the sheet's owner, so Phoenix simply POSTs to it. No GCP project, no service account,
// no key, and no credential in this repo. The URL and the shared secret live in Railway env only.
//
// CORRECTNESS NEVER DEPENDS ON THIS.
// The sheet re-pulls the feed on its own 60-second timer, and once an hour from 23:00 to 08:00
// Cairo (NIGHT PACING in docs/marketing-request-live-sheet.gs). A ping that fails, times out, or is
// not configured at all costs at most one minute of freshness by day and an hour overnight. That is
// why every failure here is swallowed: a spreadsheet refresh must never be able to fail an approval
// or a payment.
//
// A SEPARATE SECRET FROM THE DIRECT ORDERS SHEET. Two different spreadsheets, two different
// audiences; sharing one secret would mean revoking either one breaks both.
//
// A TIMEOUT HERE IS NOT A FAILURE, AND THE REAL FAILURES USED TO BE SILENT (2 Nov 2026).
// Same as the Direct Orders ping: doPost answers only after it has read the feed and redrawn, so
// Phoenix hangs up while the script carries on to the end. All four of this ping's warnings on 1 Nov
// were timeouts, and the sheet read its feed off its timer within seconds of each ping. Meanwhile a
// refusal is an HTTP 200 reading "denied" or "not configured", a crashed script answers a 200 error
// page, and nothing read the answer.
// Account: docs/share-link-management.md, "A sheet ping that times out was delivered".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long Phoenix stays on the line. The secret is checked before the script reads anything, so a
 * refusal usually answers inside this; a refresh rarely does, and finishes after Phoenix hangs up.
 */
const PING_TIMEOUT_MS = 4000;

/** What doPost answers once it has refreshed. Its two refusals are HTTP 200 as well. */
const REFRESH_DONE_ANSWER = "ok";
const REFUSAL_ANSWERS = new Set(["denied", "not configured"]);

/**
 * Tell the sheet something changed. Fire-and-forget.
 *
 * Deliberately NOT awaited by callers and deliberately never throws — see the note above. Returns
 * void rather than a promise so a caller cannot accidentally make a request's success depend on a
 * spreadsheet being reachable.
 */
export function pingMarketingRequestSheet(reason: string): void {
  const url = process.env.MARKETING_SHEET_REFRESH_WEBHOOK_URL?.trim();
  const secret = process.env.MARKETING_SHEET_REFRESH_WEBHOOK_SECRET?.trim();
  // Customer 360 reads requests and orders too; refresh it first, whether or not the sheet is wired.
  bumpCustomer360Cache("marketing request changed");
  // Not configured is a normal state, not an error: the sheet still refreshes on its own timer.
  if (!url || !secret) return;

  void (async () => {
    try {
      const response = await fetch(url, {
        // The secret travels in the BODY, never the query string, where it would be written to
        // browser history, referrer headers and proxy logs while looking protected.
        body: JSON.stringify({ reason, secret }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        // Apps Script answers a Web App POST with a 302 to googleusercontent; following it is
        // required to reach the actual handler.
        redirect: "follow",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!response.ok) {
        // WARNING, not ERROR: the sheet is a convenience surface and its own timer still refreshes
        // it. Paging someone because a spreadsheet was slow would train them to ignore the channel.
        // The status is logged; the URL and the secret never are.
        logWarning("Marketing sheet refresh ping failed (non-fatal — the sheet still self-refreshes)", {
          labels: { event: "marketing_sheet_ping_failed", reason, status: String(response.status) },
        });
        return;
      }
      const answer = (await response.text()).trim();
      if (answer !== REFRESH_DONE_ANSWER) {
        // Named from a fixed list and never logged as sent: an unexpected answer can be a whole page.
        logWarning("Marketing sheet refused the refresh ping (non-fatal — the sheet still self-refreshes)", {
          labels: {
            answer: REFUSAL_ANSWERS.has(answer) ? answer : "unexpected",
            event: "marketing_sheet_ping_refused",
            reason,
          },
        });
      }
    } catch (error) {
      // Phoenix stopped waiting; the script did not stop running. See the note at the top.
      if (error instanceof Error && error.name === "TimeoutError") return;
      logWarning("Marketing sheet refresh ping failed (non-fatal — the sheet still self-refreshes)", {
        error,
        labels: { event: "marketing_sheet_ping_failed", reason },
      });
    }
  })();
}
