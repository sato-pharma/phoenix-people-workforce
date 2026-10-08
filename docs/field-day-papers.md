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

## The authored notes, and the day each one belongs to

The `AUTHORED` map in `print-day.mjs` holds six sentences — the only ones on these papers a human
wrote. Every one of them is about **Saturday 3 October 2026**, the Delta (1) launch day: a phone stuck
on approximate location all morning, a hospital 3.6 km from the pin Google still holds for it, an
attempt refused from inside a building and retaken outside.

They were keyed by **rep full name alone, with no date**. So each sentence printed on the paper for
*every* day its rep appeared on. The holiday fix above stopped them on a day off — the 8 October paper
had put *“The phone was on approximate location all morning”* directly beside *“Nothing was
recorded”* — but a day off was only half of it: on **7 October**, an ordinary working Wednesday, and on
every working day since, the same 3 October judgement printed as though it had happened that morning,
on a sheet that goes to the district manager and is summarised for the Chief Executive. A wrong
judgement about a named person's morning is worse than no judgement, and it was signed by the owner.

So the map is keyed **by Cairo day first, then by rep**:

```js
const AUTHORED = {
  "2026-10-03": {
    "Yasmeen Samy Shawky Mahdy": "The phone was on approximate location all morning — …",
    …
  },
};
```

`notesFor(rep, day, restDay)` looks the day up before the rep, so a note prints on the day it was
written about and on no other. The sentences themselves are untouched — they are the owner's own words
about real incidents and real named people; this changed **when** they print, never what they say.

The `restDay` guard stays, behind the day key rather than instead of it: a day off has no captures to
explain, so should a note ever be written against a date the company later moves its day off onto, the
note still does not print. A rep with nothing to explain on a day gets only the derived notes, exactly
as before, and a rep is always still **named** on the paper — only the borrowed sentence is gone.

## The nightly prints every day, a day off included (owner, 2026-10-09)

Asked for and reversed within the same hour: *"make the nightly skip a day off"*, shipped as #5582,
then **"leave the nightly printing on a day off"** — reverted by #5584. So the scheduled job prints
four papers every day it runs, a public holiday and a Friday included. The papers read correctly on a
day off since the fix above, which is what makes that an acceptable answer rather than a resigned one.
🔴 **Do not add a skip back without his word for it.**

What it looked like, if it is ever asked for again: opt-in, the flag passed by the launcher **only
when it was given no day**, so a day named on the command line always prints — that is the path the
8 October papers were reprinted by, and a printer refusing a day off outright would have refused that
reprint too. The notice was prefixed `SKIPPED — ` because every other stdout line is a PDF path the
launcher logs as `wrote <line>`, and it exited 0, because a day off printing nothing is a correct
outcome and Task Scheduler reads non-zero as a broken job.

## Where a superseded paper goes (owner, 2026-10-09)

The printer archives the paper already on disk before Chrome replaces it — by copy, keyed by the
superseding commit's short sha, oldest archive per label winning. That started as a copy *beside* the
paper, and by the night of 9 October `xlsx/` held **40 archives and 12 MB against 28 live papers**:
the 8th alone had 20, because the printer had been re-run through five fixes that day. The folder a
person opens to find today's paper was mostly old ones.

His instruction: **"make the printer archive into xlsx/field-day-superseded"**. So
`supersededPathFor` puts every archive in that subfolder, created only when there is something to put
in it, and the 40 that already existed were moved there first.

🔴 **The archive path is about 41 characters longer than the paper's** — one more folder, plus
`-superseded-<sha>` — so `assertPapersFit` now measures **both**, with the label read before the
check so the path it measures is the one `supersedePaper` will write. Without that, a folder the four
papers fit (a 180-character one holds the CEO page at 233) is one the archive cannot be written into
at 278, and `copyFileSync` would stop the run with a bare ENOENT *after* the fit check had passed.

🔴 **The consequence was put to him before this shipped: the hourly backup to `F:\PHX backup` copied
the untracked files at the top of the primary's `xlsx/` and nothing in a subfolder**, which would have
left every archived paper on this one SSD. His answer the same hour — *"add xlsx/field-day-superseded
to the hourly backup"* — so `BACKED_UP_SUBDIRS` in `scripts/repo-doctor-xlsx-snapshot.mjs` names that
folder and its files are copied and SHA256-verified like the live papers.

🔴 **That module repeats the folder's name and must never import it.** `xlsx-snapshot.cmd` extracts
that one file from `origin/main` (`git show origin/main:scripts/repo-doctor-xlsx-snapshot.mjs`) and
runs it standalone, so an import of any other repo file would make the hourly backup fail outright —
node builtins only, in that file. `tests/repo-doctor-xlsx-snapshot.test.ts` asserts the list still
matches the printer's own `SUPERSEDED_DIR`, which is what catches a rename of the folder.

🔴 **And the snapshot folder is flat, keyed by basename**, so a subfolder file whose name repeats a
top-level one would mean one copy silently overwrote the other. Archive names all carry
`-superseded-<sha>`, so it cannot happen with what the printer writes; if it ever does, that file is
**not** copied and the job exits 4, because a file believed backed up that is not is the one outcome
the backup exists to prevent.

### 🔴 A launcher change is inert until the copy is refreshed

Found while building that skip, and true of **any** `run-nightly.mjs` change.

The scheduled task **Phoenix CRM field day report** invokes `~\.claude\scripts\field-day-nightly.mjs`
— a **copy** that `install-task.ps1:68` makes with `Copy-Item`, never a file in a checkout. Only the
*printer* comes fresh from `origin/main` each night; the launcher does not.

This is not theoretical. #5582 sat on `main` for the whole of the night of 8–9 October and the box
**never skipped a single day**, because the copy still passed no flag. A launcher change reads as
shipped the moment it merges, and is not.

🔴 **And the order is load-bearing, not a preference.** The launcher hands the printer its arguments,
so refresh the copy only *after* the printer it depends on is on `main`. A printer that does not yet
parse a new flag reads it as the **day** — an invalid date that fails the whole run. Copy-first
produces no papers at all, not merely the old behaviour.
