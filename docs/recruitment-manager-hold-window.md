# A CV stays in a manager's account 45 days at most

Owner rule, 2026-10-06: *"Never a CV stay at a district manager account or any manager account more
than 45 days. Then collect it back to the admin."* Module memory carries the one-line rule
(`.claude/rules/recruitment.md`); this is the account.

## The number and the comparison

`src/lib/recruitment/manager-hold-window.ts` is the only place the number lives
(`MANAGER_HOLD_DAYS = 45`). Every route calls its helpers; none of them writes `45` or its own date
arithmetic.

- A CV is **inside** the window when its clock is at or after `now − 45 days` (`at >= cutoff`).
  Exactly 45 days old is still inside; one millisecond more is out.
- An **unreadable or missing date fails CLOSED** — the CV is treated as expired, never as held
  forever. A manager losing sight of a CV by mistake is recoverable (the desk still has it); a CV
  that can never expire is the defect this rule exists to end.
- Database filters use `column >= cutoff` and the pure predicate uses `at >= cutoff`, so the SQL and
  the TypeScript agree to the millisecond.

## Three routes put a CV in front of a manager — each has its own clock

| Route | Where it is read | The clock |
| --- | --- | --- |
| **Pushed** — the desk sent it to this manager | `ats_candidate_manager_sends` (`listSendsForManager`, `isCandidateSentToManager`) and the legacy single-manager stamp `ats_candidates.manager_notified_*` (`listCandidatesSentToManager`, `isCandidateSentToCaller`) | `sent_at` / `manager_notified_at`. A **re-send is a fresh 45 days** — it is a new row with a new `sent_at`. |
| **District folders** — derived, nothing stored | `listDistrictBoardsForManager`, `districtBoardsHoldingCandidate` in `district-manager-folders-db.ts` | The later of the CV's `createdAt` and `preferencesDeclaredAt` (`folderHoldAnchor`). A candidate who declares new preferences re-enters the folders for a fresh 45 days. |
| **Team view** — NSM / RSM looking down their tree | `hiring-manager-team.ts` (`countPushesByManager`, `isCandidateWithinViewerTeam`), built off the two routes above | Same as the pushed clock; the picker's count and the gate behind it both apply it. |

A fourth route — a requisition the manager **owns** — is a hiring process the manager is running,
not a CV parked with him, and is deliberately untouched.

### What does NOT apply the window, on purpose

- `listSendsForCandidate` and `listLatestSendByCandidate` — history. They answer "who was this sent
  to, and when", and must keep answering after expiry.
- `loadAllDistrictBoards` — the whole-company report path, not a manager's account.
- `manager-cv-engagement.ts` — the engagement report still counts an expired CV. Precedent: a
  returned CV still counts there, and *a CV nobody opened in 45 days* is the very signal the report
  exists to show. Pinned: the file must not import `manager-hold-window`.

## Collecting it back — the daily return

`src/lib/recruitment/manager-hold-return.ts`, run from `runRecruitmentDailyNotifications()` as its
**first** job (the order is pinned: the stale-send check reads `sent_to_manager`, so it must see the
status after this step moves it, or it would chase a manager about a CV he no longer holds).

1. `loadSentCandidates` pages every candidate in status `sent_to_manager`; `loadSendRows` reads their
   send rows (a missing table reads as no rows). `assembleSentCandidates` merges the table with the
   legacy stamp, one hold per manager (`canonicalHrIdKey`), keeping the newer date.
2. `classifyExpiredHolds` returns a CV **only when every manager holding it is past 45 days**. One
   manager still inside the window keeps it where it is. A CV with no dated send is left alone —
   there is nothing to date it by.
3. `returnOne` moves it to **`shortlisted`** with a conditional update (`status = sent_to_manager`
   still), `status_changed_by_hr_id: null` and a note naming the managers and days held, then writes
   an `ats_candidate_status_events` row under the actor **`ops:manager-hold-45-days`**. The `ops:`
   prefix is the existing automated-sweep marker (`isBatchActor`), so the audit trail reads as
   automatic, not as a person.
   - It writes the status directly because `statusChangeRefusal` forbids
     `sent_to_manager → shortlisted` on the click path, and it must not import
     `@/lib/recruitment/candidates` (a pinned import-path check).
   - `shortlisted` ("Worth taking forward") is the status a CV had before it was sent, so it lands back
     in the desk's own list and can be sent again.
4. One digest notification goes to the desk (`recruitmentDeskHrIds()`, in-app channels only — never
   email): title `"N CVs came back from managers after 45 days"`, a line per manager naming every CV.
   Its idempotency key is the Cairo date plus a hash of the CV ids, so a re-run the same day does not
   notify twice.
5. The job never throws; it returns `{ ok, notified, returned, reason? }`, carried in the daily
   cron's result as `managerHoldReturn`.

## No migration, no queue

Nothing is stored for the window — it is read-time. The return uses existing columns and the existing
append-only status events. The returns table (`ats_candidate_district_returns`) was not used: its
reason codes are a CHECK-limited set, and a manual "collect it" queue would hand the owner hundreds of
open items, which is the opposite of what he asked.

## First effect

- **District folders: immediately on deploy.** About 99 of the 105 CVs then live in folders are older
  than 45 days and leave them; about 6 (re-declared) stay. They were never "sent", so nothing needs
  returning for them — they simply stop being shown.
- **Pushed CVs: from 2026-10-10 (Cairo)** — the oldest live send is 45 days old that day. 58 pushed CVs
  expire between 10 and 15 October, and come back on the daily run after each.

## Where it is pinned

`tests/recruitment-manager-hold-window.test.ts` (registered in `tests/run-tests.ts`): the pure rule
and its boundaries; a source pin per route that it applies the window; source pins that the history
readers, the report path and the engagement report do not; the classifier cases; the note and digest
wording (no raw HR ids, no ellipsis); the actor is a batch actor; and the return runs before the
stale-send check.
