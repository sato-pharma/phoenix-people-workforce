# Field Absence Calendar

**Owner's request, 18 October 2026:** *"On every day of a working day that the system did not see a
rep or a district manager or any title in the field force, it shows his name … no submit vacation, no
records for this day, or double visit or anything. We didn't see him at all … At the end of the day,
I want to be able to track daily who didn't go to work."*

Pages: `/admin/field-absence` (Super Admin, CEO, SFE Manager) and `/employee-portals/field-absence`
(National Sales Manager). Both call `loadFieldAbsencePage` in `src/lib/field-absence/server/service.ts`.

## His answers (18 October 2026)

| Question | His answer |
| --- | --- |
| Who appears | Reps, acting DMs, DMs and RSMs; and, in his follow-up the same day, the National Sales Managers too: *"he punched, then this means that he came to office. Then this working day, then don't show his name. Show his name if no field work, no punch, no vacation, no anything."* |
| Thursday | Listed, tagged as a half day |
| Today | Shown as "so far", final the next morning |
| Daily alert | None. The calendar page only, and nothing is sent to anyone |
| The NSM's own row | *"he sees himself, but he may have a toggle to hide himself and show his scope"* |

## The rule — when a name appears on a day

All four must hold (`buildFieldAbsenceCalendar`, `src/lib/field-absence/rules.ts`):

1. **They held a field seat that day and were employed.**
   - The seat and who held it come from the EU organogram's dated history (`au_v_seat_occupancy_all`, dated half-open `[from, to)`). Tier, line, area and region come from `au_v_org_tree`.
   - The tiers counted are REP, ACTING_DM, DM, RSM and NSM.
   - Employment runs from the hire date to the last working date (the directory is read with `includeInactive`, so a leaver's earlier days still count).
   - **Resignations:** the last working date is the employee record's, which the resignation workflow writes. Every field resignation on the calendar in October 2026 carried the same day on the resignation request and on the employee record, and the seat closed the next day. A rep serving notice (resigned, last day still ahead) is judged every day up to it, and his own CRM visits count (see the sources).
   - **A declined offer** (`declined_offer`) never started work and never appears. A decline HR chose to pay is filed as `terminated` and is judged like any leaver.
   - A joiner, a leaver or a transfer is judged only on the days they really held the seat.
   - Head Office holds no seat, so it never appears. Vacant seats list nobody.
2. **It was a working day for them.** Friday is off for everyone, through `isFieldWorkforceWeeklyOff`, the one home of that rule. Saturday is off for the RSM and the NSM, and a working day for reps, acting DMs and DMs. National holidays come from `loadCallRateHolidays`. The seat decides the title the rule reads, never the free-text job title.
3. **It is not a future day.** Today is judged "so far".
4. **No source holds a record for them that day.**

| Source | Reader | What counts |
| --- | --- | --- |
| CRM | `getCrmActivityDayMaps` (`src/lib/attendance/crm-day-maps.ts`) | Old CRM (iReports360) and Phoenix CRM visits, crediting the rep AND both partner slots (a double visit). Every working visit type and the CRM's leave code -4. Phoenix work evidence, whether or not the team has started. |
| CRM, a departed person's own visits | `queryVisits` with `includeResignedAgents`, for the people whose employment status is no longer active | The reader above hides every row a departed agent filed himself (so a reused CRM login never credits a stranger). Without this read a rep serving his notice showed as "not seen" on every day he visited. Classified by `crmDayKind`, the day reader's own ruling. |
| Vacation | `loadFiledLeaveDays` (`src/lib/vacation/approved-leave-days.ts`) | Any request FILED and not refused: approved, pending the manager, pending HR, needing an assignment, submitted. A rejected or cancelled request gives the day back. |
| Business trips | `loadOutstationTripDays` | Any trip not rejected, every day from start to end. |
| Fingerprint punches | `loadEmployeeDayPunchMinutes` | Any visible punch that Cairo day — for everyone on the calendar, not only the NSMs. |

🔒 **A weekly plan is never a record** (owner, 2026-10-12, `.claude/rules/time-off.md`): it proves the
day was expected, not that anything happened.

🔴 **An unreadable source lists nobody.** Each source is read on its own (`Promise.allSettled`). One
that fails is named on the page, and the calendar is returned unjudged rather than turning everyone
into an absentee. An incomplete holiday calendar is said on the page too.

"Not seen on any working day" needs at least three FINISHED working days (`WHOLE_PERIOD_MIN_DAYS`), so
the loudest label on the page never rests on one day. It usually means a CRM login not linked to the
employee record, or a long absence nobody recorded. Those people are named in a band at the top and
stay in every box.

## Who sees what

- **Grant:** `field_absence:read` in `src/lib/auth/permissions.ts`, held by Super Admin, CEO, National Sales Manager and SFE Manager. `hardBoundaryAllowedActions` caps it to those four and to `read`, so an override can never hand it to a rep or a district manager.
- **Roles:** `canReadFieldAbsence` names the same four, checked in both pages and again in the service, before any read.
- **Scope:** Super Admin, CEO and SFE Manager read every line, with a line filter. A National Sales Manager reads only the line of the NSM seat he holds; an NSM on no NSM seat reaches nobody, never the whole company. The scope is applied to the roster before any source is read.
- **Hide myself:** an NSM is on his own line's calendar. The page lets him hide his own row; hiding takes him out of every box and out of every day's count.

## Screens

- **Month:** a Saturday-first grid. A working day shows "N not seen of M" and the first names; "Show all" opens the whole day. On a narrow screen the grid becomes day cards, newest first.
- **Week:** Saturday to Friday, every name with line, area and manager.
- **Detail:** one row per person not seen at least once: the count, the dates, the longest run of finished working days in a row, and the last record.
- Clicking a name shows what was checked: every source searched for that day, the days not seen, and the last record.
- The view, the period and the line live in the address (`?view=&month=&week=&line=`).

## Tests

`tests/field-absence-calendar.test.ts`: the day rules (Friday, Saturday for an RSM and an NSM,
holidays, future days, Thursday, today), a joiner, a leaver and a transfer, the summaries (a record on
another line's seat or after the last working day is not shown), a departed rep's own visits, a
declined offer, an
unreadable source, the periods, the four roles and the hard cap, the NSM scope, the sources and the
gate order, and the navigation reach.
