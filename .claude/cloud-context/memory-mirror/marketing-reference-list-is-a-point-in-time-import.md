---
name: marketing-reference-list-is-a-point-in-time-import
description: "marketing_pharmacy_code_references is an imported snapshot, not a live feed — POS's 27,612 codes were last loaded 2026-07-29, so a not_found verdict often means OUR list is stale, not that the rep is wrong"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93e5b1f8-1092-41f5-be57-ce7bb47c2bed
  modified: 2026-08-19T16:46:06.214Z
---

**`marketing_pharmacy_code_references` is a point-in-time import, never a live feed.** Nothing
syncs it *in practice* — a syncer exists and has NEVER been run on prod (see below). Load dates read
live on production 2026-08-18 (`min`/`max(created_at)`, Cairo):

| Distributor | rows | first loaded | last loaded |
| --- | ---: | --- | --- |
| POS (19) | 27,612 | 2026-05-22 13:45 | **2026-07-29 17:04** |
| Ibn sina (17) | 13,249 | 2026-05-22 13:45 | 2026-07-29 17:04 |
| EGD (14) | 1,807 | 2026-05-22 13:45 | 2026-07-29 17:04 |
| six others | 1,650 | 2026-05-22 13:45 | 2026-05-22 or 2026-07-29 |

So a pharmacy the distributor coded **after 29 July does not exist in Phoenix at all**, and the
capture gate correctly calls it `not_found`. **Never tell the owner a rep mistyped without first
checking how stale the list is** — the honest answer is usually "either they misread it, or POS has
issued codes since our last import".

**How to tell the two apart in one query:** search the same distributor for near-misses — codes one
digit different, and codes with the same digits in a different order. A typo almost always has a
neighbour in the same area; a genuinely new pharmacy does not. The table carries
`raw_pharmacy_address` / `raw_area` / `raw_region` (Arabic) but **no pharmacy name**.

**That does NOT mean the database cannot confirm a name — an earlier version of this note said so and
it was wrong, and the error cost a near-miss write to production on 2026-08-19.** `public.source_of_sales_customer_map` is the name-bearing master: `customer_code`, **`customer_name`**,
`address`, `brick_id`, `area_code`, `region_code`. It is the same table `phx_resolve_marketing_pharmacy_codes`
resolves against. **Search it by name before ever guessing a code from geography.**

**Refreshing it does NOT mean asking anyone for a distributor export. The owner said so on
2026-08-19 and the schema agrees: the codes arrive with the monthly sales files he uploads, and
"we will never have data different than this."** An earlier version of this note recommended
requesting a fresh export, and a whole session was spent drafting that request. It was wrong at the
premise. Do not revive it.

**The designed path already exists and has NEVER been run on production.**
```
monthly sales upload -> public.source_of_sales_customer_map
                     -> public.phx_sync_sales_pharmacy_codes_into_marketing()
                     -> public.marketing_pharmacy_code_references   (source_file = 'source_of_sales_customer_map')
```
Driver: `scripts/sync-sales-pharmacy-codes-into-marketing.ts` (refuses prod unless
`PHOENIX_CONFIRM_PRODUCTION_SYNC=true`). Verified on prod 2026-08-19:
`marketing_pharmacy_code_references` contains **only** the two hand-loaded spreadsheets —
`Phoenix Pharmacy Database.xlsx` (19,603 rows, 2026-05-22) and
`Phoenix_All_Customers_Distributors.xlsx` (25,811 rows, 2026-07-29). **Zero rows carry
`source_file = 'source_of_sales_customer_map'`.**

**The cost of that gap:** the capture gate matches against the frozen spreadsheets while the live
map holds **4,624 codes they do not have** (52,614 map rows vs 45,414 reference rows; 45,148 shared,
only 231 exclusive to the stale list). A rep entering one of those 4,624 gets a false `not_found`.

**But it fixes none of the current backlog** — all 8 live `not_found` codes are absent from the
**live map too**, so they are genuinely unknown to Phoenix, and only a future month's sales (or
field GPS) can close them. Never sell the sync as a fix for them.

**Two things to weigh before running it**, both read off prod 2026-08-19: it would insert **52,614**
reference rows, and create **9 new `marketing_distributors`** (12 -> 21) coded `SOS_<code>`, which
become **user-visible vendor options in the portal**. The `delete` it runs first is scoped to
`source_file = 'source_of_sales_customer_map'` and so removes nothing today. Idempotent by design.
Latent trap: it casts `source_of_sales_customer_map.id` (bigint, max 736,844 today) to `integer`.

