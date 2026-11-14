# The offer letter, the candidate and the Employee Master tell one story

Owner request, 2026-10-14: the Talent Acquisition overview's "job offers vs recruitments" showed
extremely wrong data — people were hired from the recruitment module but outside Phoenix, offers were
sent and answered, and the dashboard did not know. Module memory carries the one-line rule
(`.claude/rules/recruitment.md`); this is the account.

## What was wrong (measured on production, 2026-10-14)

Three records describe one hire — the offer letter (`offers`), the candidate (`ats_candidates`) and the
employee (`employees`) — and nothing wrote one to the next.

- **"Job offers, by status" counted 43 letters, not 43 people.** It included duplicates and letters
  sent to the owner's own inboxes, and four letters still read `accepted` for people the Employee Master
  already recorded as `declined_offer`.
- **24 of 26 accepted letters had no `employee_hr_id`**, while 21 of those people were on the Master. The
  link the screen reads for "Offer to join" was missing because HR's Add Employee, started from a letter,
  never pointed the letter at the employee it created.
- **"Declined offer" on the Employee Master touched nothing else** — not the letter, not the candidate.
  One candidate still read `hired` for a person who never joined.
- **The Hired tile read the unused half of the ATS.** The applications table held 2 hired rows ever, so
  October read 0 while 20 people had been hired. The candidate pool (the half people actually use) held
  745 undecided, 127 shortlisted, 33 sent to a manager, 16 hired and 495 rejected.
- **Candidate statuses lagged**: 11 people who joined still read shortlisted or sent to a manager.

## What was repaired in the data (announced bulk change, pre-image kept)

Pre-image schema `ats_backup_20261014_offerhirefix` on production holds every letter (43), every candidate
row touched (17) and the status events, so any of this reverses row by row.

- 23 letters were pointed at the employee they became (19 accepted + 4 later declined).
- Four letters moved `accepted` to `declined` where the Master says the person declined the offer.
- Eleven existing candidates were stamped `hired`, each with an append-only history line; four moved to
  `rejected` with a reason. No candidate, application or employee row was created.
- After: letters accepted 21, declined 15, sent 1, withdrawn 6 (= 43); every accepted letter has an
  active employee, no employee is linked by two letters; candidates hired 16.

## What keeps it repaired (the code)

Four doors write the story forward. Each is best-effort — a failure is logged, never thrown, and never
blocks the hire or the decline itself.

1. **HR's Add Employee, started from an accepted letter.** The form remembers the letter its draft came
   from (`offerLinkId`, set only once the draft landed in the form, cleared by `startCreate`, `startEdit`
   and `closeForm`) and sends it as `offerId`, beside the employee and on a CREATE only. The route links
   the letter after `upsertEmployee` and BEFORE the follow-ups, any of which can throw.
2. **The candidate's own joining form.** `joining-form-service.ts` hands back the letter; the public route
   strips it from the response and calls the sync. The offers module still never imports recruitment —
   the route is where the two meet.
3. **"Declined offer" on the Employee Master** (`declineOfferAndOpenVacancy`). After the audit row and
   before the notification, accepted letters of that employee become `declined` and the candidate behind
   them is moved to `rejected`.
4. **A letter marked declined by hand on the Offers screen** (`PATCH /api/offers/[id]`). After the status is
   written, the candidate behind the letter moves to `rejected` — only if they are still in a LIVE pile
   (new, shortlisted, backup, sent to a manager); a hired or rejected candidate is left exactly as they are,
   so a letter marked declined by mistake can never un-hire anyone. `withdrawn` never reaches it: a pulled
   or expired letter says nothing about the person.

The shared writers:

- `stampOfferHiredByHr(offerId, hrId)` — `offers/service.ts`. Writes `employee_hr_id` only on an
  `accepted` letter that has none, so a stale tab can never repoint a letter that already names somebody.
- `declineAcceptedOffersForEmployee(hrId)` — finds letters through the employee they point at (all
  case spellings of the id), never by a name or an address.
- `recordHireFromOfferLetter` / `recordOfferDeclinedAfterHire` / `recordOfferDeclinedByCandidate` — `recruitment/offer-outcome-sync.ts`. The
  candidate is found ONLY through the pointer the letter carries (`candidateForOfferLetter`); never by
  name, e-mail, phone or national id. A status move writes the append-only history line, is idempotent,
  and sends no notice — a rejection notice is never automatic.

