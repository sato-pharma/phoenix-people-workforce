# Notifications, phase 2 — button emails in the outbox, the registry's loose ends, heartbeats, shared state

Phase 2 of the November 2026 health plan, the notifications stream (REC-048, REC-084, REC-049,
REC-083). One pull request, 19 November 2026. This page is the account behind the module rules in
`.claude/rules/notifications.md`, `platform-access.md`, `platform-observability.md`,
`recruitment-offers.md` and `recruitment-inbound.md`.

## 1. The emails a person sends with a button go through the outbox (REC-048)

Phase 1 (#353) moved every leave email and the two background interview emails onto
`sendDurableEmail`: the outbox row is written first, the email is sent at once as before, a provider
failure leaves the row for the drain, a dedupe key means a retry never queues a second email, and an
email out of retries shows on the "Send again" panel. The sends a person makes with a button were left
out. They are on it now:

| Send | File | What a late send by the drain still does |
|---|---|---|
| The job offer letter (Send) | `src/lib/offers/send.ts` | marks the offer sent with the design and copies frozen at the press, writes the audit row, tells the requester when it was waiting for approval |
| The offer letter resent | `src/lib/offers/send.ts` | writes the audit row (a resend changes nothing on the offer) |
| The offer expiry notice | `src/lib/offers/send.ts` | withdraws the offer, still only if it is out with the candidate |
| The Interview Calendar invitation | `src/lib/recruitment/interview-invitations.ts` | adds the "sent" line to the invitation log |
| The marketing "Approved requests" email (Phoenix route) | `src/lib/marketing-requests/ceo-approvals-email-service.ts` | nothing — the email is the whole act |
| The careers form's confirmation | `src/lib/recruitment/inbound/website-apply-confirmation-email.ts` | nothing |

**Nothing about who receives them changed.** The stored input is the exact input the press used —
From, To, CC, BCC (the owner's hidden copy of every offer included), subject, body and the offer PDF —
and the drain hands it back to the same sender unchanged. A sent row keeps no body, figures or PDF.
Credential emails never take this path.

**The person who pressed still learns at once whether it went.** A send that went is answered as
before. A provider failure is still a failure to the caller, worded "Queued for retry: …" so the
person knows Phoenix will try again; the interview calendar says so in plain words, the marketing
email records it in its audit row and answers "not sent" with that reason.

### Three things the button emails needed that the leave emails did not

1. **The hr@ mailbox, by name.** An offer leaves through the real `hr@satopharma.com` mailbox on
   Turbify when its app password is set (`jobOfferSmtpDispatch()`). A function cannot be stored in a
   row, so the stored message names it — `dispatch: "job_offer_smtp"` — and the send resolves it
   again, inline and on every retry (`resolveDirectEmailDispatch`). Unset password, the provider chain,
   exactly as before.
2. **A failure through a real mailbox is never retried behind the sender's back.** Turbify may already
   have taken the message (the code has always told HR to look in Sent before sending again). A
   `JobOfferSmtpError` or a `PersonalMailboxError` closes the row as `not_retried`, and the caller gets
   the ORIGINAL error, word for word. The marketing email's own-mailbox route was already never
   retried and stays a direct send.
3. **The email is the act.** An offer counts as sent only once its email leaves. If the drain delivers
   a letter the press could not, the record must catch up, and a letter that is no longer the right one
   must not go. Each such row carries a `followUp` (`src/lib/notifications/durable-email-follow-up.ts`)
   and the drain — never the press — runs two steps around the retry (`retryDirectEmailOutboxRow`):
   - **before**: is it still the email to send? An offer edited, sent, returned or withdrawn since the
     press, or moved to a new revision, closes the row unsent (`follow_up_refused`); an interview
     cancelled, moved, given another interviewer or already begun does the same. A record that cannot be
     read leaves the row queued — a stale letter is never sent on a guess. The rules are pure:
     `offerLetterRetryVerdict`, `offerExpiryRetryVerdict` (`src/lib/offers/outbox-retry.ts`) and
     `interviewInvitationRetryVerdict` (`src/lib/recruitment/interview-invitation-retry.ts`).
   - **after**: what the press would have done (the table above). A failure there is logged, never
     thrown — the email went.

**A second press replaces a waiting first.** An offer's PDF and accept link are minted afresh on each
press, so two presses are never the same message and the dedupe key alone cannot join them. Each button
email names the email it is (`supersedeKey`, e.g. the offer and its revision); a new press closes any
older row for it that is still waiting (`pending` or `failed`, never `processing`) as superseded, so the
first attempt is never retried behind the second.

Proof: `tests/durable-button-emails.test.ts` runs the real outbox code against an in-memory stand-in for
the database. A forced provider failure at the press leaves a `failed` row with one attempt spent and
the drain's five-minute backoff; the drain's own due-row query picks it up once due, claims it, asks the
follow-up, sends the stored input through the same hr@ dispatcher and marks the offer sent.

### Outbound WhatsApp and its ledger

Every outbound WhatsApp message goes through `whatsapp-interactive.ts`, whose sender records each send
in `ats_whatsapp_outbound_messages` (the approvals line in its own ledger) — except one: the optional
"we received your CV" acknowledgement (`src/lib/recruitment/inbound/whatsapp-reply.ts`, off unless its
three variables are set) posted to Meta itself and recorded nothing. It now records its row after Meta
answers, success or failure. Record only: the message, number, template and what the function returns
are unchanged, and the access token is never written. The test refuses a new file that posts to Meta's
`/messages` without recording.

## 2. The notice registry's loose ends (REC-084)

**The bell's categories come from the registry.** The personal bell lists a notice only when its
category is on an allowlist, and that list was kept by hand in `recipients.ts` beside the registry. It
now lives in the registry's bell half (`src/lib/notifications/notification-bell-categories.ts`,
re-exported by `notification-types.ts`), each category with the reason it is there, and
`PERSONAL_BELL_CATEGORIES` is derived from it. The engine's default for a notice that names no category
(`categoryFor` in `system.ts`) asks the same file (`defaultNotificationCategory`), so the two can never
disagree. The list is unchanged, in the same order: adding a category would put every stored notice of
it on its recipients' bells, so that is a decision, never a tidy-up.

`tests/notification-registry-loose-ends.test.ts` holds the list to the code both ways: every category a
notice is written under — named by the sender, or defaulted from its module — is registered (or listed
off the bell with a reason; none today), and every registered category is still written. Two are written
by nobody and are kept so notices already in people's bells still open: `crm` (the retired iReports360
reminders) and `outstation` (nothing sends the high-risk digest any more). The send reader
(`tests/support/notification-send-scan.ts`) now reads a send's category, and reads a raw durable email
like a direct one, so moving a send onto the outbox cannot hide it from the untyped-sends list.

