# The EU organogram is the source of truth for every employee's distribution

**Owner instruction, 2026-10-12 (about 22:10 Cairo):** *"source of trust for employees'
distribution is the EU organogram. The old V organogram, if it is still available, drop it and
depend only on the EU organogram and link anything to the EU organogram."*

It repeats, and widens, what he said on **2026-10-10 at about 01:25 Cairo**: *"eu organogram fucken
drop the v-organo"* — after a session told him no one owned an area called Down town, because the V
organogram had answered a question about September with "nobody".

## The two names, resolved

| His word | The object |
| --- | --- |
| **the EU organogram** | the `au_v_*` seat model — `au_v_org_tree`, `au_v_line_area_map_all`, `au_v_seat_occupancy_all`, `au_v_regions`, `au_v_employee_seat_drift` |
| **the V organogram** | `public.v_active_organogram` — now dropped |

The V organogram was a flat join on `employees`, filtered to `organogram_visible` **and**
`employment_status = 'active'`. That makes it an as-of-today projection, not an organogram: an area
whose seat is vacant *now* vanished from it entirely, with no error, no null and no empty string
marking the omission. It listed 48 areas with **no "Down town"** while Down town's CNS rep seat was
occupied for the whole of September. It therefore could not answer any question about a past month,
which is most closing questions.

## What was actually wrong in the data

`au_v_employee_seat_drift` compares `employees.area_id`, `region_code` and `manager_hr_id` against
the seat each person holds. Read on production (`ozucdzovmcqvepbozvqf`) on 2026-10-12 it showed
**97 seated actives, 5 area drifts, 4 region drifts, 1 manager drift**. Corrected from the seat —
values taken from the view, never hand-typed — and the view then read **0, 0, 0 of 97**.

| Person | Was | Now, from the seat |
| --- | --- | --- |
| Esraa fotooh Mosaad Al-Shandalati | no area at all | Gharbia 2 (Mahalla), region D1 |
| Mostafa Ahmed Mahmoud Mohamed | no area at all | Qena 2, region UE-2 |
| Osama Mohamed Ali | no area at all | Qena 1, region UE-2 |
| Taha Sheeba Alhammed Mohamed Abdelkhaleq | no area at all | Qena 1, region UE-2 |
| Norhan Samir Selim Ramla | Assuit 1 | Assuit 2 — where she is seated |
| Mohamed Alaa Eleiwa Abozaid | reported to the National Sales Manager | reports to Hany Saad Mohamed Omar, Regional Sales Manager |

🔴 **Four of those six were failing CLOSED, and it was visible to the person.**
`src/lib/sales/medical-rep-area-scope.ts` resolves a rep's own areas through
`employees.area_id → public.areas (active) → the au.sos_area_crosswalk RPC`, every link failing
closed. With no area on file those four reps were shown *"We don't have your area on file yet.
Contact HR/your admin to get your territory assigned."* in the Territory Drilldown, the pharmacy
action lists and the portal Monthly Closing. Norhan was not blocked — she was scoped to the **wrong**
territory, which is worse, because nothing about it looks broken.

The manager row was the only Pedia District Manager skipping the Regional Sales Manager: his Delta 1
and Delta 2 peers (Nermeen Salah Abdelaty Abohussien, SAHAR EL GALLAD) already reported to Hany Saad
in **both** the seat model and `employees`. The Giza, Upper Egypt 1 and Upper Egypt 2 Pedia DMs
report to the NSM in both, so correcting this row matched the structure rather than inventing one.

**No money moved.** No payroll, incentive or deduction *amount* reads these columns.
`manager_hr_id` reaches deductions only as **audience** — the dispute reply chain
(`src/lib/deductions/dispute-audience.ts`) and notification (`notify-deduction.ts`). The DSM
no-record connector rosters by *District Sales Manager* job title, and neither the NSM nor the RSM
carries it, so no deduction roster changed. The pre-image, with a reversing statement per row, was
written before the update ran.

## Dropping the view

`supabase/migrations/20261013010000_drop_v_active_organogram.sql` carries the drop **and the exact
definition needed to restore it**. Checked against production immediately before:

- **zero** dependent views, matviews or rules (`pg_depend` through `pg_rewrite`)
- **zero** anon-granted public views at all, so no browser reachability is lost
- no application code read it

The only readers were two disposable-fixture smoke scripts, which proved a terminated employee
"leaves the effective organogram". That leg is now `organogram_visible === false` directly on the
row, and the comment in `scripts/phase15-disposable-fixture-smoke.ts` says why the seat model's own
answer is *not* asserted there: a disposable fixture never holds a seat, so "holds no current seat"
would pass before the termination exactly as it does after — a vacuous assertion that reads as proof
while proving nothing. Seat release on termination is proven where it happens, in
`au.resign_occupant`, called by `phx_resign_employee_and_open_vacancy`.

🔴 **It cannot come back by accident.** `tests/organogram-hardening.test.ts` sweeps every `.ts`,
`.tsx`, `.mjs`, `.cjs`, `.js` and `.jsx` file under `src/`, `app/` and `scripts/` and fails if any
of them calls `.from("v_active_organogram")`. Naming the view in a comment is allowed; reading it is
not. The sweep was broken on purpose and watched to fire, naming the planted file, before the break
was removed.

## Head Office is outside the seat model, and that is correct

16 people sit in the directory with no seat in the EU organogram: Admins, Finance, Human Resources,
Marketing, QPPV, R&D and SFE — the owner among them. The seat model is the **field force**. A sweep
that treats "no seat" as drift would flag all 16; `au_v_employee_seat_drift` does not, because it
starts from the seated and joins outward. Head Office's own organogram path is
`src/lib/reports/organogram-head-office.ts`.
