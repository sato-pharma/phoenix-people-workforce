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
| 4 | RSM interview · Pedia line | RSM section | Only when HR confirmed the Pedia line at the 1st interview, in an area of the RSM's regions (see below) → book → the RSM's evaluation |
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

- **CVs from 7 November** (owner, 7 Nov 2026: first "New CVs only", then "all the cvs recieved starting from
  7 nov"). The workflow holds only CVs received from Saturday 7 November 00:00 Cairo (`vocabulary.ts`,
  `MR_LIST_FROM`, `isInMrWorkflow`). A candidate received before it is not on the page, has no journey there
  and no step can be recorded or booked for them; the workspace draws no step line on them, and they finish in
  the workspace as before. The one-channel hold (§2) still starts with the workflow on Sunday 8 November, so a
  CV that came by email on the 7th is listed and never held. Before the cut-off, the page had listed 54
  candidates the old flow had already shortlisted or sent to a manager as "Screen the CV".
- **§1–2 One channel.** Both company WhatsApp lines count as official (owner, 7 Nov 2026: 01159888247 and
  01098500699). A Medical Rep CV received from 8 November 00:00 Cairo by email, the website or by hand is
  **held** ("Held · not on a company WhatsApp") and not considered (`official-line.ts`, `isHeldOffChannel`).
  A CV from before the start is never held.
- **§3 Screening and the 1st interview.** HR screens. The 1st interview is **in person for a candidate in Cairo
  or Giza, on Zoom for anyone else**: the question is pre-filled from the candidate's governorate (English or
  Arabic spelling) and HR confirms it. The company's Giza *region* is never used — it also covers Beni Suef and
  Fayoum. The Zoom link comes from the Sato Pharma Zoom account automatically.
- **The 1st interview may also be a phone call** (owner, 7 Nov 2026: "only for hr first interview u will add a
  third option which is phone call"). HR picks it as the third tile beside In person and Zoom; it needs no
  Cairo-or-Giza answer, keeps no place and makes no Zoom meeting, and the notice and invitation say "by phone
  call". **HR is never asked its length** (owner, 7 Nov 2026: "don't ask him to choose the length of the
  call"): the Length question disappears and the call holds 30 minutes on the calendar (`MR_PHONE_CALL_MINUTES`),
  whatever length a request sends. No other interview may be a phone call — the Medical Rep page refuses it for every later round, and
  the interview calendar's own booking and move routes refuse it too (`phoneCallRefusal`). A session (one
  meeting for many candidates) is never a phone call; the database allows `phone` on a booking only.
- **The 1st interview's result confirms the area and the line** (owner, 7 Nov 2026: "make the HR able to
  confirm the location … the candidate is applying to, and the line"). The area is chosen from the WhatsApp
  bot's own list of Medical Rep areas, grouped by region (`areas.ts`) — never typed — and the server refuses a
  name that is not on it. The line is Pedia, Anti Infective or CNS. A pass needs both; a backup or a "do not
  pass" may carry them. The confirmed area wins over the workspace filing on the page, and the line rides on
  every later interview booking.
