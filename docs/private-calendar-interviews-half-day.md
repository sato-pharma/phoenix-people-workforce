# Interviews count as a half day

Owner, 18 November 2026, about a District Sales Manager whose private calendar showed interviews on
days that still read "No Activity Recorded":

> لو 2 انترفيو مثلا الصبح، فده كده يبقى نص يوم صباحي … لو 2 يعني بعد الظهر يبقى كده نص يوم مسائي …
> 2 انترفيوز او اكتر، دول كده يعتبروا نص يوم.

Two interviews in the morning are a morning half day, and two in the afternoon are an afternoon half
day. Two or more in one half count as half a day worked.

He answered two follow-up questions the same day:

- **Where the morning ends: 1 PM Cairo.** An interview that starts before 13:00 is in the morning. One
  that starts at 13:00 or later is in the afternoon. This is the same 1 PM split the half-day
  deductions already use to read save times.
- **Thursday: any time counts.** Thursday is the field force's morning-only day. On a Thursday, two or
  more interviews at any hour count as that Thursday worked.

## What changed

Before this, from 29 October 2026, an interview on the recruitment calendar was display only. It
showed on the interviewer's private calendar but never cleared "No Activity Recorded". That still
holds for a single interview in a half.

| Interviews that day | Private calendar | Deductions |
| --- | --- | --- |
| One, or one in each half | No Activity Recorded, as before | judged as before |
| 2+ in the morning only | day covered | full-day readers drop the day; the Half Day (CRM) tab charges the afternoon at 0.5 |
| 2+ in the afternoon only | day covered | full-day readers drop the day; the Half Day tab charges the morning at 0.5 |
| 2+ in each half | day covered | a proven-worked day, never charged |
| Thursday, 2+ at any hour | day covered | a proven-worked day, never charged |

This is the same pattern as an approved half-day vacation: the calendar counts the day as covered,
and the other half belongs to the Half Day tab.

## Where it lives

- The rule: `src/lib/private-calendar/interview-halves.ts` (`interviewHalfOf`,
  `interviewDayCover`, `selectInterviewHalfDays`).
- Each interview item carries `interviewHalf` (`interview-items.ts`), and `isCovered` in
  `logic.ts` counts these, each booking once per person.
- `getCompanyNoActivityDays` (the No Records Activity connector and the weekly gap notice) reads the
  interviews **strictly**: a failed read throws, because a missing interview would raise a day that
  was worked.
- `loadProvenWorkedDays` reads `loadInterviewHalfDays` as its fifth source. A whole day goes into
  `keys`. A day with only one half covered goes into `keys` **and** `interviewHalfOnly`. Every
  full-day reader drops the day; the Half Day connector reads `interviewHalfOnly` and judges the
  other half (`HalfDayCover.interviewsAm` / `interviewsPm`, reason "Interviews in the morning only …").
- A day that another source already proves is never handed to the Half Day tab because of interviews.

## Scope note

The Half Day tab judges district managers and medical reps only. A head-office employee with two
morning interviews and nothing else is no longer flagged No Activity Recorded, and no tab charges
their afternoon. Head-office days are normally covered by the fingerprint punch anyway.

Pinned by `tests/private-calendar-interviews.test.ts`.
