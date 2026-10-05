# Phoenix CRM — the first field audit

**Measured 5 October 2026, on production (`ozucdzovmcqvepbozvqf`), covering every day the module has
been live: Saturday 3 — Monday 5 October 2026.** Delta (1) started on 3 October, so this is the
module's entire production history, not a sample. 13 rep seats, 9 manager accounts, 415 visits,
74,326 recorded touches.

This is the account behind the audit. It exists because the figures in it took a day to assemble and
would otherwise die with the session that measured them, and because several of them contradict what
the module's own boards imply. **Nothing here is a rule.** Where a finding needs a decision, the
decision is the owner's and the rule goes into `.claude/rules/phoenix-crm*.md` in the PR that makes
the change.

---

## 1 · The headline: the field is working, and the field is honest

| | Measured |
| --- | --- |
| Visits logged | **415** in 3 field days (130 · 139 · 146 — rising every day) |
| Reps who logged at least one | **13 of 13** |
| Visits that count toward a KPI | **413 of 415** (99.5%) |
| Weeks planned and approved | **13 of 13 reps** |
| Visits saved within 300 m of the door the rep himself fixed | **315 of 320 measurable** (98.4%), average **29 m** |
| Visits with a comment, where one is required | **332 of 332** (100%) |
| Duplicate place photos (same file, or near-identical image) | **0 of 241** |
| Fastest average speed between two consecutive visits, across all 36 rep-days | **12.3 km/h** |

### There is no fraud in this data

The module's whole integrity output for three days is **four rows**, and all four belong to one rep —
Yasmeen Samy Shawky Mahdy, 3 October — carrying `constant_accuracy` and `coordinate_replay` at an
accuracy of **2,000 m**. That signature is a phone on Android's *approximate location* permission: it
returns the same cell-tower centroid with the same accuracy radius every time, which is exactly what
a replay looks like. It is the same phone and the same morning as the four Benha hospitals pinned on
one point already recorded in `phoenix-crm-approvals.md`, and the same phone that then collected nine
accuracy refusals on 4 October.

**So the only three "strong" integrity hits in production are a permission setting, not a person.**
That is worth stating plainly: the detector's first real output was a false positive on an honest
rep, which is the precise failure the module's own rule warns about — *"a false positive accuses a
real person of fraud, which is worse than a missed catch."*

Four independent tests run for this audit found nothing:

- **Travel geometry.** Consecutive-visit speed never exceeds 12.3 km/h on any rep-day. Day distances
  run from 273 m to 34 km of real movement. No impossible travel, nowhere.
- **One-spot days.** The clusters of sub-50 m, sub-2-minute hops are all auto-linked pharmacy visits
  inheriting their parent doctor visit's verified position — not a rep standing still.
- **Photo recycling.** 241 place photographs, 0 duplicate SHA-256, 0 duplicate perceptual hash.
- **Recycled text.** 4 repeated comments across 332, median comment length 75 characters.

### What the module cannot see, and what that is worth today

Three doors carry no external check:

1. **Doctors (PM): 305 of 355 validated customers.** A doctor's clinic is fixed by the rep's own
   photo and two GPS readings within 250 m of each other. That proves the rep stood *somewhere
   consistent*; nothing proves it is the clinic. There is no second source for a doctor's address in
   the company.
2. **Hospitals (AM): 47 validated, 10 ever reached a Google review.** The Google Maps listing check
   is the module's one independent cross-check, and it reaches **13% of the validated list**.
3. **Pharmacies: no validation, no place, no location comparison, by the owner's own ruling.**

The exposure on door 3 is currently **zero, and measurably so**. Of 82 pharmacy visits: 65 were
created automatically from a pharmacy named on a doctor's visit (so they carry that visit's verified
GPS), 17 were the Super Admin's own backfill of 3 October. **Not one rep has yet used the standalone
"Pharmacy visit" button.** The uncheckable path exists and has not been walked.

**The honest summary of the fraud question: the structure has three unguarded doors, and after three
days nobody has gone near them. The thing the module should fear is not a cheat — it is a false
accusation, and it has already produced one.**

---

## 2 · The cost the reps are actually paying

The golden rule says the rep's app is *the simplest thing he touches* and *a visit is taps and ONE
tap to log it*. The visit form honours that. **The list does not**, and the list is where the reps'
hands are going.

Presses and taps recorded, 4–5 October, named buttons only:

| What the press was for | Presses |
| --- | --- |
| Validating a customer — Validate · Validate the customer · Open the camera · Take the photo · Capture location | **2,490** |
| Typing a clinic's days and hours — the weekday buttons | **1,238** |
| **Registration subtotal** | **3,728** |
| Recording a call — Add visit · Log visit | **554** |