**The silent default is visible.** A type with neither its own policy row nor its module's `.*` row fell
to `defaultPolicy` (in-app, email and push to the named employee) with nothing said. It now logs
`notification_policy_default_used`, a warning, once per type per process. The 63 registered types that
take the default today (64 until the resignation reminder was fixed, below) are named in `DEFAULT_POLICY_ACKNOWLEDGED` (`policy.ts`), each module with its
reason — today's behaviour, acknowledged, not ruled on — and the test refuses a registered type with
neither a row nor an acknowledgement, and an acknowledgement for a type that has since gained a row.
No policy value moved.

### The mismatches the owner should see (reported, not changed)

Fixing any of these changes who is told, so each is the owner's decision.

1. **Policy rows that nothing sends** (6): `expenses.*`, `field_workforce_compliance.*`,
   `marketing_requests.request_completed`, `system.announcement`, `telegram.daily_hr_digest` (the
   digest goes out as `system.daily_hr_digest`), `telegram.delivery_escalation`. They are kept, listed in
   `tests/notification-type-registry.test.ts` as `POLICY_KEYS_NOTHING_SENDS`.
2. **The resignation reminder missed its policy — FIXED on the owner's word, 19 Nov 2026** ("fix the
   resignation reminder's policy"; section 2a below).
