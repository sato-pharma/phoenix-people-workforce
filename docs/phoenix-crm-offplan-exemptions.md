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

## How it is built

- Table `phoenix_crm_offplan_exemptions` — one row per **seat** and **customer or venue**. It is a named row, never a
  raised cap: the settings are untouched, and no other seat is reached (`e.seat_id = p_seat`).
- `phoenix_crm_offplan_exempt(seat, customer, place)` answers whether a visit falls under a row;
  `phoenix_crm_offplan_exempt_customers(seat)` lists the customers it covers, for the rep's picker.
- The cap trigger stamps `phoenix_crm_visits.offplan_exempt = true` and returns **before it counts anything**. The two
  out-of-plan counts and the venue count all say `and not v.offplan_exempt`, so a stamped visit is in nobody's total.
- The shared-place daily number is lifted for an **out-of-plan** hospital visit only — a planned one still counts.
- The allowance card tells the rep where the limit is lifted; a manager's off-plan card carries
  `OFF_PLAN_EXEMPT_CARD_TEXT`. Pinned by `tests/phoenix-crm-offplan-exemption.test.ts`.

## Limits worth knowing

- **One visit per customer per day still applies**, so "five or six" means five or six different customers.
- The hospital is not a shared place today (no shared-place row; the hospital account has one place). Its doctors are
  covered once the rep seats them in a venue of his own whose folded name contains "الجوي". Until then only visits to the
  hospital account itself are exempt.
- A new exception is a new row in `phoenix_crm_offplan_exemptions` with the owner's word — never a settings change.
