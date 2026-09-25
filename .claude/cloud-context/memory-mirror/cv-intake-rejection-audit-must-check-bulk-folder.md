---
name: cv-intake-rejection-audit-must-check-bulk-folder
description: "Re-auditing rejected CV intake events by IMAP UID must check the mailbox's Bulk/Junk folder too, not just INBOX — the poller itself does"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T06:05:50.232Z
---

`email-poller.ts` polls **two** IMAP targets per mailbox every cycle: `INBOX` under the mailbox's own
cursor label, and — if the server exposes one — a Junk/Bulk folder under a second cursor label
(`junkCursorLabel`, see `pickJunkFolder`). A rejected intake event's UID can therefore belong to
either folder. `ats_inbound_intake_queue.payload.folderPath` records which one; on 2026-08-14 four
of the `careers` mailbox's `ignored_unsupported_attachment` rows lived in `Bulk`, not `INBOX` —
scripted the same way as [[scanned-pdf-cvs-were-silently-dropped]]'s Osama investigation, an
IMAP-fetch-by-UID script that only opens `INBOX` reports those as "NOT FOUND" and silently
under-counts.

**Why:** nothing about `ats_cv_intake_events` marks which folder a message came from, so re-checking
"was this genuinely dropped" from the event row alone will miss real applicants who happened to land
in the provider's spam folder — which, per that same sweep, is not a reliable signal of actual spam:
one of the four (Afroz Ansari) was a genuine scanned-CV drop, identical bug to Osama.

**How to apply:** before declaring an intake-event UID unrecoverable, look up its
`ats_inbound_intake_queue.payload->>'folderPath'` (join on `provider_message_id`) and fetch from
that folder, not a hardcoded `INBOX`. Separately: two rejected rows in that same sweep were WhatsApp
attachments — Meta's media links expire and this repo never persists the bytes, so those genuinely
cannot be re-audited after the fact; say so plainly rather than reporting them as checked.