- **Interviews on any day.** The interview calendar opened Friday and Saturday on 7 Nov 2026 (owner: "remove
  this Interviews are booked Sunday to Thursday only. make able to schedule any day in the week"): every day,
  and the evening reminder looks to the very next day.
- **Interviews at any time of day.** The same day the owner quoted the old refusal "An interview starts at
  9:00 AM or later and ends by 5:00 PM." and answered "make hr freely add any time": an interview or session
  starts at any minute and must end by midnight Cairo (`isBookableWindow`). HR types the time in a time field
  (`TimeOfDayInput`); the week grid opens on 9:00 AM to 5:00 PM and widens to reach anything booked outside it.
- **§4 The DSM receives the CV through Phoenix.** Booking the DSM round sends the CV to that DSM through the
  existing Send to manager door and notifies him (in-app, push and Telegram — never email).
- **§5 Interview details.** Every interview carries its Zoom link, or its date, time and place. The interview
  calendar's dialogs gained a Location field for in-person interviews, and the candidate's invitation prints it.
- **§6 DSM feedback is mandatory.** The DSM records it from the manager portal's "My Medical Rep interviews".
  **HR may decide without it at any time** — before the interview's hour, after it, or after the DSM answered
  (owner, 8 Nov 2026, replacing 7 Nov's "after the interview has ended"); the result is marked "no DSM
  feedback". The no-feedback mark is the DSM step's only.
- **RSM section (added 7 Nov 2026).** "Candidates who pass the DSM interview will proceed to an RSM interview
  (Pedia Line). The RSM will receive the interview details through Phoenix and must submit their evaluation in
  the system." See the decision below.
- **§7 The HR Manager's 3rd interview and the NSM's final — or one joint final.** The joint final replaces both,
  and the 3rd interview then shows as skipped.
- **§8 The NSM's recommendation.** Make an offer or keep as backup, with the proposed salary (EGP net a month)
  and joining date. The HR Manager is notified that a recommendation is ready.
- **§9 The decision and the offer.** **The final decision is HR's — the HR Manager or Talent Acquisition**
  (owner, 8 Nov 2026, replacing 7 Nov's "the HR Manager's alone"; see "Everything is open to HR" below). "Prepare offer" opens the offer composer with the proposed joining date as the start date;
  money is never pre-filled, because pay stays fixed by title. An offer still "sent" past its last valid day
  reads as expired — shown only, nothing changes.
- **§10 One timeline, salary hidden.** Everyone involved reads the candidate's hiring journey. **The proposed
  salary leaves the server only for the HR Manager, Talent Acquisition and the NSM who wrote it** (owner,
  7 Nov 2026); everyone else, the CEO included, receives the recommendation without it.

- **The CV and the application at every step, for everyone** (owner, 7 Nov 2026). The hiring journey sheet
  carries the candidate's CV and their application — every question and answer, under the labels the
  workspace's Medical Rep tab uses — whatever step they are on. A wide screen (1024px and up) is three panes
  (owner, 7 Nov 2026): the CV on the left, the application and the WhatsApp replies in the middle, the journey
  on the right as it was, so the CV stays in view while a result is written. A phone keeps one column, under
  the current step. Each question is said once — by its row, never again inside the answer box. It is read from
  `/api/recruitment/mr-hiring/[candidateId]/cv`, which admits exactly the people who read the journey. The
  DSM's feedback, the RSM's evaluation and the NSM's result and recommendation open in that sheet. A manager
  reads the CV with the phone numbers masked and no download (the manager portal's own rule — HR books every
  Medical Rep interview); the HR Manager, Talent Acquisition and the CEO read it in full.

## Decisions made while building

- **"If applicable" means "HR confirmed the Pedia line".** Every Medical Rep area exists on all three lines
  (`au_v_line_area_map`, checked 7 Nov 2026), so Phoenix cannot tell from the area whether a candidate is for
  the Pedia line — HR says it at the 1st interview's result. **The RSM step appears only when that line is
  Pedia** (owner, 7 Nov 2026: "by default, it is not appearing. It only choose if the talent acquisition or the
  HR doing the first interview choose that this is PD-align"). Off the Pedia line the journey shows eight
  steps and the candidate goes from the DSM straight to the 3rd interview; on it, nine, and after the DSM
  passes HR books the RSM interview, whose evaluation is mandatory, and the 3rd interview and the joint final
  wait for it. An RSM interview booked before the line was asked keeps its step, so nothing that happened
  disappears. Booking the RSM interview notifies the RSM; it does **not** send the CV to the RSM, which would
  move it away from the DSM it was sent to.
- **Only inside the RSM's regions** (owner, 7 Nov 2026: "the step of the regional manager in Pedia is only if
  this candidate is in … one of the regions of this regional manager"). The organogram answers: the area HR
  confirmed → its Pedia district seat (`au_v_line_area_map`) → its parents (`au_v_org_tree_sales`). The step
  appears only when that climb reaches an occupied RSM seat before the NSM (`mrSeatUnderRsm`,
  `loadPediaAreasUnderRsm`). Measured 7 Nov 2026: 17 of the 49 Pedia areas sit under the RSM, and the other 32
  sit directly under the NSM, so a Pedia candidate there goes from the DSM straight on to the 3rd interview.
- **Who records the RSM's evaluation:** the RSM on that interview, or the HR Manager (the same rule as the
  3rd interview and the final). Talent Acquisition, another RSM, the DSM and the CEO cannot.
- **No round is chosen on the interview calendar.** The calendar takes a location, but rounds are booked only
  from the Medical Rep Hiring page, so the step checks, the DSM's CV send and the notices cannot be skipped.
- **A result writes the calendar's outcome too** (pass → shortlisted, backup → backup, do not pass →
  rejected), so the amber "Outcome?" flag, the daily nag and the automatic outcome settling agree with it.
  Nothing is ever sent to the candidate automatically.
- **The interview notices never email anyone**, each has its own `recruitment.<event>` policy row so the
  recruitment email default never applies, and the idempotency key carries the seat so two groups of one never
  collide.
- **The area's manager hears of a candidate HR passed** (owner, 7 Nov 2026: "the manager of this area must
  receive in-app, telegram and email … the managers must be informed in all ways", plus "a small banner … in
  their overview dashboard, so when they log in, they notice"). His answers: the area's DSM on the line HR
  confirmed, or the line's NSM where the area has no real DSM (an "Others" bucket or a vacant seat); and only
  when HR **passes** the candidate at the 1st interview. It goes to the bell, push, Telegram and email — the one
  Medical Rep notice that emails, by his word — and stays on a banner at the top of his portal home until he
  presses "Got it" (21 days at most). It names the candidate, the area and the line, never the CV or money.
- **HR changes a booked interview's time** (owner, 7 Nov 2026: "make me able to change this time"). "Change
  the time" on the hiring journey moves the day, the time, the length and the way or place of the interview the
  current step is booked on, while no result is in — a phone call nobody answered is moved, not failed. The
  interviewer and the round stay. Everyone on it is told "Interview moved" with the old and new time.

- **Every comment box has a microphone** (owner, 7 Nov 2026: "make the same mic so I can talk and it is
  written instead of me typing") — the result's comment, the NSM's recommendation note and the notes for the
  interviewer. "Speak" opens the Phoenix CRM visit form's own speech engine (Egyptian Arabic, English words
  mixed in); each phrase is added to what is already typed, never replacing it. Nothing is recorded. A
  browser with no speech engine (Firefox) shows the plain box.

- **Then the words are professionally rewritten** (owner, 8 Nov 2026: "it fix the spelling and the
  grammar … like ChatGPT … rephrase it into professional corporate language"). When the speaker presses Stop,
  what he said in that turn goes to `POST /api/recruitment/mr-hiring/[candidateId]/polish`
  (`src/lib/recruitment/mr-hiring/polish.ts`, through the one AI door) and comes back as clear professional
  wording in place of the raw words, with "Keep my own words" to put them back. What was typed before Speak
  is never sent or changed, and the candidate's name is never sent. The box keeps the words exactly as
  spoken when the rewrite fails, when it carries a number that was not said (Arabic digits count as said),
  when it names how it was written, or when the speaker edited the box while it was away. Only someone who
  reads the candidate's journey and can write on it may call it — the CEO, who records nothing, is refused.
  Nothing is saved until the form's own Save.
- **The rewrite is Claude Sonnet's** (owner, 8 Nov 2026: "put an Anthropic Sonnet agent … the agent you added
  is very weak. It doesn't change anything"). It first shipped on the cheap nano tier, which only touched the
  words up. Now Claude Sonnet is asked first and OpenAI's strong model only when Claude's account is dead, with
  an instruction to rewrite fully: reorder the points, drop the filler. A small number said
  as a word ("خمسة" → 5) and a number said with ألف ("15 ألف" → 15,000) count as said. A refused rewrite now
  leaves one row in the error table (route `/ai/recruitment/mr-hiring-dictation-polish/refused`) naming the
  reason, the model and the box, never the words.
- **It knows the words of Egyptian pharma hiring** (owner screenshot, 8 Nov 2026): امتياز is the internship
  year (it had come back as "franchise"), تكليف the government assignment, دعاية medical promotion. The list is
  in the rewrite instructions in `polish.ts`; a word it keeps getting wrong goes there.
- **It keeps the language that was spoken** (owner, 8 Nov 2026: "I needed to be able to understand Egyptian
  Arabic and enhance the Egyptian Arabic"). Egyptian Arabic comes back as clear, professional written Arabic,
  with the English work terms the speaker mixed in (attitude, language, accent, communication) in English
  letters, even when the speech engine wrote them in Arabic letters (الاتيتيود, اللانجوج). English speech comes
  back as professional English. It never translates the whole comment into the other language.

## Everything is open to HR (owner, 8 Nov 2026)

His words, after an interview held the day before it was put in the system was refused: "don't block anything
to me, make everything open to the HR … Everything is open." So the two HR seats (the HR Manager and Talent
Acquisition) are never held by the clock, the booking or the seat:

- They record every step's result at any time — before the interview's hour, after it, or with no booking at
  all (an interview held before it was booked). That covers the DSM's step (marked "no DSM feedback"), the
  RSM's, the 3rd interview, both kinds of final, the NSM's recommendation and the final decision.
- They book and move an interview on any day and at any time, a past one included: the Medical Rep booking
  form has no earliest day, the calendar's cell and schedule dialogs no longer refuse a time already gone, and
  the calendar lets the booking tier move a past interview. A past proposed joining date is taken.
- What stays: the order of the steps (a result is recorded at the step the candidate is on), the held CVs, a
  hired candidate, and the managers' own gates — a DSM, RSM or NSM records only his own interview, once it
  has ended, and never the final decision.

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
- `20261107191445_ats_mr_hiring_phone_and_confirmed_line.sql` — `phone` as a booking platform; the nullable
  `confirmed_area_name` and `confirmed_line` on `ats_mr_hiring_step_results`, filled by the 1st interview's
  result only (a check refuses them on any other step).

- `20261107202920_ats_mr_area_manager_notices.sql` — `ats_mr_area_manager_notices`, one row per manager told
  of a candidate for his area, with `seen_at` when he dismisses the banner (service role only).

The first three were applied to staging and production on 7 November 2026 and read back from the catalog.
Until the fourth is applied, the banner shows nothing and the bell, push, Telegram and email still go — the
read and the write each fail soft (`area-notices.ts`).

## Tests

`tests/recruitment-mr-hiring-stage.test.ts` (every step and state, the hold, the RSM step),
`tests/recruitment-mr-hiring-access.test.ts` (who records each step, the salary, who reads the journey) and
`tests/recruitment-mr-hiring-booking.test.ts` (Cairo/Giza, the DSM's CV send, the notices) and
`tests/recruitment-mr-hiring-area-notice.test.ts` (who manages the area, every channel, the banner, moving an
interview).
