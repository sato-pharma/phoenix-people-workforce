---
name: turbify-cannot-issue-app-passwords-centrally-owner-stays
description: "Turbify issues app passwords ONLY from inside each mailbox — there is no API, Phoenix never could create them, and the owner decided 2026-08-28 to STAY on Turbify: do not re-propose a migration"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 68e76cae-f802-47c9-a773-009123bf6ccf
  modified: 2026-08-28T09:27:33.955Z
---

**Turbify (Yahoo business mail) cannot give Phoenix central access to employee mailboxes.** Verified
2026-08-28 against Turbify's and Yahoo's own documentation, after a week lost to the opposite belief:

- **No API creates app passwords.** They are generated **manually, in a browser, from inside the
  mailbox's own Account Security screen** ("Manage app passwords"). An app password authenticates
  **only the account it was created in** — one made in the admin account is rejected by every other
  mailbox. There is no domain-wide, admin, or bulk equivalent.
- **No admin delegation, no admin IMAP, no journaling.** Turbify is consumer Yahoo with a business
  label; it has none of the Workspace/M365 admin machinery.
- **Catch-all and automatic forwarding are both END-OF-LIFE**, so the two admin-side tricks that
  could have copied mail centrally are gone as well.
- The admin *can* reset any mailbox password — but that locks the employee out and is highly
  visible, which defeats silent monitoring. That is why it is not a workaround.

**A previous session told the owner Phoenix could mint app passwords through a Turbify API. That was
false**, and nothing in the codebase ever did it — `addMonitor` only *consumes* a pasted password.
The correct IMAP host was never the problem either: `imap.mail.yahoo.com:993`, the same host the
working `careers@`/`hr@` recruitment inboxes use.

**OWNER DECISION 2026-08-28 — he stays on Turbify. His words: "NO LEAVE ME AS I AM NOW."** He was
given the full costing first (Google Workspace Business Starter is enough for the API access —
$7/user/month, **$420/month for 60 mailboxes**, 14% Egypt VAT waived with a valid tax ID; Microsoft
365 Business Basic the same $7) and **declined**. He also cannot generate per-mailbox app passwords,
so individual **employee** mailboxes simply cannot be monitored, and that is settled — not an open
problem to solve.

**Why:** this loop already cost him a week — a wrong capability claim, then a fix that could not fix
it, then a migration pitch he did not want. Re-opening it costs him the same time again.

**How to apply:** do **not** propose a mail migration, an MX/archiving gateway, or per-mailbox app
passwords unless he raises it himself. If a session hits "Could not connect to that mailbox", the
cause is the credential (wrong account, or not an app password), never the host. What *does* work
and shipped in [#2548](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2548) (prod
`487725b6`): the monitor lists the company mailboxes Phoenix **already** holds credentials for —
from `RECRUITMENT_EMAIL_INBOXES_JSON`, whose password field is `password`, not `pass` — and connects
them on one click, no password typed or sent. Proven live read-only: `hr@` 21 folders / 421 messages,
`careers@` 14 folders / 1,157 messages. The `___` naming rule still governs any app-password UI —
see [[mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix]].

**Separate and equally dangerous, recorded 2026-08-29:** a password reset does NOT revoke a
leaver's mail access — app passwords survive it and must be deleted explicitly. The line above
("the admin *can* reset any mailbox password — but that locks the employee out") is true of the WEB
mailbox only; every configured phone and Outlook client stays connected. See
[[a-password-reset-does-not-revoke-a-turbify-mailbox]].
