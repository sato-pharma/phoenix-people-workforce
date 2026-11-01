# Phoenix CRM — the out-of-plan limit and its named exceptions

## The limit (owner, 2026-10-10)

*"maximum 2 drs a day are visited out of plan and maximum 8 drs in the full week."* The numbers are the settings
`offplan_daily_cap` and `offplan_weekly_cap` (2 and 8 by default). The door is the BEFORE INSERT trigger
`phoenix_crm_visits_offplan_cap`; the rep and his managers read the same count through `offplan-cap-rules.ts`.

## The exception (owner, 2026-10-17)

Mostafa Mahmoud Mohamed Ali (CNS, Nasr City, Cairo; seat `SEAT-CNS-REP-CA2`) may submit as many unplanned visits as he
needs at **مستشفي الجوي التخصصي** — five, six or more — without the rule of two. The approval is the normal one (his
district manager, then the SFE). Asked three questions in chat, he answered:

- **Scope:** the hospital account and its doctors.
- **Other visits:** *"everything as it is today, the exception is only for الجوي التخصصي"* — so a hospital visit is in
  NO count (not the day's, not the week's, not the shared-place day's), and every other customer keeps 2 and 8.
- **Told:** the rep, his district manager (Mina Farouk Nawar Rizkallah), the national sales manager (Amr Mohamed Naguib
  Elsebaey) and the SFE Manager (Khaled Mohamed Ali Bedair). One in-app notice each, sent 2026-10-17; no email, no
  Telegram (Phoenix CRM sends none by owner rule).

## Four hospitals with no cap at all (owner, 2026-10-31)

Read the Air Force hospital exception back, he answered: *"DO THE SAME FOR THE MENTIONED HOSPITALS MAKE THEM
NORMALLY ADD IN THEIR PLANS ANY COUNT IN THIS HOSPITALS AND MAKE THEM LOG VISITS PLANNED/UNPLANNED IN THOSE HOSPITALS
WITHOUT CAP"* — of the four hospitals in Saad Salama's district (CNS, Alex-BHR) he had just asked about:

| Rep (seat) | Hospital | Venue name key |
| --- | --- | --- |
| Ahmed Ashraf Mahmoud Elsayed (`SEAT-CNS-REP-AB3`, Alex Center 1-West) | مستشفى ايليت | `ايليت` |
| Ahmed Ashraf Mahmoud Elsayed | مستشفي زمزم | `زمزم` |
| Ahmed Ashraf Mahmoud Elsayed | مستشفي الروماني | `الروماني` |
| Hager Noureldeen Ahmed Abdelmaged (`SEAT-CNS-REP-AB1`, Alex East) | مستشفي مرقص ماري | `مرقص`, and a key-only row `مرقس` for the other spelling |

- Each row names the hospital account AND the venue key, with **`lifts_venue_cap = true`**. That flag is the whole
  difference from the Air Force row (which keeps `false`): the venue's own daily number (`shared_place_daily_cap`, 3)
  is lifted for **planned** visits too — at the door (`phoenix_crm_shared_place_day_cap` returns before it counts),
  on the plan's **save** (`resolvePlanItems`) and on its **send** (`transitionPlan`). Both sides ask one rule,
  `phoenix_crm_venue_cap_lifted(seat)`; the plan reads it through `loadLiftedVenues` and passes it to
  `sharedPlanCapRefusal`, which leaves items in a lifted venue out of the count. A failed read answers none, so the
  plan falls back to the ordinary number, never a wider door than the database's.
- The out-of-plan cap (2 a day, 8 a week) is lifted there by the existing venue-row door, unchanged.
- **What stays:** the approval chain (written reason, district manager then SFE); one visit per customer per day; the
  plan's AM / PM day caps (5 and 15); the settings; every other seat; and an account nobody has validated is still
  held at two visits — Mary Morcos Hospital is still `pending` on Hager's list with no place captured.
- Migration `20261031170001_phoenix_crm_alex_hospitals_no_cap.sql`, which stops itself unless every hospital
  account is still on its seat. Pinned by `tests/phoenix-crm-offplan-exemption.test.ts` (`runLiftedVenueTests`).

## One Qalubeya polyclinic with no cap (owner, 2026-11-01)

*"MAKE الراعى الصالح POLYCLICNIC FOR MOHAMED SALEM QALUBEYA PEDIA BE ABLE TO SUBMIT DRS IN THIS POLYCLINIC AS NEEDED
DONOT FOLLOW THE CAP IN THIS POLYCLINIC ONLY"* — Mohamed Ahmed Mohamed Hassan Salem (`SEAT-PED-REP-D11`), polyclinic
**مستشفي الراعي الصالح**. He had reached three visits there that day with four doctors seated.

- One key-only row, key `الراعي الصالح`, `lifts_venue_cap = true`: the same doors as the four hospitals above, no
  new code. It reaches this seat's one venue; the migration stops itself if the key ever reaches two.
- **Not reached:** his other venue (مستشفي كنيسه العذراء, still three), and the CNS rep's venues of the same name in
  Qalubeya, which are on `SEAT-CNS-REP-D11`. **What stays** is the same list as above: approval, one visit per
  customer per day, the 5 and 15 day caps, the hold on an unvalidated customer.
- Migration `20261101162433_phoenix_crm_al_raee_polyclinic_no_cap.sql`. Pinned by
  `tests/phoenix-crm-offplan-exemption.test.ts` (`runLiftedVenueTests`). To end it, set `ended_at` on the row.

## A new hire's first month (owner, 2026-10-26)

*"Aya Mamdouh is a new hire — make her able to submit unplanned visits during her first hiring month with no cap, only
during the first month, then automatic return normal."* Aya Mamdouh sdeek Ali (Pedia, Giza 4; seat `SEAT-PED-REP-GZ4`),
hired 24 October 2026, has **no daily or weekly out-of-plan limit from 24 October to 23 November 2026, both inclusive**.
On 24 November the usual 2 a day and 8 a week apply again with no job and no hand: the row simply stops matching.

- It is a **rep-wide dated row**: `rep_hr_id` + `valid_from` + `valid_until`, no customer and no venue. The CHECK
  `phoenix_crm_offplan_exemptions_rep_window` refuses one with a missing date, the dates out of order, or a customer or
  venue beside it — a rep-wide row can never be open-ended.
- `phoenix_crm_offplan_rep_exempt(seat, rep, day)` matches on the seat AND the rep, so a successor on that seat is not
  covered. The cap trigger asks it right after the admin entry skip, stamps `offplan_exempt` and returns before it
  counts, so her first-month visits never use up the week the window ends inside.
- Only the CAP is lifted. Every such visit is still `out_of_plan`, still needs its written reason, and still goes to her
  district manager and then the SFE. The settings are untouched; the venue's own daily number is not lifted.
- Her allowance card reads "Until 23 November there is no daily or weekly limit on your unplanned visits. From the day
  after, the usual limit applies." and shows no meters; a manager entering a visit for her reads it about the rep.
- Migration `20261026230001_phoenix_crm_new_hire_offplan_month.sql`. To end one early, set `ended_at`. The next new hire
  is a new row with the owner's word.

## How it is built

- Table `phoenix_crm_offplan_exemptions` — one row per **seat** and **customer or venue**. It is a named row, never a
  raised cap: the settings are untouched, and no other seat is reached (`e.seat_id = p_seat`).
- `phoenix_crm_offplan_exempt(seat, customer, place)` answers whether a visit falls under a row;
  `phoenix_crm_offplan_exempt_customers(seat)` lists the customers it covers, for the rep's picker.
- The cap trigger stamps `phoenix_crm_visits.offplan_exempt = true` and returns **before it counts anything**. The two
  out-of-plan counts and the venue count all say `and not v.offplan_exempt`, so a stamped visit is in nobody's total.
- The shared-place daily number is lifted for an **out-of-plan** hospital visit only — a planned one still counts —
  unless the row carries `lifts_venue_cap` (2026-10-31), which lifts it for planned visits too, door and plan alike.
- The allowance card tells the rep where the limit is lifted; a manager's off-plan card carries
  `OFF_PLAN_EXEMPT_CARD_TEXT`. Pinned by `tests/phoenix-crm-offplan-exemption.test.ts`.

## Limits worth knowing

- **One visit per customer per day still applies**, so "five or six" means five or six different customers.
- The hospital is not a shared place today (no shared-place row; the hospital account has one place). Its doctors are
  covered once the rep seats them in a venue of his own whose folded name contains "الجوي". Until then only visits to the
  hospital account itself are exempt.
- A new exception is a new row in `phoenix_crm_offplan_exemptions` with the owner's word — never a settings change.