## The Hired tile

The tile counts the **Employee Master** inside the window the picker chose (default: the running Cairo
month): `countHiresInWindow` in `src/lib/employees/hires-in-window.ts`. It skips `declined_offer`,
compares dates as days, and reports people whose start date is still ahead as "N start later" in the
caption. With no directory loaded the tile is ABSENT — a pipeline figure standing in for the master would
be the original defect again.

The offers chart caption now says it counts letters, not people.

## The candidate tiles and the funnel read the candidate pool

Measured on 2026-10-14: the candidate pool (`ats_candidates`) held 1,417 candidates — 741 undecided, 124
shortlisted, 32 with a hiring manager, 1 backup, 24 hired, 495 rejected — while the applications half of the
ATS held 38 rows, every one of them also in the pool. "Active Candidates" read the 30 live applications
against a live pipeline of 898.

- `getCandidatePoolCounts()` (`recruitment/dashboard.ts`) reads counts only — six head counts, `new` being
  the remainder so an unreadable status lands in "undecided" exactly as the decision tabs file it — and rides
  on the dashboard summary as `candidatePool`, so both overview pages get it through the same source.
- Tiles: **Awaiting Review** (new), **With Hiring Managers** (sent to a manager), **Active Candidates**
  (new + shortlisted + backup + sent to a manager), **Hired** (the Employee Master, above). The old
  "Interviewing" tile counted applications at an interview stage; the interview volume has its own figures
  on the Talent Acquisition page.