The *other* importer, `src/lib/marketing-requests/reference-importer.ts`, is the spreadsheet route
that produced the stale rows. It upserts on `(source_file, source_row)` — **spreadsheet position** —
so re-importing a re-sorted file rewrites unrelated rows. Prefer the sync above.

Related: [[pos-pharmacy-codes-are-zero-padded]] (a `not_found` today is a real gap, not padding
drift), [[marketing-unverified-code-override-has-a-ui-2026-08-18]] (what the rep can now do about
one).

## It has now actually blocked a live user — 2026-08-19, verified on prod

No longer theoretical. **B-154 Nermeen Salah Abdelaty Abohussien, District Sales Manager, Delta
(1)** created customer «هبه حبيب» at **14:49:04 Cairo**. Its **only** target pharmacy
(`active_pharmacies_on_customer = 1`) carried distributor code `728843773000` → `not_found`,
`reference_match_count = 0`. It was **the only `not_found` code created anywhere in production that
day**. She then logged out and back in three times, changed her own password at 15:31, and by 17:25
was hitting session-version mismatches and a failed login — ~3 hours, and **she has never submitted
a marketing request, ever**. Zero rows in `app_error_events`, zero in `marketing_requests`.

**CORRECTION, later the same day — staleness was NOT the cause here.** An earlier version of this
paragraph said the 21-day-old list was the root cause and that a re-import "may resolve
`728843773000` outright". Both were wrong. **No code anywhere in the 45,414-row list is 12 digits**,
under any distributor or padding form, and no code contains the substring `7288437`. It was a
mis-key. It was corrected on prod to **POS `0001576768`** ("Moussa", Menofia) from the on-site GPS.
A fresh export would never have fixed it — do not cite this incident as evidence for one.

**What the incident DOES prove is still worth keeping:** a bad pharmacy code fails *silently and
expensively*. Nothing on the server, nothing in the logs, and three hours of a district manager's
day. The Save-button hint (#2213, live on prod as `3fc2b3a5`) makes the block legible; it does not
remove it.

**Do not repeat this diagnosis from scratch.** The full incident is now written into the comment on
`marketingDraftBlockers` in `src/lib/marketing-requests/draft-blockers.ts` (corrected by #2215),
including the one thing the original comment got wrong: it claimed the block "left no trace in the
UI", but [[marketing-unverified-code-override-has-a-ui-2026-08-18]] had shipped the day before, so
the amber label and reason box *were* on screen — three screens above the button that refused.

## The other half of the rule — sometimes `not_found` really IS a typo, and you can PROVE it

2026-08-19, same day. Rep **B-94 Taha Mohamed AboElftouh** validated two pharmacies **52 m apart**
in البدرشين — «عمرو» and «هبه خالد» — and typed **the same POS code `1501992` on both**. That code
is in neither the reference list nor `source_of_sales_customer_map`.

**The proof that separates typo from staleness is the GAP, not the absence.** POS codes are issued
densely, so read the neighbours: the list holds 1501985, 1501989, 1501990 → then jumps to 1501995,
1501996. A code inside a hole that the surrounding numbers straddle was **never issued**; a code
*past* the highest number in its range is the staleness case above. Absence alone tells you nothing.

**And a name match IS available — just not from the reference table.** The line above says a
candidate "can never be confirmed by name from the database alone". That is true of
`marketing_pharmacy_code_references`, which has no name column, but **`source_of_sales_customer_map`
has `customer_name`** and is joinable on the same code. That is how هبه خالد was solved without
asking anyone: her real code came out as POS `0001537376` = «هبه خالد البدرشين», بجوار محكمة
البدرشين, brick `B194-1` / `GZ1` — an exact name match that also agreed with her GPS pin. Applied to
prod; `reference_status` went `not_found` → `matched`, `master_match_kind` → `exact`.

**The method, in order:** (1) is the code inside a numbering hole → typo; (2) search
`source_of_sales_customer_map` for the shop's name in the brick the GPS lands in; (3) require BOTH
name and geography to agree before writing. Where only one agrees, stop — «عمرو» is a first name
only, and two unclaimed عمرو shops sit in that brick (`0001528407` الطرفاية, `0001574445` قلعه
المرازيق), neither at the town-centre pin. Left unresolved and asked, per
[[never-silent-drop-count-and-flag-instead]]; workbook
`xlsx/marketing-amro-badrashin-code-decide-2026-08-19.xlsx`.

**A fictitious code does not stop a request.** «عمرو» rode `MKT-REQ-20260818-D9E88E15` to
`pending_approval` while unmatched — the draft blocker fires on the *submitter's* screen, not on an
already-open request, so an untrackable shop can reach approval. Consistent with
[[system-flags-expenses-never-rejects]], and worth knowing before assuming a live request implies a
valid code.
