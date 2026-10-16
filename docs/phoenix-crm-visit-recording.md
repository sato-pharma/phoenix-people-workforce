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
  - The rep never hears it: `loadVisitDay` does not even ask whether a recording exists for the rep,
    and `recording/play` answers 404 to anybody else.
- **Who manages it.** `canManageVisitRecording` allows the Super Admin, never a test persona. It is
  checked on the page and inside every admin service. Delete goes through the Storage API, then stamps
  `deleted_at` and `deleted_by_hr_id` on the row, so the visit reads as recorded and then deleted.

## Files

- `supabase/migrations/20261016103743_phoenix_crm_visit_recording.sql`: the two tables, the bucket and
  the claim function.
- `src/lib/phoenix-crm/visit-recording-rules.ts`: pure; the bounds, wording and view types.
- `src/lib/phoenix-crm/server/visit-recordings.ts`: the only file that opens the bucket.
- `app/api/phoenix-crm/recording/**`: five POST routes.
- `src/components/phoenix-crm/visit-recording-gate.tsx`, `visit-recording-store.ts`,
  `visit-recording-admin.tsx`.
- `app/(admin)/admin/field-crm/visit-recording/page.tsx`.
- Pinned by `tests/phoenix-crm-visit-recording.test.ts` and `tests/phoenix-crm-boundary.test.ts`.
