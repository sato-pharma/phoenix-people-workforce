---
name: a-mock-name-generator-reproduces-real-employee-names
description: "HISTORICAL - the staging mock this describes was reversed 2026-08-29. Kept as the method for ANY future anonymisation: a generator drawn from a common-surname pool reproduces real employees' names by chance, so sweep by SUBSTRING against production rather than exact match, and remember auth.users is a second identity store a scrub will miss."
metadata:
  node_type: memory
  type: project
  originSessionId: 52493c41-8681-4061-aa67-4d730444cc29
  modified: 2026-08-29T09:08:58.596Z
---

## HISTORICAL 2026-08-29 - the mock this describes no longer exists

Staging was re-cloned from production on 2026-08-29 at the owner's instruction, so the scrub below
is gone and staging now holds **real** production identities again - see
[[staging-is-now-mock-data-not-a-production-mirror]] for what that means for demo safety. Everything
after this banner is a **dated record of how that scrub was done and where it leaked**, not a
description of staging today. Do not go looking for `mock_backup.name_scrub2_20260828` expecting it
to describe live rows.

**Three things here stay true regardless**, and are why the file is kept rather than retired.

**The substring-sweep method** is the first, and it is the whole point of the file: it stays here,
and must be redone from scratch for any future anonymisation.