3. **Event names that match only their module's wildcard row** (137 types in 26 modules as counted for
   this report; 138 since the resignation reminder joined `resignations.*`). They get
   whatever the module's `.*` row says, with no row of their own. The largest groups: recruitment 23
   (interview reminders, intake alarms, the stale-send nudges), weekly plans 18, vacation 14, direct
   orders 13, attendance digest 8, and six each for Market Awareness, offers, payroll and Phoenix CRM.
   Each would need its own row only where the module's row is not what that event should do.

### 2a. The resignation reminder takes the resignations policy (fixed 19 Nov 2026)

The daily reminder that a resignation has waited more than five days for a decision
(`runResignationSlaDaily`, `src/lib/resignations/service.ts`, 06:36 Cairo) was sent under the module
`resignation`. Every other resignation notice, and the policy row, is `resignations`, so the
`resignations.*` row never reached it.

**What it did before.** Its own channel list decided: **email and phone push only**, high priority, to each
person on its own recipient list. (The report above first said "in-app, email and push": that is the
default row's list, but the reminder's own list overrode it, so it never reached the bell.)

**What it does now.** It is sent under `resignations` with no channel list of its own, so the row decides:
**in-app (the bell), email, Telegram and phone push**, high priority — the same four channels as every other
resignation notice. A person's resignations preferences now apply to it too.

**Who is told did not change.** The reminder still names its people itself: the `resignation_sla_reminder`
recipient list (Super Admin unless edited on the notification recipients screen), one notice per person.
A notice that names its recipient goes to that person alone; the row's permission-based rule only picks
people for notices that name nobody. Telegram reaches only the people who have linked it.

**The trap the move uncovered.** Under `resignations` an email must name the employee it is about
(`employeeSubjectWorkflowModules` in `system.ts`), or the identity guard refuses it for good. The reminder
named nobody, so moving the module alone would have **silently stopped its email**. It now passes the
leaver's HR id as `subjectHrId`, which is what the other resignation notices do. A resignation row with no
HR id would still have its email refused, while the bell, Telegram and push copies go.

Pinned by `tests/resignation-reminder-policy.test.ts`, which runs the real reminder against the in-memory
database (`tests/support/postgrest-stand-in.ts`) with sending switched off and reads the notice and its
four deliveries. Each part of the fix was undone in turn and caught by its own assertion: the module, the
old channel list, the missing `subjectHrId` (the email then stops at the identity guard), and the
acknowledgement in `DEFAULT_POLICY_ACKNOWLEDGED`.

### 2b. A notice that names its recipients goes to them or to nobody (fixed 19 Nov 2026)

On the owner's word ("start the resignation alert fallback task"), found while fixing 2a.

**The gap.** Five senders name their audience from an admin-editable list and pass it to the engine as
`metadata.moduleOwnerHrIds`: the resignation alert (`resignation_workflow_alert`), the payroll workflow and
payroll upload alerts (`payroll_workflow_alert`), the employee-import alert and the attendance stall alert.
Their policy rows pick recipients `permission_based`, and `permissionBasedRecipients` (`policy.ts`) used the
named people when there were some. When the list came back **empty**, it looked through every active login
instead and told each one holding the permission with company scope, or in the subject's manager chain.
For a resignation that is the Super Admin, the CEO, the Finance Manager and HR Operations — the owner's
2026-08-09 rule leaves the CEO out on purpose.

The list comes back empty in three ways:

- a failed read (`resolveNotificationPersonRecipients` returns no one with a warning);
- nobody on the list resolving to an active person (`candidatesByHrIds` needs an active `employees` row);
- **the list switched OFF on the notification recipients screen** — the worst case, because "off" meant
  "everyone with the permission".

