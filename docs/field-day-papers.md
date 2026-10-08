# The Phoenix CRM field day papers — and the holiday that read as a performance problem

The account behind the field-day rule in `.claude/rules/engineering.md`. The papers themselves are
`scripts/field-day/print-day.mjs` (four sheets: one per Delta (1) line for its district manager, one
summary for the Chief Executive), their figures come from `scripts/field-day/read-day.mjs`, and the
nightly launcher is `scripts/field-day/run-nightly.mjs`. Pinned by `tests/field-day-report.test.ts`.

## What was measured

Thursday **8 October 2026** was **Armed Forces Day** — the public holiday the owner moved there from
6 October on 2026-10-01 (`attendance_holiday_overrides` id 19, notes: *"the 6 October day off is
observed on Thursday 8 October. 6 October is a normal working day."*). The field was off. Phoenix CRM
therefore recorded, correctly, nothing at all: 0 calls, 0 places, 0 plan items, 15 of 15 reps quiet.

The papers printed for that day had no notion of a public holiday — `grep -i holiday` found nothing
in either script — so they reported the empty day as an empty day's work:

- the sheet prepared for the Chief Executive: *"15 reps recorded nothing today and one seat is
  vacant, which the district managers are following"*;
- under each of the fifteen names on the managers' sheets: *"Nothing was recorded today, and nothing
  was planned for it either"*;
- and, beside that sentence, the hand-written `AUTHORED` note about a rep's phone being *"on
  approximate location all morning"* — a 3 October incident, printed as though it had happened on a
  day with no captures at all.

Every one of those reads as fifteen people who did not work, on the one document that leaves the
building in the owner's own hand.

## Where a day off comes from

A national holiday's real day off is authoritative **only once a System Admin has confirmed it**
(`src/lib/vacation/national-holidays.ts`), and the confirmation lives in
**`attendance_holiday_overrides`**. The TS side reaches it through
`listHolidayOverridesOverlappingRange` → `getConfirmedNationalHolidays` → `loadPlanHolidays`, which
is what greys a holiday out in a CRM plan week.

`read-day.mjs` is plain node — node builtins plus the Supabase client, deliberately, so the nightly
task has nothing to build — and cannot import `@/lib`. So it reads that same table directly. What it
must never do is keep a list of dates of its own: the owner moved this day off from an admin screen,
and a hard-coded date would have moved everywhere except on the paper reaching the CEO.

Three things the table requires of any reader:

1. 🔴 **`official_date` is not a day off.** The 6 October row is *observed* on the 8th, and 6 October
   is an ordinary working day. Only `observed_date`..`observed_end_date` is the holiday.
2. **Two rows can confirm one date.** Google's Egypt calendar carries a substitute as its own event
   named `Day off for <X>`, and 8 October 2026 holds both it and `Armed Forces Day`. A paper names
   the holiday, never the mechanism that moved it — `holidayNameOf` strips the prefix and the plain
   row wins.
3. **The whole table is read and filtered in memory**, as the TS side caches it: about twenty rows,
   one per postponed holiday per year, where a per-day query would share nothing.

A **Friday** is a day off with no holiday row at all, so the weekday of the Cairo date string decides
it. `weekdayOf` reads the weekday out of the date string itself rather than converting an instant.

Like `loadPlanHolidays`, the read **never throws**. A calendar it cannot reach yields no holiday, so
the papers read exactly as they did before this existed and the nightly log carries the line saying
why. That is the safe direction here: a missed holiday leaves a paper reading as it did for a year,
while a thrown error would mean no papers at all for a job nobody watches.

## What the papers do with it

`restDayOf(day, holiday)` returns `{ kind: "holiday" | "friday", name }` or `null`, and `null` is a
working day where an empty field **is** the finding — that path is unchanged, and a quiet rep on a
working day is still reported as one.

On a day off:

- the day off is stated **before the figures**, directly under the addressee (`restDayBanner`),
  because a reader meets the column of zeroes first and reads it as a failure;
- each rep's note says which day off it was, instead of what was not recorded;
- the `AUTHORED` sentences are not printed at all — they are about a day's captures, and this day had
  none;
- on the CEO's page the day off leads "What the day shows", and **a section whose figures are empty
  is dropped rather than printed as a zero**: "0 of the 15 reps who hold a seat recorded real work"
  is a performance sentence, and "Of the 0 places captured, 0 were accurate" is arithmetic about
  nothing. Both stood on that paper.

Vacant seats are still reported on a day off: a seat nobody holds is a fact about the org, not about
the day.
