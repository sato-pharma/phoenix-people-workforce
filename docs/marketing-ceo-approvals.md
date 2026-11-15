# CEO Approvals: the period, the sender's own mailbox, and the exports

The rules are in `.claude/rules/marketing.md` ("The module's surfaces"). The pins are
`tests/marketing-ceo-approvals.test.ts`, `tests/marketing-ceo-approvals-email.test.ts` and
`tests/marketing-ceo-approvals-export.test.ts`. This file records why each part is the way it is.

## The period follows the dates; a switch adds earlier unpaid approvals (owner, 2026-11-15)

On 8 Nov 2026 the owner asked for every period to also list each earlier CEO approval Finance had
not paid yet. He said "never narrow it back to the approval date". Dr Hossam's "Approved requests
8th Nov to 15th Nov" then held 12 rows, though only 3 were approved in those dates.

On 15 Nov 2026 the owner said: "the filter is not following the periods I chose". Asked to choose,
he picked "Dates only, switch for rest". This replaces the 8 Nov rule:

- By default the list holds only requests whose `ceo_approval` rung was approved between From and To
  (Cairo days). The service does not read earlier approvals at all.
- The switch "Also list earlier approvals Finance has not paid yet" puts `carry=1` in the address
  bar (`CEO_APPROVALS_CARRY_PARAM`, read by `resolveCeoApprovalsCarry`). With it on, the earlier
  approvals still waiting for Finance or on Finance hold come back. The "Listed as" column then
  appears on screen, in the email's rows and in both exports. It is hidden while the switch is off,
  because then every row is the period's own.
- The email request and the export request both carry `carry`. The server reads the rows again with
  the same switch, so neither can include a request the screen did not show.

## The email goes from the sender's own mailbox (owner, 2026-11-15)

The owner asked that, when the email is sent from Dr Hossam's account, it goes from
hossam.reda@satopharma.com. Asked how the password should be set up, he picked "His own My email":
the sender connects their own mailbox once, under the envelope at the top of Phoenix → My email,
and pastes their own Turbify app password there. Nobody else types it for them.

- `personalMailboxSendable(access)` reports whether the sender's My email connection can send. It
  never throws.
- When it can, `sendPersonalMailboxHtmlEmail` sends the same To, Cc, subject and HTML through the
  sender's own SMTP. A copy is filed in their Sent folder (best effort).
- When it cannot, the email goes the old way, "<name> via Phoenix". The preview names the From
  address and says to connect My email before "Send now" is pressed.
- A failed own-mailbox send is reported to the sender. It is never retried through Phoenix, because
  a second copy from another address would confuse Finance. The same request repeated within 10
  minutes is refused.
- The audit log records which route was used (`sentFrom`). Never test-send this email: it reaches
  Finance, the requesters' managers and the directors.

## The ticked rows export as XLSX and PDF (owner, 2026-11-15)

He asked: "I want to be able to export selected in a very premium polished XLSX and PDF".

- The Export XLSX and Export PDF buttons appear while any row is ticked. They post the ticked ids
  (with any note typed beside them) to `POST /api/marketing-requests/ceo-approvals/export`.
- The route checks the request comes from the same site and applies the export rate limit. It reads
  the period's rows again on the server and keeps only ticked ids that are in the period, in screen
  order. Every export writes an audit row. It answers 503 when Chromium cannot run, so a PDF never
  comes back half-made.
- Both files use the house identity (SATO-DIS-2026-01 v1.0) and follow the ink rule. Each has:
  - the four headline figures (selected, total value, executed by Finance, not yet executed);
  - the ruled table with zebra rows;
  - a total row (in the XLSX a live `SUM` formula), a frozen header and a filter in the XLSX;
  - an A4 landscape page with "Page X of Y" in the PDF.
- A "Note" column appears only when a note was typed. A "Listed as" column appears only with the
  switch on.