**6.7 presses of registration for every press that records a call.** On top of that, 1,940 typing
bursts into unlabelled short fields (the opening and closing times, averaging 6 characters each), and
1,080 day-and-hour rows stored across 362 places — an average of **3 rows typed per customer**.

And this is the beginning of it. **9,087 customers are on the lists and 355 are validated — 3.9%.**
At the current rate of ~118 validations a day the carried-over list takes about **74 more field
days — roughly 15 weeks** — and every one of those days is spent mostly on registration rather than
on selling.

Other measured friction:

- **Refusals: 43, of which 42 are the accuracy gate.** 33 of them belong to **Hassan Mohamed Raffat
  Mohamed Elsherbiny — the single most productive rep in the company (58 visits)** — on only **3
  customers**, spread across all three days, with readings between 100 m and 500 m against a 250 m
  gate. The gate is biting hardest on the hardest worker, in the same three doorways, for three days
  running.
- **The app reloads about once a minute.** 1,930 page loads in two days across 25 people; median page
  life **58 seconds**; 514 loads died inside 10 seconds; 1.73 routes per load. That is ~38 reloads per
  rep per day, each one a fresh server render on a field phone.
- **There is no offline queue in the web app** — no service worker anywhere in the repository. 50
  offline transitions were recorded across 9 reps. A rep who loses signal at the moment he presses
  Log visit loses the comment he typed.
- **"I started working" was pressed 10 times out of 39 possible rep-days (26%).**
- **Form time per visit ranges from 18 seconds to 318 seconds** by rep (Ebtissam Alaa ElDin Anwar 18 s,
  Ahmed Farag Soliman Elakraa 318 s). A fivefold-plus spread on the same form is a training gap, not a
  design gap.

### One rep has stopped

**Youssef Hesham Tawfik Mohamed Abokhedra (Medical Representative, Menoufia 2)** logged 6 visits on
3 October and has **not opened the module since** — zero touch events, no last-touch timestamp at all.
Every other rep was in the app within two hours of this audit. He is the module's first and only
drop-out, and nothing in the system has noticed, because the adoption board measures territories that
never started, not a territory that started and stopped.

---

## 3 · Is it a real CRM? Where the module stops being one

It is an outstanding **field-activity and compliance system**. As a *customer relationship* system it
is thin, and the measurements say exactly where.

### The intelligence fields are empty, and the reason is structural

Of 332 rep-saved doctor and hospital visits:

| Field | On the form | Filled | Share |
| --- | --- | --- | --- |
| What the customer said (comment) | **required** | 332 | **100%** |
| Products discussed | **required** | 332 | **100%** |
| Pharmacy stock check | folded, optional | 77 | 23% |
| Samples / materials left | folded, optional | 19 | 6% |
| **Objection** | folded, optional | **2** | **0.6%** |
| **Next step** | folded, optional | **1** | **0.3%** |

Everything required is at 100%. Everything folded away is at 23% or below, and the two fields that
make a CRM a CRM are at nil. The comments themselves are genuine — median 75 characters, 301 of 332
in Arabic, real sentences — so the reps are willing to tell the system things. They simply never open
the folded steps.

**Five modules and two reports are running on that near-empty data:**
`commitments.ts` (open next steps returned to the rep) has **1** input; `call-prep.ts` (the last
objection) has **2**; `missing-stock.ts` has 77; `samples-report.ts` has 19; and "What the field
heard" reports objections that effectively do not exist. These were all built correctly. They were
built on a tap nobody takes.

### The commercial half is missing entirely, and it exists in this database

A Phoenix CRM list row tells the rep: list type, grade, speciality, address, brick, area, zone, and a
point on a map. It tells him **nothing about what the customer is worth.** Not one of the module's
14 reports joins a call to a sale. There is no report, anywhere, that answers *did visiting this
customer sell anything?*

For doctors that is unavoidable — distributors report by purchasing account, never by prescriber. **For
pharmacies it is entirely avoidable, and the data is already here:**

- `source_of_sales_customer_map` holds **63,487 distinct sales customers** (80,109 mapping rows) with
  real purchase history behind them, plus 254,275 rows of customer directory rollup.
- Phoenix CRM holds **691 pharmacies** on the reps' lists, **92 of them visited** in three days.
- **66 of those 92 visited pharmacies (72%) already match a name in the sales customer master** on a
  crude normalised `ilike` — before any aliasing. The repo already owns the aliasing machinery that
  would take the rest.