**The other two were relocated into `AGENTS.md` §2.1 on 2026-08-29 (PR #2617, merged `98432ce87`)**
because they are agent-operating traps rather than anything to do with mock data, and §2.1
auto-loads in full with no cliff while this file is only reachable on purpose. Do **not** relocate
them a second time. Both were re-measured against production before the move, and one was stronger
than this file had recorded:

- **`au.occupancy_history.occupant_canonical_hr_id` loses EVERYTHING, not merely something.** The
  wording below ("silently returns nothing") was right about direction and too weak about scale.
  Measured 2026-08-29: **120** occupancy rows, **0** carrying an uppercase character, against
  **178 of 179** `employees.hr_id` values that do. `join on hr_id = occupant_canonical_hr_id`
  returns **0 rows**; `on lower(hr_id) = …` returns all **120**. A total loss does not read as a
  broken join — an occupancy row matching nobody reads as **a vacant seat**.
- **This MCP returns only the LAST result set** of a multi-statement call. Confirmed the same day:
  three `select`s in one call returned one row, the third, with no error.

**A mock identity is not anonymous just because it was generated.** Staging's scrub built fake
Egyptian names from a fixed pool of given names and surnames. With ~174 mocked employees against
~500 real ones, the pool collided: the owner spotted it instantly - *"nagy is pedia"* - because
`AI-0001` had been generated as **Mohamed Nagy, District Sales Manager, Cairo** while the real
`PD-0006` is **Ahmed Mohamed Nagy, District Sales Manager, Pedia, Cairo**. Same surname, same given
name, same title, same city, on the account that was to be on screen for an entire announcement
video.

**Sweep by SUBSTRING, not exact match - that is the whole lesson.** Egyptian names are patronymic
chains (`given father grandfather/family`), so a real four-token name *contains* a plausible
two-token one. `Mohamed Nagy` is not equal to `Ahmed Mohamed Nagy`; it is inside it. The test that
works, run on production with the staging names passed in as a `VALUES` list:

```sql
join public.employees e
  on ' '||lower(regexp_replace(e.full_name,'\s+',' ','g'))||' ' like '% '||c.nm||' %'
```

Run a second pass on **given + family ignoring middle names** (`split_part(...,' ',1)` plus
`regexp_replace(...,'^.*\s','')`) - the other realistic short form. It found nothing extra here, but
it is the pass that would catch `Sameh Bakr` against a real `Sameh X Bakr`.

**A manager-only, surname+title sweep is the wrong tool and it lies in both directions.** The first
attempt hashed `surname|job_title` restricted to manager titles: it **missed two** real substring
collisions and **flagged one** (`B-180 Heba Shalaby`) that was not a substring match at all. The full
sweep across all 174 names returned exactly **4**: `AI-0001` Mohamed Nagy, `B-126` Ibrahim Tawfik
(inside `Amgad Ibrahim Tawfik Farag`), `B-134` Aya Ibrahim (inside `Aya Ibrahim Mohamed Salam`),
`B-183` Mohamed Kamal (inside `Yehya Mohamed Kamal eldeen Saad Mohamed`). `B-180` was renamed anyway
on a weaker but real ground - production's only Shalaby is `AI-0014` **Samaa Shalaby, DSM,
Anti-Infective**, the very line being filmed.

**Pick replacements on a surname that appears ZERO times in production**, then the sweep cannot fire
by construction. Here that left **Sorour, Wahba, Fouad, El Masry** - four of fifteen candidates.
Most common surnames are unusable: `Mahmoud` appears 18 times, `Hassan` 8.

**A name is denormalised across ~30 tables - find them, do not guess.** Scan every text column
rather than listing tables from memory:

```sql
(xpath('/row/cnt/text()', query_to_xml(format(
  'select count(*) as cnt from %I.%I where %I::text ~* %L',
  c.table_schema, c.table_name, c.column_name, '<the names>'), false,true,'')))[1]::text::int
```

Filter the column list to identity-shaped names (`name|email|login|agent|manager|...`) or it times
out. Beyond `employees` and `app_auth_users` the copies sat in `salary_records`, `sales_records`,
`field_workforce_compliance_days`/`_monthly_summary`, `deduction_candidates`,
`employee_plan_headers`, `position_vacancies`, `admin_cleanup_events`, `employee_support_requests`,
`private_calendar_no_activity_clarifications`, six `login_id` columns, and
`notification_deliveries.recipient_address`. **Do not rewrite `ireports360_visits`/`_checkins`
`contact_name`/`customer_name`** - those are doctors and pharmacies from a different generator.

**`auth.users` is a SECOND identity store and the scrub had missed it entirely.** The scrub covered
`public.app_auth_users` (the app's real login table). Supabase's own `auth.users` still held **11
real production identities** in `raw_user_meta_data->>'name'` - real names, real hr_ids, real
titles, **including the CEO** - months after staging was declared fully mocked. Its `email` is
`phx-<hex>@auth.phoenix.local`, where the hex decodes to the login id or hr_id:

```sql
convert_from(decode(replace(split_part(email,'@',1),'phx-',''),'hex'),'UTF8')
```

That decode is what lets you rejoin each row to `public.employees` on `hr_id` and copy the already
mocked name across, keeping one real person = one fake person everywhere. Leave the `PHX RLS
Staging Test *`, `ZZ Test *` and `admin-HR` rows alone - they are fixtures, not people.

**Two smaller traps.** `au.occupancy_history.occupant_canonical_hr_id` is **lowercased**, so
`= e.hr_id` silently returns nothing and a healthy seat reads as vacant. And this MCP returns **only
the last result set** of a multi-statement call - earlier `select`s in the same batch vanish without
error, so verify in a separate call.

Context: [[staging-is-now-mock-data-not-a-production-mirror]] ·
[[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]]

**The same hole existed in 11 more tables - 321 real names, ~16,000 rows.** Found 2026-08-28 by the
same scan. `employees` and `app_auth_users` had been scrubbed; the DENORMALISED copies had not:
`field_workforce_compliance_days`/`_monthly_summary`, `sales_records`, `salary_records`,
`deduction_candidates`, `employee_plan_headers`, `position_vacancies`,
`private_calendar_no_activity_clarifications`, `admin_cleanup_events`, `employee_support_requests`.
They store the **full 4-token real name** (`Aya Ibrahim Mohamed Salam`), so an exact-equality update
keyed on the 2-token mocked name matches NOTHING and reports success. Mapping kept in
`mock_backup.name_scrub2_20260828` (321 rows). Only `Others` and `Vacant Cairo District Manager`
were deliberately left - labels, not people.

**Audit by "does it match PRODUCTION", never by "is it in `employees.full_name`".** The second test
flags every leaver and historical row whose employee record no longer exists, so it returned the
same 130/115/96 counts before and after a successful scrub - it cannot tell fake from real and
reads as "nothing happened".

**Re-sweep the REPLACEMENTS too.** Generating 321 fresh names from the same pool reproduced four
production names, including `Ahmed Nagy` - the real `PD-0006`'s own short form, the very name this
whole exercise started from. Only the given+family pass caught it (`ahmed nagy` is not a substring
of `Ahmed Mohamed Nagy`). Generate, sweep, regenerate the hits onto a zero-presence surname, sweep
again.