- The chart keeps its title, "Live candidates, by pipeline stage" (the owner's choice): one bar per live pile
  (`CANDIDATE_FUNNEL_BARS`, which add up to Active Candidates) plus "Hired, not started" — people the
  Master holds whose first day is still ahead (`countStartingAfter`), the hand-off between an accepted
  offer and a person at work. Rejected and hired are history, not counted in the first four bars. The
  hand-off bar is absent without the directory, never drawn as 0. `tests/hr-command-center.test.ts` asserts
  every `candidateStatuses` value is a bar or a finished pile.

## The owner's answers, applied the same day

Pre-image of this second round: `offers_pre_round2` and `candidates_pre_round2` in the same backup schema.

- Clara Refaat's accepted letter (start 11 October, never hired) is `withdrawn` — the company withdrew
  it; her candidate record stays `rejected`.
- Three joiners whose candidate record matched only by name (no phone or letter pointer) were stamped
  `hired` on his confirmation that each candidate is that person: Sahar El Gallad, Emad Awad Sami and
  Esraa Ibrahim Saad (the candidate "Esraa Ibrahim Saad Eldien"; the unrelated "Esraa Ibrahim Abobasha"
  was not touched).
- Five letters sent to his own inbox or work address, or duplicates of another letter, are `withdrawn`
  so they stop counting as declined offers.
- After both rounds: letters accepted 21, declined 9, sent 1, withdrawn 12 (= 43); candidates hired 19.

## A third round, from the data's own trail (same day, pre-image `candidates_pre_round3`)

- The three name-confirmed joiners were also POINTED at their accepted letters (`offer_id`), which round two
  had not done.
- Five employees carry `cv_source = 'recruitment'`: their CV was copied from a candidate when they were
  created. Matching that file by name and byte size gave exactly one candidate each, and the names and
  phones agree — Samaa Shalaby (was rejected), Mohamed Hamed Salem Hamed (new), HR Yasmeen Elsafory (was
  rejected), Aya Mohamed Mahmoud (shortlisted) and Mohammed Alaa Eliwa (new) were marked `hired`, each with a
  history line naming the employee.
- Two candidates behind DECLINED letters were still live (Yasmeen Adel, new; Aya Gaber, sent to a manager)
  and were moved to `rejected`, the same word door four writes.
- After: candidates hired 24, rejected 495, undecided 741, shortlisted 124, with a manager 32; 23 candidates
  point at a letter.

## Left alone

- Four joiners have no candidate record at all — the 2026-09-28 ruling stands: leave them without one.
- Duplicate candidate rows of people already hired exist (Asmaa Zaghloul, Menna Tallah Rady, Nourhan Gamal);
  merging them is a human action.
- Employees recruited without a letter and without a candidate trail (September's field hires) have no
  candidate to stamp, and the same 2026-09-28 ruling keeps it that way. A phone number alone never links
  one: it is shared on this data (one number matched three different candidates).

Pinned by `tests/offer-hire-sync.test.ts`, `tests/hired-tile-period.test.ts` and `tests/hr-command-center.test.ts`.

## The hire hand-off ledger (REC-027, 2026-11-13)

**The goal: a step that fails at any point in a hire leaves a visible item that can be retried, never a
silent gap.** Both hiring doors write the employee and then run a chain of follow-up steps. Before
this change, each step only logged its failure (`offer_hire_sync_failed`,
`offer_joining_form_stamp_failed`, `offer_joining_form_audit_failed`,
`offer_joining_form_access_failed`). Nothing retried a failed step and nothing showed it.

| Step | Add Employee (`app/api/employees/route.ts`) | Joining form (`src/lib/offers/joining-form-service.ts` + `app/api/public/offer-acceptance/[token]`) | The retry, and why running it twice is safe |
| --- | --- | --- | --- |
| `offer_link` | when filled from a letter | in the route, after the form | `recordHireFromOfferLetter`: it links only an accepted, unlinked letter, and a candidate already hired is left alone |
| `candidate_hired` | when opened for a candidate | — | `recordHireFromCandidate`: a hired candidate is reported as "already" |
| `login` | always (a throw still fails the save) | always | done when any login exists for the HR id. Otherwise the same authority the door used, never more. "Already exists" counts as done |
| `cv` | only when a CV was given | — | done when the record has a CV, which is never overwritten. A staged file cleared after a day gives up and says so |
| `mailbox_task` | after the reply | always | the task's unique key on the HR id; the notice is in-app and Telegram, never email, and keyed per hire |
| `offer_stamp` | — | always | done when the letter names this hire. A letter that names someone else, or is no longer sent or accepted, is never overwritten and the step gives up. The link is re-run after the stamp |
| `acceptance_audit` | — | always (the insert's error is now read) | done when a row exists for this letter and hire. Otherwise one minimal row says the retry wrote it; his answers stay on his record |

- **Ledger:** `public.hire_handoff_steps` holds one row per employee and step, with `pending`, `done`,
  `failed` or `gave_up`, the number of attempts, the last error as a short sentence, and a
  whitelisted `context` of ids. It never stores a password, token, salary or national id.
  Migration `20261113201756_hire_handoff_steps.sql`. Only the service role can read or write it.
- 🔴 **The ledger never changes a door's reply.** Each wrapped step returns or throws exactly what it
  did before. Ledger writes are queued, run outside the step, and are caught and logged
  (`hire_handoff_ledger_write_failed`). Add Employee flushes the queue after its reply; the joining
  form flushes before it answers.
- **The retry:** `hire-handoff-reconcile` runs hourly on :09. It covers failed rows, and pending rows
  older than 30 minutes, which a door that crashed mid-way leaves behind. It holds a job lease, runs
  at most 25 steps per run within a 40-second budget, and waits 15 minutes, then 30, 1 hour, 2 hours,
  and at most 6 hours between attempts. After five attempts, or when a step can never succeed, the
  row is marked `gave_up`. Logic: `src/lib/employees/hire-handoff-reconciler.ts`.
- **Seen:** the Needs You source `hire-handoff-gaps` shows failed and given-up steps, one row per
  person by name, linked to the record ([needs-you.md](needs-you.md)). `POST
  /api/employees/hire-handoff/retry`, checked against `employees:create`, runs one step now
  through the same retry.
- **Caught even with no ledger row:** the reconciliation check `new-hires-without-login` flags any
  active employee hired in the last 60 days who has no login and no pending or failed login step. A
  hire made before the ledger existed, or a ledger write that was lost, still surfaces.
- 🔴 **The offers module still never imports recruitment.** `hire-handoff.ts` imports nothing from
  recruitment; the reconciler is the only part that reaches recruitment, and the offers module never
  imports the reconciler.

Pinned by `tests/hire-handoff-steps.test.ts`.
