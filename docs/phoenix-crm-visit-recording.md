# Phoenix CRM — visit recording for the reps the Super Admin chooses

Built 2026-10-16 at the owner's request. This is the account behind the `phoenix-crm-visits` rule line.

## What he asked for

> "i want to build a feature is that admin have page listed in it all reps with a toggle beside
> evryone if i switch a toggle for a certain rep he is then required to be able to open a voice
> recorder to be able to to do any step in logging the visit my objective from this i want to make
> some reps required to open the voice recorder before visit enter el visist the conv betwen he and dr
> is recorded then after that he can log this visit but the most importaant here this only works to
> who the admin chooose not everyone"

His seven answers, the same day:

| # | Question | His answer |
| --- | --- | --- |
| 1 | A consent step in the app? | No |
| 2 | Which visits? | Doctor AND pharmacy visits |
| 3 | Longest recording | 15 minutes |
| 4 | Who listens | The Super Admin, the SFE managers, and the rep's own managers (`managerChain`) |
| 5 | Microphone blocked | The visit cannot be logged; the rep is shown how to allow the microphone |
| 6 | Shortest recording | 30 seconds |
| 7 | Keeping and deleting | The Super Admin downloads and deletes any recording at any time; nothing is deleted on its own |

## Golden Rule #1

Golden Rule #1 says adding any step to the rep's day needs his word. This feature is that word, and it
reaches **only the reps he switches on**. For every other rep, `recordingRequired` is `false` and Add
visit is unchanged. It is not one of the module's silent checks: the rep can see the recorder, because
pressing it is the step.

## How it works

- **The switch.** Each rep on the switch list has one `phoenix_crm_recording_required` row, keyed by
  the person's hr id, so a rep on two territories is switched once. Only the Super Admin can switch a
  rep, from `/admin/field-crm/visit-recording`.
- **The gate.**
  - `loadVisitForm` asks the switch only when the territory's own rep is entering (`enteredAs === "rep"`).
  - Add visit then renders `VisitRecordingGate` before any customer step: Start recording, Stop and
    send, or Send again if the upload failed.
  - The recorder stops itself at 15 minutes and refuses anything under 30 seconds. Wake Lock keeps
    the screen on, and leaving the page while recording asks first.
- **The upload.**
  - `recording/upload-slot` issues a one-time signed slot in the private `phoenix-crm-recordings`
    bucket. It goes to the territory's own rep only, at most 30 an hour.
  - The browser keeps the sent path in its own storage, so a reload never makes the rep record the
    conversation again (`visit-recording-store.ts`).
- **The claim.**
  - `saveVisit` calls `claimRequiredRecording` **before** the `phoenix_crm_save_visit` RPC.
  - A chosen rep with no recording is refused as `phoenix_crm_recording_required`.
  - `phoenix_crm_claim_visit_recording` checks that the slot was issued to this person, seat and world,
    that it is unclaimed (or claimed by this same visit id, so a re-sent save works), that it is fresh,
    and that the object actually arrived in Storage. It then stamps the visit id.
  - If the save fails after the claim, the slot's visit never exists, and the page skips it.
- **Who hears it.**
  - `hearsVisitRecording` allows the Super Admin, an SFE manager, or anyone in the territory's
    `managerChain`.
  - The rep never hears it: `loadVisitDay` sends the recording's length only to a reader who may hear
    it, and `recording/play` answers 404 to anybody else. He does see its approval (below).
- **Who manages it.** `canManageVisitRecording` allows the Super Admin, never a test persona. It is
  checked on the page and inside every admin service. Delete goes through the Storage API, then stamps
  `deleted_at` and `deleted_by_hr_id` on the row, so the visit reads as recorded and then deleted.

## Files

- `supabase/migrations/20261016103900_phoenix_crm_visit_recording.sql`: the two tables, the bucket and
  the claim function.
- `src/lib/phoenix-crm/visit-recording-rules.ts`: pure; the bounds, wording and view types.
- `src/lib/phoenix-crm/server/visit-recordings.ts`: the only file that opens the bucket.
- `app/api/phoenix-crm/recording/**`: six POST routes (the sixth, `admin/review`, is below).
- `src/components/phoenix-crm/visit-recording-gate.tsx`, `visit-recording-store.ts`,
  `visit-recording-admin.tsx`.
- `app/(admin)/admin/field-crm/visit-recording/page.tsx`.
- Pinned by `tests/phoenix-crm-visit-recording.test.ts` and `tests/phoenix-crm-boundary.test.ts`.

## A recorded visit waits for the Administrator first

Added the same day, 2026-10-16:

> "any visit any type which is recorder must go for adminstarator approval first even if in plan"

So every recorded visit of every type now waits for the Administrator's approval before it counts:
planned, out of plan, out of list, or a pharmacy visit. The Administrator is `canAdminister`, the same
person every other Phoenix CRM "Administrator" line names. This is the one place in the module where
he is an approval step; everywhere else he only takes a step in the holder's place.

