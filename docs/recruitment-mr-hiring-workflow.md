# Medical Rep hiring — the 8 November 2026 workflow

From **Sunday 8 November 2026** every Medical Representative hire follows the owner's email to the managers
("Dear Managers, Effective Sunday, 8 November 2026…", sent 7 November 2026), plus the RSM section he added the
same afternoon. This page maps each section of that email to the part of Phoenix that carries it, records the
owner's answers to the questions the email left open, and names the design decisions made while building it.

Code: `src/lib/recruitment/mr-hiring/` (domain), `src/components/recruitment/mr-hiring/` (screens),
`app/(admin)/recruitment/mr-hiring/` and `app/api/recruitment/mr-hiring/` (page and routes). Module memory:
`.claude/rules/recruitment-mr-hiring.md`.

## The steps on screen

One vocabulary everywhere — the page, the drawer, the portal panel, the workspace strip and the notices
(`vocabulary.ts`):

| # | Step | Email § | What moves it on |
| --- | --- | --- | --- |
| 1 | New CV · HR screening | 1–3 | HR: Pass / Keep as backup / Do not pass |
| 2 | 1st interview · HR | 3, 5 | Book → interview → HR's result |
| 3 | 2nd interview · DSM | 4, 5, 6 | Book (sends the CV to the DSM and notifies him) → the DSM's feedback, or HR decides without it |
| 4 | RSM interview · Pedia line | RSM section | Only when HR books it (see below) → the RSM's evaluation |
| 5 | 3rd interview · HR Manager | 7 | Book → the HR Manager's result |
| 6 | Final interview · NSM (or Joint final · HR Manager + NSM) | 7 | Book → result |
| 7 | NSM recommendation | 8 | The NSM: Make an offer / Keep as backup, with the salary and the joining date |
| 8 | Final decision | 9 | The HR Manager: Make an offer / Keep as backup / Do not pass |
| 9 | Offer | 9 | Offer drafted → sent → accepted / declined / expired → Mark as hired |
| — | Closed: Hired · Kept as backup · Rejected · Held (not on a company WhatsApp) | 2 | |

Every result uses the same three words — **Pass · Keep as backup · Do not pass** — and every result carries a
comment, because the email says the evaluation is written on the candidate's CV.

**The stage is derived, never stored** (`stage.ts`, `mrHiringStage`): it is read from the candidate's status,
bookings, step results, recommendation and linked offer each time. The workspace's own reject, the offer
outcome sync and Mark as hired therefore move it without any second write that could drift.

## Section by section

- **New CVs only** (owner, 7 Nov 2026). The workflow holds only CVs received from Sunday 8 November 00:00
  Cairo (`vocabulary.ts`, `isInMrWorkflow`). A candidate received before it is not on the page, has no journey
  there and no step can be recorded or booked for them; the workspace draws no step line on them, and they
  finish in the workspace as before. On the day it shipped, the page had listed 54 candidates the old flow had
  already shortlisted or sent to a manager as "Screen the CV".
- **§1–2 One channel.** Both company WhatsApp lines count as official (owner, 7 Nov 2026: 01159888247 and
  01098500699). A Medical Rep CV received from 8 November 00:00 Cairo by email, the website or by hand is
  **held** ("Held · not on a company WhatsApp") and not considered (`official-line.ts`, `isHeldOffChannel`).
  A CV from before the start is never held.
- **§3 Screening and the 1st interview.** HR screens. The 1st interview is **in person for a candidate in Cairo
  or Giza, on Zoom for anyone else**: the question is pre-filled from the candidate's governorate (English or
  Arabic spelling) and HR confirms it. The company's Giza *region* is never used — it also covers Beni Suef and
  Fayoum. The Zoom link comes from the Sato Pharma Zoom account automatically.
- **§4 The DSM receives the CV through Phoenix.** Booking the DSM round sends the CV to that DSM through the
  existing Send to manager door and notifies him (in-app, push and Telegram — never email).
- **§5 Interview details.** Every interview carries its Zoom link, or its date, time and place. The interview
  calendar's dialogs gained a Location field for in-person interviews, and the candidate's invitation prints it.
- **§6 DSM feedback is mandatory.** The DSM records it from the manager portal's "My Medical Rep interviews".
  **HR may decide without it any time after the DSM interview has ended** (owner, 7 Nov 2026 — no deadline);
  the result is marked "no DSM feedback". The no-feedback path is the DSM step's only.