**The fix.** `notificationNamesItsRecipients(metadata)` says whether the sender named its people: any of
`permissionRecipientHrId(s)` / `moduleOwnerHrId(s)` present, even as an empty list or null. A named notice
uses exactly those people; if none resolve it resolves to nobody, the fail-closed path records the skip,
and the warning reads `named_recipients_unresolved`. A notice that names nobody keeps the fallback (no
sender above does that).

**What changes for who is told.** Nothing while the lists work. Only in the three failure cases above: the
alert used to reach every company-scope holder of the permission, and now reaches nobody, with the skip on
record. For the payroll alerts that fallback was every company-scope holder of payroll access.

Pinned by `tests/named-recipients-never-widen.test.ts`, which drives the real engine and the real resolver
against the in-memory database (`tests/support/postgrest-stand-in.ts`) with the resignation alert's own
shape. On the old fallback each of its three failure cases fails with its own message — the empty list
told the CEO — and all pass on the fix. The rule lives in the new `notification-recipients` module memory,
split out of `notifications` the same day (its pointer had reached 3,976 of 4,000 bytes).

## 3. Every scheduled route records a heartbeat (REC-049)

`tests/scheduled-route-heartbeats.test.ts` reads every route under `app/api/cron/**`, the two morning
notification routes (`/api/notifications/daily` and `/api/cron/daily/[job]`) and every route a scheduler
calls — the cron-job.org jobs in `scripts/cronjob-sync.mjs` and the GitHub workflows that call a route —
and holds each to: it reports through `withDeadMansSwitch` or `pingDeadMansSwitch`, and every slug it
reports under is declared in `JOB_SCHEDULES`, so the sweep judges it. Five routes no scheduler calls are
named with the heartbeat that covers their work (the marketing assignment backfill, the probation
milestones trigger and the three notification sub-routes the morning jobs import).

It found one scheduled route that reported nothing: `/api/cron/attendance-weekly-digest`, called by
`.github/workflows/attendance-weekly-digest.yml` at 03:23 and 10:23 UTC. It now reports as
`phoenix-attendance-weekly-digest` — success on a 200, failure on any other answer, nothing for a
refused caller — declared at `23 5,12 * * *` Cairo (the earlier reading, like the pg_cron jobs) with
three hours of grace, in-house only, in both tables of `docs/observability.md`. The morning jobs' split
(`PHOENIX_DAILY_JOBS_SPLIT`) is still off; switching it on stays an operational step on the owner's
machine.

## 4. Shared state across servers (REC-083)

**Two drains, one drains — the real drain.** `tests/shared-instance-state.test.ts` proved the lease
helper around a stand-in for the drain's steps. `tests/notification-drain-two-instances.test.ts` runs
`runScheduledNotificationProcessing` itself, loaded as two module instances (two servers, each with its
own in-process guard) against one in-memory `claim_job_lease`. The first drain is held inside its first
step while the second starts: the second answers `overlapping-run`, refused by the shared lease, and
only one reaches a step. Once the first hands the lease back (a one-second re-claim), the other server's
next run drains. No request reaches a sending service.

**The permission cache hears another server's change.** Each server keeps the effective permission
matrix for 30 seconds, and saving a change on Access Control cleared it only on the server that saved
it. It now gets the directory's signal: a copy held past 10 seconds asks the override table's shared
version — its newest `updated_at` and its row count, in one read — at most every 10 seconds per process,
and is reloaded when it moved (`src/lib/auth/permission-matrix-version.ts`, wired in `permissions.ts`).
One difference from the directory, on purpose: a moved version marks the copy STALE rather than dropping
it, so a reload that fails still serves the last-known matrix — never the fail-closed cold start, which
would lock every seat but the Super Admin out over another server's change. Pinned by
`tests/permission-matrix-shared-version.test.ts`.

## Left alone

The mailbox robots' own worker (REC-075) waits on the owner's hosting decision and is untouched.
