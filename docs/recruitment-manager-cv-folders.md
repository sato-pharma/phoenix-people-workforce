# Manager CV folders — filled by sends, never by a rule

Owner, 2026-10-16: *"now no more managers receive CVs automatic. Every manager has an empty folder
for every area in his region, based on the organogram. The TA or admin pushes a CV whenever needed
and can any time get it back. When the CV reaches the managers there is no restriction — they can
download, see the number, do anything. Make for every manager a small row in their overview holding
folders of the CVs. The folder pumps notifications and never stops until the CV is seen."*

## What changed

| Before | Now |
| --- | --- |
| A sweep of the whole CV pool placed each applicant in the folders of the managers whose areas matched (declared area, address, governorate) — the manager received CVs nobody sent. | Nothing is placed by a rule. A folder holds a CV only because a person sent it to that manager (`ats_candidate_manager_sends`). |
| A district manager's shelf was his district's areas. | Same, and a regional or national sales manager holds **every area beneath him**, merged into one board. The CEO holds none. |
| A manager's phone number was hidden until "I will call", the file download was blocked, a Skip button hid the CV. | A CV that reached the manager is unrestricted: number visible, file downloadable, no reservation step. |
| A manager's Return was remembered as a suppression. | A Return **deletes his own send**; a re-push by Talent Acquisition is a new send and brings the CV back. |
| The first alert was the only alert. | The folder reminds hourly until the CV is opened (below). |

## The pieces

- `src/lib/recruitment/manager-cv-folders.ts` — **pure**. `managerFolderShelves` (the empty shelves off
  the organogram, one folder per area plus **Other CVs**), `fillShelvesFromSends`, `chooseFolderForPush`
  (recruiter's choice, else the position's area, else the applicant's declared area, else the area the CV
  names, else Other CVs — always one of the manager's real folders), `isSendUnseen`, `unseenIdsOnBoards`,
  `summarizeManagerFolders`, `unseenSendsByManager`, `isReminderHour`, `reminderHourBucket`.
- `src/lib/recruitment/district-manager-folders-db.ts` — the readers. Reads sends, then only the
  candidates those sends name; never the pool. `isCandidateInViewerDistrict[Scope]` ask
  `isCandidateSentToManager`, so the folder, the gate and the reminders read one fact.
- `src/lib/recruitment/manager-recall.ts` + `POST /api/recruitment/candidates/[id]/recall-from-manager`
  — **taking a CV back**: deletes the (candidate, manager) send, repoints or clears the legacy
  `manager_notified_*` stamp, and moves a CV nobody holds from `sent_to_manager` back to `shortlisted`.
  Recruiting seats only (`recruitment:update`). The pool row carries an **Undo** control beside Send.
- `sendCandidatesToManager(…, folderArea?)` and both `notify-manager` routes take an optional
  `folderArea`; the response carries `folders` so the confirmation says which folder the CV landed in.
- `src/lib/recruitment/manager-cv-reminders.ts` + `GET|POST /api/cron/recruitment-manager-cv-reminders`
  — hourly at :41 (cron-job.org, armed on merge by `cron-autoarm.yml`). Heartbeat slug
  `phoenix-recruitment-manager-cv-reminders`. `?dryRun=1` sends nothing.
- `src/components/employee-portal/dashboards/manager-cv-folders-row.tsx` — the overview row on the
  district, regional and national sales manager landing pages (`snapshot.cvFolders`).

## Hiding a CV

Owner, 2026-10-16: *"make district manager able to hide the CV if he received him."* Every CV card in a
manager's portal carries a **Hide** button. One press, no reason: `POST
/api/recruitment/hiring-manager/candidates/[candidateId]/hide` runs `hideCandidateFromManager`, which is
the recall (`manager-recall.ts`) aimed at the caller's OWN hold - his send is deleted, the legacy stamp is put
right, and a CV nobody else holds goes back to `shortlisted` with the note "Hidden by <name>". It leaves
his folders, his Sent-to-you list and the hourly reminder together. Hide rejects nobody and answers no
recruiter (Skip does that); Talent Acquisition keeps the CV and a re-push brings it back. The manager is
the session's, never a posted id, and the CV must have been sent to him.

**Why the reminder looked like CVs still arriving (2026-10-16).** Nothing is placed by a rule any more
(no send since 1 September in production), but the hourly reminder names every CV a folder holder has
not opened, with no age limit - 12 CVs sent 26-31 August were still pinging four managers every hour
(57 notifications that day). Hide is the way out of that list.

## The reminder rules

- **Hourly, 08:00–21:59 Cairo** (`REMINDER_FIRST_HOUR_CAIRO`, `REMINDER_LAST_HOUR_CAIRO`). Night is silent;
  the job still pings its heartbeat so the check stays a straight hourly one.
- **One message per manager**, naming every CV he has not opened. In-app, Telegram and push — **never
  email**. The event type is `candidate_assigned`, which `enforceCandidateAssignedEmailBlock` strips of
  email in any case.
- **"Seen" means opened**: his `ats_candidate_views.last_seen_at` at or after the send. A re-push after
  an old open is unseen again. Opening the *folder* is not seeing the CV.
- **Only managers who hold folders** are reminded; a head-office manager gets the one alert the send
  itself raises.
- **A new notification row every hour**: the idempotency key carries the hour bucket, because the same
  key would overwrite the previous reminder and keep its read state.
- **It stops** when the CV is opened, when Talent Acquisition takes it back, when he returns or hides it, or
  **7 days after the send** (owner, 2026-10-16: "stop the folder reminder after 7 days" -
  `REMINDER_MAX_DAYS`, `isWithinReminderWindow`). The CV stays in the folder; only the nag ends. There is no
  45-day end for a manager who holds folders (decision 4).

## Decisions taken without a question (owner can reverse any)

1. A return or skip is not remembered; it deletes his send.
2. The folder is stored in the send's `sent_for_area`.
3. Quiet hours 21:59 → 08:00 Cairo (owner, 2026-10-16: "yes").
4. **The 45-day auto-return is LIFTED for a manager who holds folders** (owner, 2026-10-16: "lift it"). He keeps a
   CV until Talent Acquisition takes it back or he returns it. Any other manager keeps the 45 days.
   `folder-holders.ts` answers who holds folders, from the organogram; every place the window is read asks it
   (see recruitment-manager-hold-window.md).
5. The team view *above* the holder (a national manager reading a district manager's folder) keeps its
   redaction; only the holder's own view is unrestricted (owner, 2026-10-16: "no").
6. A CV attached to a requisition still notifies that requisition's hiring manager as before; that path
   is not a folder.

## Where it is pinned

`tests/recruitment-manager-cv-folders.test.ts` (registered in `tests/run-tests.ts`): empty shelves, the
three shelf shapes, filing by send and by folder choice, the choice order, seen/unseen, the reminder
grouping and its Cairo hours, and a source pin per route / job / screen. The older suites that pinned the
derived folders were rewritten to the send-driven shape: `tests/district-manager-folders.test.ts`,
`tests/recruitment-district-returns.test.ts`, `tests/recruitment-manager-hold-window.test.ts`,
`tests/candidate-call-claims.test.ts`.
