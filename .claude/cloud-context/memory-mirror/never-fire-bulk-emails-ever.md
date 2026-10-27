---
name: never-fire-bulk-emails-ever
description: "ABSOLUTE owner rule — never fire bulk emails, test sends, or any real email from this system, under any circumstance; and never SUGGEST announcing or sending anything to employees"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ae8a0b0-d0e1-43b4-9ba8-570fdca85c41
  modified: 2026-09-18T08:04:50.795Z
---

**NEVER fire bulk emails in this system. Ever.** Owner instruction, stated 2026-08-13 during the
email-inventory audit, phrased absolutely: "never fire bulk emails ever in the system never".

This covers: bulk/campaign sends, "just one test email", triggering a cron route that dispatches
mail, calling a notify/send helper to see what happens, or re-running a retired sweep to observe
its output. It applies on production AND staging — staging shares recipient data and real work
emails.

**Why:** real employees at a live pharma company receive these. A stray send is unrecallable,
lands in real inboxes, and can look like an official HR/payroll communication. The owner's whole
current initiative is *reducing* email volume ([[email-inventory-audit-2026-08-13]]) — the one
thing an agent must never do while auditing email noise is add to it.

**How to apply:** audit email behavior by READING ONLY — source code, git history, and SELECT
queries against `notification_deliveries` / `notification_events`. Never execute a send path to
learn what it does. If a question can only be answered by actually sending, stop and ask the owner
instead of sending. Prefer `git log`/`git show` to prove a feature is retired rather than probing
it at runtime. See [[verify-notification-deliveries-before-claiming-a-send]] for the read-only way
to prove what was sent.

## Restated 2026-09-18 — not even as a suggestion

A session building the personal My email tab ended its reply with the quoted next step “announce My
email to all employees”. The owner answered in capitals: "DONOT SEND ANYONE ANYTHING". **An
announcement, a heads-up, a rollout note or an invitation to employees is a send too.** Never offer
one in a **Next step:** line, in quotes or as ghost text. A shipped feature goes live silently, and
telling people about it is his own act, in his own time. What shipped features may still send is a
person's OWN action, like pressing Send in their own My email. That is the only send path PR 3992
added.

## One owner-granted exception, 2026-08-27 — the 6-hourly CV digest

The owner was shown this rule and the two sibling never-email rules, told that
[PR #2438](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2438) contradicted all
three, and chose to merge it anyway. `src/lib/recruitment/inbound/cv-intake-digest-6h.ts` therefore
mails every manager who received candidates in the last 6 hours, CC'ing their manager (not for NSM)
and omar.anwar always. It is **live** — cron-job.org job **8334658** fires it at
00:47 / 06:47 / 12:47 / 18:47 Africa/Cairo, first run 2026-08-27 06:47. Do not delete it citing this rule; do not treat it as licence for any OTHER
bulk send. Full detail: [[recruitment-cv-received-is-in-app-and-telegram-never-email]].
