# Private Calendar day records

Owner, 28 November 2026. A Group Product Manager was charged deductions for days she spent with her
line's training: she has no field seat, so she logs nothing in Phoenix CRM, and her calendar read
"No Activity Recorded". His rulings that day, in order:

- "These activities must be synchronized in her private calendar and not show as deductions."
- Which activities: **training, yes; meetings, no; a conference day — ask the rep when he is submitting.**
- Who records them: "Make an option for the system administrator to pick the people, but group them …
  select all district managers and exclude one … I can submit it for them all by one step."
- The AI's job: **suggest; the Super Admin decides.**
- A person not yet hired is never covered (Nourhan Abdelmoniem, hired 1 December 2026, had been).
- And the binding correction: **never automatic.** "Here comes the role of the AI … he asks the super
  admin … Line Pedia was training on these days. Was Dr. Rasha Sabry there on all of them … gave me the
  days as multiple choice."

## What a day record is

One row of `private_calendar_day_records` per person per day: the activity, an optional note, where it
came from (`origin`) and its `status`.

| Origin | Written by | Status on write | Covers a day |
| --- | --- | --- | --- |
| `super_admin` | the group record on /admin/private-calendar-day-records | `confirmed` | yes |
| `line_training` | his answer to a line-training question | `confirmed` (ticked) or `declined` (unticked) | only when confirmed |
| `rep_named` | a rep saving a whole-day Conference in Phoenix CRM, naming who was there | `pending` | only once he confirms it |

**Only a confirmed, unvoided record covers a day** — on the employee's calendar, in the company No
Activity pass the deductions read (strict: a failed read stops the pass), in the day evidence a reviewer
reads, and in the proven-worked days (`src/lib/deductions/proven-worked-days.ts`).

## The questions

`src/lib/private-calendar/day-record-questions.ts`, pure half in `day-record-question-rules.ts`.

- A **line training day** is a day two or more distinct people of the line logged Training in Phoenix
  CRM (meetings never count). Each product manager of that line (job title "Product Manager") inside her
  employment window is asked about it — but only on a day the No Activity engine still names for her and
  that no record of any status already answers. A declined day is never asked again.
- A **conference question** is every pending name a rep wrote, grouped per person and rep.
- The AI (the one door, Anthropic first, `component: private_calendar_day_questions`) reads what the
  line's people wrote on each day and pre-ticks the days that look like one shared training of the line,
  with a one-line reason. It never writes a row. With no key, or on any failure, every day starts unticked.

## The rep's conference prompt

`src/components/phoenix-crm/visit-start.tsx` → `saveDayActivity` → `src/lib/private-calendar/conference-companions.ts`.
A whole-day Conference shows an optional tick list, "Who from the line was with you?", of the line's
active managers and product managers (never the rep himself). Saving replaces his pending names for the
day; changing the day to anything else, a half day, or clearing it withdraws them. A save that carries no
list leaves them as they are. A test account names nobody. Nothing here tells the rep anything is checked.

## Pinned by

`tests/private-calendar-day-records.test.ts`.
