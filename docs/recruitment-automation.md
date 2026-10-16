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

## Why a head-office requisition could not be reached at all (16 Oct 2026)

The Product Manager requisition raised that afternoon (`REQ-2026-SV54HH`), the Training Manager one
(`REQ-2026-IEILI2`) and the seatless Office Coordinator one all stood open while **not one of the 593
CVs** on the screening page could be recommended to any of them. Two independent causes:

**1. A company-wide "area" is not a place.** The matcher places a CV by the area the applicant tapped
on WhatsApp, and of the 44 seats the screening page offers, five carry an area that is not a place a
person lives: Product Manager reads **Egypt**, Office Coordinator and Training Manager read **Head
office**. Nobody taps "Egypt" on WhatsApp and no CV's governorate says "Head office", so the place
test could only ever answer no — and the rescue that handles a placeless seat by the job alone never
fired either, because it asks for `areaName === null` and these arrive carrying a name.
`COMPANY_WIDE_AREA_NAMES` in `requisition-match.ts` blanks them before matching. The other two of the
five — the District Sales Manager seats whose area merely repeats their region, **Cairo** and
**Alex-BHR** — are real places and are deliberately left out: blanking those would offer a Cairo seat
to a candidate from anywhere, which is the precision the WhatsApp answer exists to protect.

**2. A seat title with no job family is answered with silence.** `TITLE_FAMILIES` in
`position-suggestion.ts` had no family for **Product Manager** or **Training Manager**, and a title
the table does not know is read as "a job we are not hiring for" — a deliberate rule, and the right
one for the primary lawyer in Nasr City it was written for. So every such CV came back `keep` while
its own requisition was open. Two families were added:

- **Marketing** (`product manager`, `product group manager`, `brand manager`, `marketing manager`,
  `group marketing`), placed **above** the rep family. An Egyptian product manager is almost always
  an ex-representative and usually a pharmacy graduate, and the rep family claims a CV on the word
  "pharmacist" alone — so below it, the fix would have done nothing for the people it is for.
- **Training**, narrow to the managing and specialist forms (`training manager|specialist|supervisor|
  head|officer|lead`, `learning and development`, `l&d`, `sfe manager|supervisor|specialist`), so a
  representative who trains in the field stays a representative.

**The effect, measured on the live pool before and after:** 220 attach / 373 keep → **223 / 370**, and
the Product Manager requisition goes from **0** CVs to **5** — Marco Maher, Heba Magdy, Dr. Wedad
Samir Harb (Group Product Manager), Ireny Wahba Halim and Waleed Ahmed Sedek; four of them named
Product Manager as the job they applied for. Nothing widened elsewhere.

**The standing lesson: a seat opened with a new job title needs its family in the same change.**
Otherwise the requisition opens, the screen offers the seat, and every CV for it is told "keep".
Pinned by `tests/recruitment-automation.test.ts`, whose assertions were break-tested one half at a
time (removing either half returns `keep`; removing the training family alone returns `[]`).
