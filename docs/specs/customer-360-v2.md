# Customer 360 v2 — validated doctors and accounts, and everything tied to them

Owner's brief and rulings, 18 October 2026 (Cairo). Code: `src/lib/customer-360/`,
`src/components/customer-360/`, `app/(admin)/customer-360/`, `app/api/customer-360/`. Database:
`supabase/migrations/20261018230827_customer_360_validated_relationships.sql`.

## What he asked for

Customer 360 used to be one page per register row: a marketing pharmacy or a direct-order pharmacy.
The two registers never met on one page, no doctor appeared anywhere, and visits were missing. He
did not want it that way. He asked for every customer to be linked: a doctor visited by all three
lines, direct orders from one line, marketing requests from another, and the pharmacies tied to him.
He wanted to know whether the marketing money came back, and which doctors go on a whitelist and
which on a blacklist. "Doctors first." He also wanted it to be the strongest customer data source in
the system.

## His rulings

- **Validated customers only.** Validated Phoenix CRM PM doctors and AM accounts, plus validated
  marketing customers (system validated or SFE validated). Pending customers are out. The pharmacies
  tied to them need no validation of their own. A customer validated tomorrow appears by itself.
- **A pharmacy named on a visit.** If one shop with the same name is in the same brick where the
  doctor is validated, it is tied automatically. Anything uncertain goes to a confirm tab in this
  module, for the system administrator. That tab shows where the validated customer is, the shop's
  address and its full data.
- **Whitelist.** Sales grow after the marketing request, even a little; the 10× target is not
  required. Sales starting from zero after the request also count. So do pharmacies tied through his
  visits that start selling.
- **Blacklist.** The request's ROI window has closed under 10×, and the pharmacies sold no more than
  in the three months before it ("ROI missed, pharmacies flat").
- **History months.** January to June count as history, taken from the Monthly Closing's own uploaded
  figures, so a request paid in July has months to compare against. July onward counts once a month's
  closing is published for that line. The running month never counts.

## How it works

### Who is in — `validated.ts`

One file holds every validated-status word. `tests/customer-360-validated.test.ts` refuses a status
literal or a status-column filter anywhere else in the module (`labels.ts`, the label map, is exempt).

- **Phoenix CRM row.** It counts when:
  - `validated_at` is set;
  - it is not a test row;
  - the list is PM (doctor) or AM (account);
  - the status is active or dropped (a dropped row stays, and is shown as dropped);
  - it has a real contact id (`reference_contact_crm_id`, else `own_contact_crm_id`, never 100000);
  - its speciality is not pharmacy.
- **Marketing customer.** Validated, active and not merged. A clinic or doctor is a doctor; a
  hospital, account or other is an account.
- **Ties.**
  - A marketing customer→pharmacy link counts at the statuses in `LINK_STATUS_PRECEDENCE`.
  - A direct-order venue counts only when it is trusted.
  - Orders count when approved and neither reversed nor a reversal.

### Hubs — `hub.ts`

A hub is one of:

- `pm_<contact>` — a doctor;
- `am_<contact>` — an account;
- `mc_<uuid>` — a marketing customer that joins no Phoenix hub.

Several seats and lines on one contact are one hub. PM and AM never mix.

A marketing customer joins a Phoenix hub only by:

- the CRM code on one of its contacts; or
- a link the system administrator confirmed in Customer Links. Its new identity source,
  `marketing_customer`, lets those links be confirmed.

A name match alone never joins it. When the evidence conflicts, it stays apart, and the page says why.

Linked pharmacies come from four sources, folded into one row per shop:

- marketing link;
- request target;
- trusted direct-order venue;
- named on a visit.

Rows that share a proving distributor pair merge into one. EP-PHS reuses codes across shops, so an
EP-PHS code never proves a shop and is matched with its brick. **An EP-PHS code with no brick is never
read at all** (`pairCanBeRead`): without its brick the closing would hand back every shop that carries
the code. A direct-order code row with no brick of its own takes its venue's brick.

Direct orders keep each approved order's line and Finance's month. Head Office orders are dropped, as in
the closing. The order count, value and months shown are counted only in months closed for that
order's own line.

### The matcher — `pharmacy-matcher.ts`

