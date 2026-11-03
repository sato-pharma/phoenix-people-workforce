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

## The Polyclinic Caps page (owner, 2026-11-02)

*"This module I filter by the medical rep. Then after I filter by the medical rep, all his polyclinics appear. Okay, I
have the option to, for example, open or close the toggle. When I open the toggle, then no cap for this rep in this
polyclinic. And also have the option to, for example, instead of making the cap 3, make it 5, make it 7."* From here on
an exception of this kind needs no migration. The page is `/admin/field-crm/venue-caps`, the Super Admin's and, since
2026-11-03, the SFE Manager's (`canManageVenueCaps`, on the page and in the service).

**It opens on the exceptions** (owner, 2026-11-03: *"the first thing that appears in the module are the reps who are
taking exceptions or the polyclinics who are taking exceptions at which rep. And who put this exception? And when?"*).
The list reads every territory, a vacant one included, because an exception belongs to the territory. A venue is listed
when its switch is on, when its number stands above the company's, or when a row frees its unplanned visits. A stored
number at or below the company's is not listed, because the door holds the greater. A vacant territory says so and
cannot be changed here, since the write needs a rep's seats. The choose-a-rep module sits under the list unchanged.

- **The list:** every live venue of the rep's seats, all three kinds, held ones marked. Retired and test venues are not
  listed. A venue appears as soon as the rep captures it.
- **The switch:** a row on the exemptions table with `shared_place_id` (the exact venue, no name key) and
  `lifts_venue_cap = true`, so it reaches what the rows above reach: the daily number for planned and unplanned visits,
  on the plan and at the door, and the out-of-plan limit there.
- **Switching off** ends every lifting row reaching the venue, a name key row included. If that key also reaches
  another live venue of the seat, that venue first gets a row of its own, so one switch never turns a second one off.
  A retired venue the key reaches keeps a row too, inert until the venue is restored. Ended rows stay, with
  `ended_by_hr_id`.
- **An account named on the row** (the hospital's own account on the Alexandria rows) goes with the venue when it is
  switched off, and **switching back on brings it back**: `lift` reads the last ended row reaching the venue. If the key
  also reaches a second venue, the account moves to that venue's row instead, unless the account sits in the venue being
  switched off. One account comes back per venue; every row today names one.
- **The number:** `phoenix_crm_shared_places.daily_cap`, above the company number and 20 at most, asked by the page, the
  service and `phoenix_crm_venue_cap_set`. The door and the plan hold `greatest(setting, daily_cap)`, so a company number
  raised later is never undercut. It moves the venue's daily number ONLY: the out-of-plan 2 a day and 8 a week still apply
  there. That is the difference from the switch, and the page says so.
- **A row that frees unplanned visits only** (the Air Force hospital's, `lifts_venue_cap = false`) is left alone by the
  switch, shown as a note, and ended only by its own "End this exception", which asks first. The page cannot set one.
- **Per seat**, like every row here: a successor on the seat inherits it. A customer moved to another seat keeps a place
  in the old seat's venue, and that rep holds the company number there, plan and door alike. What stays is the same list
  as above. No message or email goes out; the rep's allowance card names a lifted venue, as it does for the rows above.
- **Lowering does not re-check a plan already sent.** Switching off or going back to a lower number leaves approved plans
  as they are, so a visit past the new number is refused at the door that day. A company settings change behaves the same.
- **The number keeps no history.** `raise` overwrites who and when, and `standard` clears them; switch rows keep theirs.
- The read and the write are `phoenix_crm_venue_cap_board(seats)` and `phoenix_crm_venue_cap_set(...)`, so "is it lifted"
  is answered by the door's own match. Migrations `20261102130045_phoenix_crm_venue_cap_admin.sql` and
  `20261102133258_phoenix_crm_venue_cap_round_trip.sql`. Pinned by `tests/phoenix-crm-venue-caps.test.ts`.

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

## The Rep Exceptions page (owner, 2026-11-03)

*"Build a module for admin only to open or close this feature by a toggle or be able to control duration for any rep if
needed exception."* `/admin/field-crm/rep-exceptions`, the Super Admin's and, since 2026-11-03, the SFE Manager's
(`canManageRepExceptions`, never a test account). It opens on the exceptions in force with who set each and when. Under
them sit the reps who once had one, and the filter brings up any other rep.

- **The switch** writes or ends the same rep-wide dated row the first-month section above describes, so the door, the
  rep's allowance card and everything that stays are unchanged. The next new hire no longer needs a hand-written row.
- **The dates** start as the live window. With the switch off they start as the first month from the hire date while
  that month is still running, otherwise one month from today. Any dates may be saved if the last day is not before the
  first day or before today, and a first day may be in the past.
- **Changing dates ends the old row and writes a new one**, so every window stays as history with who set and ended it.
- **Closing or shortening rewrites nothing.** A visit already stamped `offplan_exempt` keeps its stamp and stays out of
  the counts, and a visit logged before a window opened stays counted.
- **Per person, on the seats held now.** A person on two seats gets a row on each, and two people on one seat are
  separate. A row on a seat the rep has left never matches at the door, so the page reads that rep as off.
- **Nobody is notified.** The rep's allowance card follows the row by itself.
- `phoenix_crm_rep_exception_set` is the one write. Migration
  `20261103132005_phoenix_crm_rep_offplan_exception_admin.sql`. Pinned by `tests/phoenix-crm-rep-exceptions.test.ts`.

## How it is built

- Table `phoenix_crm_offplan_exemptions` — one row per **seat** and **customer, venue name key or exact venue**. It is a
  named row, and the settings are untouched, so no other seat is reached (`e.seat_id = p_seat`). A raised number is a
  column on the one venue, `phoenix_crm_shared_places.daily_cap`, set on the Polyclinic Caps page.
- `phoenix_crm_offplan_exempt(seat, customer, place)` answers whether a visit falls under a row;
  `phoenix_crm_offplan_exempt_customers(seat)` lists the customers it covers, for the rep's picker.
- The cap trigger stamps `phoenix_crm_visits.offplan_exempt = true` and returns **before it counts anything**. The two
  out-of-plan counts and the venue count all say `and not v.offplan_exempt`, so a stamped visit is in nobody's total.
- The shared-place daily number is lifted for an **out-of-plan** hospital visit only — a planned one still counts —
  unless the row carries `lifts_venue_cap` (2026-10-31), which lifts it for planned visits too, door and plan alike.
- The allowance card tells the rep where the limit is lifted; a manager's off-plan card carries
  `OFF_PLAN_EXEMPT_CARD_TEXT`. Pinned by `tests/phoenix-crm-offplan-exemption.test.ts`.

## New Hire Accounts (owner, 2026-11-03)

*"I want him to be able to send the new accounts to the new hires, but without changing in access or authorities or
anything."* `/admin/field-crm/new-hire-accounts`, for the Super Admin and the SFE Manager, sits beside these two pages
because the same two people run them. Its code is in `src/lib/new-hire-accounts/`, outside the CRM module, because it
reads logins and the audit trail and the module may not.

- **Who is listed, and asked again at every press** (`isNewHireAccount`): an active login forced to set a password, on
  Medical Rep or District Manager, active on the register, hired in the last 90 days or later. Somebody with a password
  of their own can never be reached, so nobody's established account can be taken over from here.
- **One press, one person.** Sato email reads `employees.work_email` alone, private email `employees.personal_email`
  alone, WhatsApp `employees.mobile_number` alone. The address never comes from the request, and a channel with no address
  cannot be pressed and says why.
- **The sender is `sendPasswordSetupLink`, the one the access page uses.** It writes `force_password_reset`,
  `session_version` and `updated_at`, and no role, line, manager or scope. `user_admin` and
  `/api/admin/users/setup-link`, which reach anybody, stay the Super Admin's.
- **WhatsApp puts the live link in the browser of the person who pressed**, inside the chat URL, until the new hire sets a
  password. He asked for it, and each send leaves an audit row. The URL is never stored, and the screen never re-reads,
  so it cannot be lost.
- **A second press asks first**, because a new link cancels the last one. Last sent comes from the audit row. An email
  that did not leave says not delivered, and one whose first try failed and went to the outbox says not confirmed.
- **A private address is for this person-pressed link only.** The self-service reset code still goes to the Sato mailbox.
- **The chosen mailbox passes the Recipient Assurance Guard by name** (3 Nov 2026). The guard knows only Sato addresses.
  The first private send, Hagar Abu zeid's at 16:31 Cairo, was refused at every try because she has no Sato mailbox, while
  the audit row and the screen said sent. A person with a Sato mailbox would have had it added beside the one chosen.
  `chosenMailbox` now answers the guard's "is this person addressed?", only when it is the whole of To and declared; CC and
  BCC are still checked. Every other sender leaves it empty and meets the guard as before.
- **`sendPasswordSetupLink` no longer calls a queued first try a send**, on this page or the Super Admin's access page. The
  audit row says `email_queued_for_retry`. A row written before the fix keeps what it said.

## Limits worth knowing

- **One visit per customer per day still applies**, so "five or six" means five or six different customers.
- The hospital is not a shared place today (no shared-place row; the hospital account has one place). Its doctors are
  covered once the rep seats them in a venue of his own whose folded name contains "الجوي". Until then only visits to the
  hospital account itself are exempt.
- A new exception is a row in `phoenix_crm_offplan_exemptions`, set by the Super Admin or the SFE Manager on these pages or
  with the owner's word — never a settings change.