How it works:

- **The decision lives on the recording row.** `phoenix_crm_visit_recordings` gained `review_status`
  (`pending`, `approved`, `refused`), `reviewed_by_hr_id`, `reviewed_at` and `review_note`. Every
  recording starts at `pending`.
- **It counts in nothing until he approves it.**
  - `phoenix_crm_countable_visits` leaves out any visit whose recording is not `approved`, so every KPI
    that reads the view waits on his decision.
  - `phoenix_crm_report_visits_by_day` and `phoenix_crm_report_plan_vs_actual` count such a visit as
    waiting, and a refused one as refused.
  - The visit day turns `countsInKpi` false until it is approved, for every reader.
- **A recorded off-plan visit goes to him before its manager.**
  - A before-insert trigger, `phoenix_crm_unplanned_waits_for_the_administrator`, moves a recorded
    off-plan row from the step it would have started at to `admin_pending`, and keeps that step in
    `after_admin_status`.
  - Approving it moves it on to that step, and only then is the district manager (or SFE) told. The
    save itself sends that notice for an unrecorded visit only.
  - Refusing it ends it: the visit is refused.
  - The manager's and SFE's decide path refuses an `admin_pending` visit outright.
- **He decides on the Visit Recording page.** A "Waiting for your approval" section comes first, oldest
  first, with the player. Approve is one press; Refuse needs a note. `POST
  /api/phoenix-crm/recording/admin/review` asks `phoenix_crm` approve, and the service asks
  `canAdminister` again before calling `phoenix_crm_review_visit_recording`, which locks the row and
  refuses a second decision.
- **The Needs You board carries the count** to his own lane, linking to the Visit Recording page, and
  asks for it only when `canAdminister` is true.
- **The rep sees "Your visit is pending admin approval"** — the owner's own words, the same day ("but
  she can do the next visit if i not appriove yet but all keeps in pending until i confirm and hsow here
  ur visit is pending admin approval"). It is in the saved note and on the visit's own row on his list
  (`recordingReview`, sent to every reader, never the length or the audio), and the row changes to
  "Approved — it counts" or "Not approved — it does not count" once he decides. An out-of-plan visit
  says it in its step pill instead, so it is never said twice. It names a role, never a person and
  never a check (Golden Rule #1).
- **It never blocks the next visit.** The recorder resets after every save, each visit records its own
  conversation, and nothing in the save path reads an earlier visit's approval — every one stays
  pending until he decides.

Decisions made without asking him, each easy to change:

- The Administrator decides first, then the usual off-plan chain runs.
- His refusal refuses the visit outright.
- ~~The rep is not sent a notice of his decision; his list shows it.~~ **Reversed 2026-10-17**, see below.

Files: `supabase/migrations/20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql`,
`app/api/phoenix-crm/recording/admin/review/route.ts`, plus the changes in `visit-recordings.ts`,
`visits.ts`, `unplanned.ts`, `unplanned-rules.ts`, `needs-you.ts` and `visit-recording-admin.tsx`.

## His decision carries a comment, and it is told by Telegram, in-app and the phone (email ended 2026-11-06)

Added 2026-10-17, his words:

> "i want to be able to reject or approve with a comment and this comment goes email and telegram to
> the rep and his manager and his manager of manager"

What changed:

- **The comment.** On the Visit Recording page, Approve and Refuse both open the comment box.
  A refusal still needs one (the database refuses a refusal with no note); an approval may carry one.
  The comment is the recording row's `review_note`, which the database already accepted on an approval,
  so there is no migration.
- **Who is told.** `recordedVisitDecisionDeliveries` in `server/notifications.ts`: the rep, and the
  two occupied manager seats nearest above him in `managerChain` (RECORDED_VISIT_DECISION_MANAGER_LEVELS = 2) —
  his manager and his manager's manager. A vacant district passes upward, the chain never reaches the
  CEO, nobody is named twice, and the decider is not told his own decision. Where the second seat is the
  national manager (a line with no regional manager) he is told as the manager's manager; where there is
  a regional manager, the national manager above that is not.
- **How.** In-app, Telegram and the phone. It also went by email from 2026-10-17 until 2026-11-06, when the
  owner cut every Phoenix CRM email ("never sent a single email once again, it only sends telegram and push
  and in app"): `PHOENIX_CRM_EMAIL_EVENT_TYPES` is empty and its policy row asks for no email.
- **Golden Rule #1.** The rep reads "The Administrator approved / did not approve your visit to …" and the
  comment — a decision and a role, never that it was recorded, listened to or checked. His list already
  showed the decision; this adds the comment.
- **It runs after the decision is saved and never throws**, so a failed send cannot undo it, and only
  for a live team (the same gate as every Phoenix CRM notice).

Decisions made without asking him, each easy to change: the approval comment is optional; "his manager's
manager" is the second occupied seat in the chain, not the whole chain; the phone is included, as for every
other Phoenix CRM notice.