- **RSM section (added 7 Nov 2026).** "Candidates who pass the DSM interview will proceed to an RSM interview
  (Pedia Line). The RSM will receive the interview details through Phoenix and must submit their evaluation in
  the system." See the decision below.
- **§7 The HR Manager's 3rd interview and the NSM's final — or one joint final.** The joint final replaces both,
  and the 3rd interview then shows as skipped.
- **§8 The NSM's recommendation.** Make an offer or keep as backup, with the proposed salary (EGP net a month)
  and joining date. The HR Manager is notified that a recommendation is ready.
- **§9 The decision and the offer.** **The final decision is the HR Manager's alone** (owner, 7 Nov 2026 — the
  Super Admin seat). "Prepare offer" opens the offer composer with the proposed joining date as the start date;
  money is never pre-filled, because pay stays fixed by title. An offer still "sent" past its last valid day
  reads as expired — shown only, nothing changes.
- **§10 One timeline, salary hidden.** Everyone involved reads the candidate's hiring journey. **The proposed
  salary leaves the server only for the HR Manager, Talent Acquisition and the NSM who wrote it** (owner,
  7 Nov 2026); everyone else, the CEO included, receives the recommendation without it.

## Decisions made while building

- **"If applicable" means "HR booked it".** Every Medical Rep area exists on all three lines
  (`au_v_line_area_map`, checked 7 Nov 2026), so Phoenix cannot tell from the area whether a candidate is for
  the Pedia line. The RSM step is therefore **offered to HR after the DSM passes, until the 3rd interview is
  booked**; with no RSM interview booked it shows as "not needed (Pedia line only)" and the candidate goes on
  to the 3rd interview. Once booked, the RSM's evaluation is mandatory like every other round's, and the 3rd
  interview waits for it. Booking the RSM interview notifies the RSM; it does **not** send the CV to the RSM,
  which would move it away from the DSM it was sent to.
- **Who records the RSM's evaluation:** the RSM on that interview, or the HR Manager (the same rule as the
  3rd interview and the final). Talent Acquisition, another RSM, the DSM and the CEO cannot.
- **No round is chosen on the interview calendar.** The calendar takes a location, but rounds are booked only
  from the Medical Rep Hiring page, so the step checks, the DSM's CV send and the notices cannot be skipped.
- **A result writes the calendar's outcome too** (pass → shortlisted, backup → backup, do not pass →
  rejected), so the amber "Outcome?" flag, the daily nag and the automatic outcome settling agree with it.
  Nothing is ever sent to the candidate automatically.
- **The notices never email anyone**, each has its own `recruitment.<event>` policy row so the recruitment
  email default never applies, and the idempotency key carries the seat so two groups of one never collide.

## Who sees what

| Seat | Page | Records |
| --- | --- | --- |
| HR Manager (Super Admin) | Medical Rep Hiring, all candidates, with the salary | Screening, 1st interview, his own interviews, the RSM / 3rd / final results, the decision |
| Talent Acquisition (HR Resourcing) | Medical Rep Hiring (`/hr/recruitment/mr-hiring`), with the salary | Screening, 1st interview, bookings, no-DSM-feedback decisions |
| CEO | Medical Rep Hiring, read only, no salary | Nothing |
| DSM, RSM, NSM | "My Medical Rep interviews" on the manager portal, their own candidates | Their own interview's feedback or evaluation; the NSM's recommendation |

## Database

- `20261107123708_ats_mr_hiring_workflow.sql` — `interview_round` and `location` on `ats_interview_bookings`;
  the append-only `ats_mr_hiring_step_results` and `ats_mr_hiring_recommendations` (service role only).
- `20261107132746_ats_mr_hiring_rsm_round.sql` — adds `rsm` to the two allowed-value lists.

Both were applied to staging and production on 7 November 2026 and read back from the catalog.

## Tests

`tests/recruitment-mr-hiring-stage.test.ts` (every step and state, the hold, the RSM step),
`tests/recruitment-mr-hiring-access.test.ts` (who records each step, the salary, who reads the journey) and
`tests/recruitment-mr-hiring-booking.test.ts` (Cairo/Giza, the DSM's CV send, the notices).