So the module knows where the rep stood, and the Source of Sales knows what the pharmacy bought, and
nothing in the company joins the two.

### What a pharma CRM has that this does not

- **Value on the customer record.** Grade A/B/C and potential AA–BC are stored and, by the module's
  own rule, *move no figure*. Nothing ranks a customer by money.
- **A relationship state.** No adoption ladder per customer — aware → trialling → prescribing →
  advocate. `adoption-rules.ts` measures whether a *territory* has started using the app, not whether
  a *doctor* has started prescribing.
- **Return on the call.** No sales-per-visit, no growth-after-visit, no comparison of visited against
  unvisited customers.
- **Anything the rep gets back that he wants.** Every screen he owns is about what he must do
  (plan, list, validate, log). Nothing shows him what he earned, where he is strong, or who his best
  customers are.

---

## 4 · Where the reports will mislead on their first reading

- **Plan execution reads 53–55% on all three days** (177 planned / 98 visited · 191/101 · 192/101).
  The cause is visible in the same numbers: plans were written at the daily cap (192 stops ÷ 13 reps
  = 15 a day, exactly `pm_daily_cap`) while reps are actually completing about 11. **The first
  plan-vs-actual report every manager opens will say that every rep missed half his plan in week one,
  and the plan size is the reason.**
- **Six of 13 reps logged zero pharmacy visits** and nobody has used the standalone pharmacy button —
  a discovery problem that will read as "these reps do not visit pharmacies".
- **AM volume is low (21–22 a day company-wide) and one rep has no AM visit at all in three days**
  (Ahmed Farag Soliman Elakraa). AM is the list that carries validation plus the Google check, so a
  low AM count may be measuring the gate rather than the rep.

---

## 5 · Who is reading it

| | Events recorded, 4–5 Oct |
| --- | --- |
| Each medical rep | 3,384 – 8,334 |
| District Sales Managers | 24 – 1,256 (Dina Hamdy Fadel Mohamed Bdair 1,256 · Nermeen Salah Abdelaty Abohussien 870 · Mahmoud ElHassanin Imam Muslim ElHassanin 480 · Salim Salim Abdo Ibrahim Gomaa 24) |
| SFE Manager (Khaled Mohamed Ali Bedair) | 550 |
| Senior District Manager (Taha Mohamed Taha Elsayed AboElftouh) | 144 |
| National Sales Managers | 139 (Magdy El Senosey Helmy AboElsebh) · 81 (Ali Mohamed Ali Elsayed) |
| Product Manager (Ahmed SharafEldeen Ahmed GadElkareem) | 1 |

**The reps are carrying the module and the top of the chain has barely opened it.** The exceptions
board, the place-vs-actual report, the adoption board, the brick coverage board and the 14 reports
were built for readers who are averaging under 150 events in two days.

---

## 6 · What was already fixed while this was being measured

- **The Google-mismatch refusal recorded nothing until this morning.** `phoenix_crm_refused_readings`
  accepted `no_fix` and `rough` only; the mismatch that blocked two reps on مستوصف صدر باجور for a
  whole morning on 5 October left no row in the board built to show refusals. Migration
  `20261005093000` added `off_listing` and it is applied in production. There are 0 such rows yet
  because the fix landed after the refusals.
- **The name-match tolerance that caused that refusal is still open.** `listingIsAccount` allows a
  name of three or more distinctive words to miss one, so Google's listing for a *different* facility
  is accepted as the account — proven in production by the approved review for مستوصف صدر المحلة,
  which stored the listing "مستشفى صدر المحلة الكبرى" at **3,304 m**. Exposure: 911 AM customers, 277
  with three or more distinctive words, 1,257 collision-prone pairs.

---

## 7 · Reproducing this

Every figure above comes from read-only SQL against the production project `ozucdzovmcqvepbozvqf`,
over `phoenix_crm_visits`, `phoenix_crm_customers`, `phoenix_crm_places`,
`phoenix_crm_refused_readings`, `phoenix_crm_location_integrity`,
`phoenix_crm_behaviour_integrity`, `phoenix_crm_photo_fingerprints`, `phoenix_crm_touch_trail`,
`phoenix_crm_plans`, `phoenix_crm_plan_items`, `phoenix_crm_day_starts`,
`phoenix_crm_validation_reviews`, `phoenix_crm_countable_visits` and
`source_of_sales_customer_map`. Visit days use `((captured_at - interval '2 hours') at time zone
'Africa/Cairo')::date`, the module's own 02:00 business day. Nothing was written.