An item is one folded name (`pharmacyNameKey`, Phoenix CRM's own fold) in one brick.

- **Automatic:** exactly one shop of that name in the brick, with one code per distributor. One shop
  bought from several distributors ties all its pairs.
- **Waiting:**
  - two shops of that name at one distributor;
  - only a near name in the brick;
  - the same name only in another brick of the area;
  - no candidate at all;
  - a visit place with no brick.
- **Never tied:** warehouses.

His decisions are stored in `customer_360_pharmacy_matches`, keyed by name and brick, so tomorrow's
visit that names the same shop is settled at once.

- His decision outranks the rule; Undo hands the item back to the rule.
- A stored automatic row is a record, not a decision. If the shop stops being unique, the item waits
  again.

**Changed from the approved plan.** The plan had an hourly sweep to store the automatic ties. The ties
are computed live on every read instead, so there is no cron job and nothing can go stale.

### Sales — `server/sales.ts`

The Monthly Closing is the one source of sales. `phx_closing_customers_for_pairs(line, periods, pairs)`
filters the closing's own `phx_closing_customers` rows down to the linked pairs, and decides nothing
else.

- It takes the line NAME: `Anti Infective`, never `anti_infective`.
- Value only. Units are never added across products.
- **El Qema.** The verdict is decided once, on every row, El Qema's included, before any viewer's mask.
  It is a conclusion, like an achievement, so a Super Admin and a CEO read the same verdict. A viewer
  who may not see El Qema then loses the detail:
  - its rows (`withoutMaskedSourceRows`) and its codes;
  - any shop known only by an El Qema code (its name would be El Qema's own);
  - on a customer whose pharmacies carry an El Qema code, every verdict reason that quotes an amount.
    Otherwise the gap between the reason and the rows shown would size the hidden money.
- The old pharmacy page's direct read of `source_of_sales_channel_customer_rollup` now goes through
  the same wrapper, so its units column is gone.

### Verdict — `verdict.ts`

The verdict is a pure function. It is advisory only: nothing outside the module imports it, and
`tests/customer-360-wiring.test.ts` checks that. The rules are checked in this order:

1. **Not enough data** — no linked pharmacy carries a code the closing can find.
2. **Whitelist** — any committed request grew or met its 10×, or the visit signal grew. It is marked
   "early" when only one closed month has passed since the request.
3. **Blacklist** — a committed request's window closed under 10× and its pharmacies did not grow.
4. **Watch** — the window is still open with no rise yet, the customer was visited and is flat, or
   there is no closed month after the request yet.
5. **Not enough data** — anything else.

**Months judged** (`verdictMonths`): the history months, plus the months published for **all three**
lines. A month published for one line only holds part of a customer's sales, so it is not judged until
the other lines publish. The running month never is.

ROI figures are the Marketing ROI engine's own (`loadActuals`, `resolveRoiResultStatus`). Money is
shown only to viewers with marketing read access.

### It updates itself

The report is built on read and cached in the process, keyed by a generation number. The number lives
in `src/lib/cache/namespaces.ts`, which imports nothing, so any module may bump it.

Every app write that changes the report bumps it after it succeeds:

- Phoenix CRM writes (`CUSTOMER_360_PHOENIX_WRITERS` in `phoenix-crm/server/db.ts`): validation,
  drops, places and visits;
- every marketing-request and direct-order change, through their sheet pings;
- customer→pharmacy link decisions;
- request cancel and Finance hold;
- marketing venue merge;
- direct-order pharmacy validation and probation promotion;
- identity decisions;
- closing publish and unpublish;
- this module's own match decisions.

Writes the app never sees, such as the vendor sync, land within ten minutes.

## Pages

- **`/customer-360`** — readable with `sales:read`; portal roles are sent away. It has three tabs:
  Doctors, Accounts, and Pharmacy matches (system administrator only, showing the waiting count). It
  also has a KPI band, filters, an Excel export, and a table on desktop with cards on mobile.
- **Detail pages** — `/customer-360/doctors/[hubId]` and `/customer-360/accounts/[hubId]`. Each looks
  the hub up in the viewer's own report. Sections: verdict, lines visiting, linked pharmacies,
  marketing requests and their return, direct orders, and not linked.
- **Excel file** — `/api/customer-360/export`. It uses the same filter function as the screen and is
  rate limited.
- **Pharmacy page** — `/customer-360/[subjectId]` stays as the drill-down from a linked pharmacy.
- **Match decisions** — `POST /api/customer-360/pharmacy-matches`. It checks the request comes from
  this site, then requires `customer_identity:update`.

## Measured on production, 18 October 2026

| Measure | Value |
| --- | --- |
| Hubs | 2,335 (2,022 doctors, 313 accounts) |
| Confirm-tab items | 256: 50 automatic, 206 waiting |
| Whitelist | 9 |
| Watch | 36 |
| Blacklist | 2 |
| Closed months | January to September 2026 |
| Build time | about 16 seconds, cold |

Requests paid in September and October can only be judged once October's closing is published.

## The database fix that came with it

`customer_identity_links_source_check` allowed only four sources, but the decide route already
accepted `visit_feedback`, so confirming a typed-pharmacy link failed with error 23514. The migration
widens the check to six sources, including `marketing_customer`. The wiring test checks that the
latest migration's list matches both the TypeScript type and the decide route.
