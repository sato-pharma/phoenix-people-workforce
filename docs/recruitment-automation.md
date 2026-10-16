# Recruitment automation — requisitions open and close themselves, CVs are placed by one press

The owner, 16 Oct 2026: *"I want all this process to be automated, opening requisition and the end
to end cycle, I don't want manual work in the recruitment."* Asked how, he answered:

| Question | His answer |
| --- | --- |
| Opening | Raise and open it at once |
| Approval | Nothing needs approval |
| The middle | The system screens, matches and recommends; one click from Admin or Talent Acquisition attaches the CV, keeps it shortlisted, or rejects it |
| Closing | Close it as Filled automatically |
| Who presses | Admin or TA |
| Reject | Never recommend Reject |
| Place | WhatsApp screening answers first; without one, the governorate in the CV |
| Owner of an opened requisition | Yomna Gamal (the Talent Acquisition seat, read from the `HR Resourcing` role) |
| Notice when one opens | No notice |

## The pieces

- `src/lib/recruitment/requisition-autopilot.ts` — the pure plan (`planRequisitionAutopilot`) and its
  runner. Hourly on :27 through `app/api/cron/recruitment-requisition-autopilot` (cron-job.org,
  armed on merge by `cron-autoarm.yml`; `?dryRun=1` writes nothing).
- `src/lib/recruitment/requisition-match.ts` — the recommendation, reusing `statedSeatQueueMatch` and
  `suggestPositions` rather than a second matching rule.
- `src/lib/recruitment/requisition-attach.ts` and `POST /api/recruitment/candidates/[id]/attach-requisition`
  — the one press: `createApplication` (refuses a duplicate, tells the requisition's hiring manager)
  then the CV is shortlisted.
- `src/components/recruitment/workstation/requisition-recommendation-band.tsx` — the band under the
  screening decision bar.

## What the first run does, measured by a dry run on 16 Oct 2026

31 requisitions opened, 3 filled (REQ-2026-ZG3KNZ, REQ-2026-N56WAM, REQ-2026-BS6QLP — each on a seat
row already `filled`), 10 seats left alone: 7 parked, 3 replacements for somebody still employed
(Dakahlia 3, Assuit 1, and one with area "Unknown Area"). The empty Head Office Office Coordinator
seat is covered by the seatless REQ-2026-61D5A3, so no second requisition opens for it.

## Deliberate limits

- A draft a person raised is never opened or closed — it is their unfinished work. The autopilot's
  own drafts (note "Opened automatically when the seat became empty.") are opened on the next run.
- A requisition is filled only when its seat row is `filled` AND names who filled it. Nothing is
  ever cancelled automatically.
- At most 6 openings a run (`MAX_OPENINGS_PER_RUN`), so the first-day backfill of 31 takes about six
  hourly runs.
- One active requisition per seat row is also held by the database: the partial unique index
  `ats_requisitions_one_active_per_vacancy` (migration 20261016103744, applied to staging and
  production 16 Oct 2026).
- A seat the Vacancy Report does not list as open is reported (`not_in_vacancy_report`), never
  opened.
- A parked seat (`isParkedSeat` in `src/lib/hr/today-tasks.ts`) is never opened.
- A replacement opens only once the person replaced has left (`requisitionOpenBlock`).
- One requisition per seat across its vacancy rows (`vacancySeatKey`: `seat_id`, else line, area and
  position ids, else vacancy code). A seatless requisition covers one empty seat with its title.
- A CV already hired, rejected or with a manager gets no recommendation.
