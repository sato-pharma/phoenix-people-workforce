import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { logWarning } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Push the owner's live Google Sheet the moment a direct order changes (spec D5e).
//
// WHY A WEBHOOK AND NOT THE SHEETS API
// The original D5e called for a Google service-account key. Google's own
// `iam.disableServiceAccountKeyCreation` org policy blocks creating one, and it is right to:
// long-lived JSON keys leak. Turning that policy off across the organisation to save under a
// minute of latency is a bad trade.
//
// The sheet's own Apps Script is already deployed as a Web App, running as the sheet's owner. So
// Phoenix simply POSTs to it. No GCP project, no service account, no key, no org policy — and no
// credential in this repo. The URL and the shared secret live in Railway env only.
//
// CORRECTNESS NEVER DEPENDS ON THIS.
// The sheet re-pulls the feed every 60 seconds on its own timer, and once an hour from 23:00 to
// 08:00 Cairo (NIGHT PACING in docs/direct-orders-live-sheet.gs). A ping that fails, times out, or
// is not configured at all costs at most one minute of freshness by day and an hour overnight. That
// is why every failure here is swallowed: a spreadsheet refresh must never be able to fail a
// payroll-adjacent mutation.
//
// A TIMEOUT HERE IS NOT A FAILURE, AND THE REAL FAILURES USED TO BE SILENT (2 Nov 2026).
// doPost answers only after it has read the feed and redrawn every tab, so Phoenix hangs up while
// the script carries on to the end. That morning 44 order changes gave 44 timeouts, and between
// 11:18 and 11:30 Cairo the sheet read its feed 42 times: 12 timer ticks, plus one read for each of
// the 30 changes in that stretch. Meanwhile a refusal is an HTTP 200 reading "denied" or "not
// configured", and a crashed script answers a 200 error page, and nothing read the answer. So the
// warning fired on every ping that worked and on none that was turned away.
// Account: docs/share-link-management.md, "A sheet ping that times out was delivered".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long Phoenix stays on the line. The secret is checked before the script reads anything, so a
 * refusal usually answers inside this; a refresh never does, and finishes after Phoenix hangs up.
 */
const PING_TIMEOUT_MS = 4000;

/** What doPost answers once it has refreshed. Its two refusals are HTTP 200 as well. */
const REFRESH_DONE_ANSWER = "ok";
const REFUSAL_ANSWERS = new Set(["denied", "not configured"]);

/**
 * Tell the sheet something changed. Fire-and-forget.
 *
 * Deliberately NOT awaited by callers and deliberately never throws — see the note above. Returns
 * void rather than a promise so a caller cannot accidentally make an order's success depend on a
 * spreadsheet being reachable.
 */
export function pingDirectOrderSheet(reason: string): void {
  const url = process.env.SHEET_REFRESH_WEBHOOK_URL?.trim();
  const secret = process.env.SHEET_REFRESH_WEBHOOK_SECRET?.trim();
  // Customer 360 reads requests and orders too; refresh it first, whether or not the sheet is wired.
  bumpCustomer360Cache("direct order changed");
  // Not configured is a normal state, not an error: the sheet still refreshes on its own timer.
  if (!url || !secret) return;

  void (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The secret travels in the BODY, never the query string, where it would be written to
        // browser history, referrer headers and proxy logs while looking protected.
        body: JSON.stringify({ secret, reason }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        // Apps Script answers a Web App POST with a 302 to googleusercontent; following it is
        // required to reach the actual handler.
        redirect: "follow",
      });
      if (!response.ok) {
        // WARNING, not ERROR: the sheet is a convenience surface and its own timer still refreshes
        // it. Paging someone because a spreadsheet was slow would train them to ignore the channel.
        // The status is logged; the URL and the secret never are.
        logWarning("Direct Orders sheet refresh ping failed (non-fatal — the sheet still self-refreshes)", {
          labels: { event: "direct_order_sheet_ping_failed", reason, status: String(response.status) },
        });
        return;
      }
      const answer = (await response.text()).trim();
      if (answer !== REFRESH_DONE_ANSWER) {
        // Named from a fixed list and never logged as sent: an unexpected answer can be a whole page.
        logWarning("Direct Orders sheet refused the refresh ping (non-fatal — the sheet still self-refreshes)", {
          labels: {
            answer: REFUSAL_ANSWERS.has(answer) ? answer : "unexpected",
            event: "direct_order_sheet_ping_refused",
            reason,
          },
        });
      }
    } catch (error) {
      // Phoenix stopped waiting; the script did not stop running. See the note at the top.
      if (error instanceof Error && error.name === "TimeoutError") return;
      logWarning("Direct Orders sheet refresh ping failed (non-fatal — the sheet still self-refreshes)", {
        labels: { event: "direct_order_sheet_ping_failed", reason },
        error,
      });
    }
  })();
}
