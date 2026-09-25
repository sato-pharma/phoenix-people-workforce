---
name: mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix
description: "Mailbox Compliance Monitor — the app-password entry employees name in Yahoo/Turbify is `imap` (was `___` until 2026-09-07, which Yahoo REFUSES), and the monitor UI must NEVER say \"Phoenix\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 68e76cae-f802-47c9-a773-009123bf6ccf
  modified: 2026-09-07T12:20:27.713Z
---

The **Mailbox Compliance Monitor** (shipped 2026-08-28, PR #2525, prod rev `459815eb`) is a
Super-Admin-only admin page (`/admin/mailbox-monitor`, permission resource `mailbox_monitor`) that
reads company `@satopharma.com` mailboxes strictly read-only over IMAP (Turbify/Yahoo,
`imap.mail.yahoo.com:993`) using an **app password** the admin generates — the employee keeps their
normal login password and sees nothing (EXAMINE mode, never touches `\Seen`), exactly like the
existing `hr@`/`careers@` recruitment inboxes. Storage: tables `mailbox_monitors` +
`mailbox_monitor_access_log` (service-role only, RLS on, no policies). The app password is sealed
AES-256-GCM by `src/lib/security/secret-box.ts` with env `MAILBOX_MONITOR_SECRET`, which is set on
Railway **per environment** (a different key on production vs staging — a mailbox sealed in one is
only ever opened in the same one).

**THE OWNER RULE — the entry name is `imap`, and the word "Phoenix" never appears.** When the admin
generates the app password in the mailbox's own security screen, the entry name shown there under
"Manage app passwords" is **`imap` — nothing else, no other label** — and the monitor UI must
**NEVER write "Phoenix" or refer to Phoenix anywhere in that app-password flow.** The guidance text
lives in `src/components/admin/mailbox-monitor-dashboard.tsx`.

**AMENDED 2026-09-07 — the value changed; the reason behind it did not.** The rule was `___` (three
underscores) from 2026-08-28 until 2026-09-07, when the owner hit it himself while connecting his
own mailbox (`omar.anwar@satopharma.com`) for an email vacation-request audit: **Yahoo/Turbify
rejects an app-password name made only of underscores** — the entry will not save. So the original
instruction was not merely awkward, it was **impossible to carry out**, for every mailbox and not
just his. The UI stated it as *"three underscores — nothing else, no other label"*, which is exactly
the phrasing that stops an employee from trying anything else. He chose `imap` over `mail` and
`sync`. **Do not read a session's note that the rule is `___` as current** — anything dated before
2026-09-07 predates this.

**Why:** the owner stated the original verbatim and emphatically — *"Make the entry that appears in
the employee managed password. Make it appear like three underscores. Never write Phoenix or refer
to Phoenix in this situation. ___"*. The entry name is what the **employee** sees, so it is
deliberately anonymous and unattributable; branding it ("Phoenix Monitor", "Compliance", etc.) would
defeat the point. `imap` preserves that — it reads as an ordinary mail-client entry.

**How to apply:** if you edit that dashboard's app-password guidance, keep it showing literally
`imap` and keep every trace of "Phoenix" out of that specific flow. Do not describe what the entry
stands for, and do not add product branding to the naming instruction. If the name ever has to
change again the test is unchanged: **neutral, accepted by Yahoo's name field, never "Phoenix"** —
and verify the new value actually saves before writing it into the UI as an instruction, which is
the check that was missing the first time. Related: [[turbify-cannot-issue-app-passwords-centrally-owner-stays]]
(app passwords are browser-only, created from inside each individual mailbox — there is no admin
path and no API), and [[a-password-reset-does-not-revoke-a-turbify-mailbox]].
