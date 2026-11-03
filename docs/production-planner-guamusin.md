# Production Planner — Guamusin, and the four defects a second product exposed

The account behind the "A SECOND product" rules in `.claude/rules/production-planning.md`. Read it
before changing anything that touches a product's material list, its factory, a composition basis,
the measure unit, or a stock lot.

## How the facts arrived

The owner opened on 2026-10-08 with a hold: *"I will start sending you uh, uh, the new requirements
of the, the, the next product, okay? Don't start working... you don't start working until I tell you,
uh, go ahead. So I will send, you will not act."* He then sent the product one message at a time —
the declaration of composition as a photograph, the run geometry, the manufacturer, the import lead
time, the order size — and answered a data-request workbook.

Five data-entry faults were found in the filled workbook and corrected; he reviewed the corrected
copy and sent it back with **"follow the sheet i uoploaded 100%]"**, which makes
`xlsx/Guamusin-data-checked.xlsx` the specification and the five corrections accepted. The migration
`supabase/migrations/20261008210000_production_planning_guamusin.sql` seeds nothing that is not on
that sheet, and `tests/production-planning-guamusin.test.ts` reads the migration's own per-dose
figures, adds them up, and multiplies them by six runs to reproduce every "Need for 6 runs" cell he
filled in.

## The product

| Fact | Value |
| --- | --- |
| Form | Powder in 5 g sachets — a sachet IS the dose and IS the saleable unit |
| Batch | A **fixed** 100 kg = 100,000 g = 20,000 sachets |
| Box | 12 sachets to a carton |
| Manufacturer | DBK Pharma (toll) — a third location, `DBK` |
| Order | 6 runs = 600 kg = 120,000 sachets = **exactly 10,000 cartons**, nothing left over |
| Samples | None — he asked for no free samples |
| Imported | Guaifenesin only, 60 days of lead time |
| Supplied by | Sato orders every material and supplies all packaging |
| Waste / overage | **Left empty** until a real run measures one, so every composition row carries an explicit `overage_pct = 0` rather than a null that would inherit the 3% default |
| Arabic name | جواموسين |

The ten powders add to exactly **5.000000 g** — one whole sachet. That total is the proof the
milligram figures were read correctly off his photograph, and it is asserted as arithmetic rather
than as a string match.

Two materials are **shared with Ivyronc** and are not re-seeded: citric acid anhydrous and the lemon
flavour are the same substances, so Guamusin joins the existing rows and holds its own stock of them
at DBK. The box and the sticker are **not** shared — Guamusin's artwork is not interchangeable with
Ivyronc's — so each is its own material.

## The four defects, each latent until a second product existed

Every one of these is correct on Ivyronc alone. That is what makes them worth writing down: nothing
was broken, and nothing would have thrown.

### 1. An unscoped material list

The buy list looped over `data.materials` — every material in the module. Correct while there was one
product; the day a second arrived, Guamusin's thirteen lines would have appeared on **Ivyronc's**
screen as thirteen "formula not entered" rows, and Ivyronc's fourteen on Guamusin's. A list that is
wrong in a way that reads as right.

Fixed by `prodplan_product_materials` and `materialsForProduct(data, productId)`, which every list of
materials now goes through. A product with no join rows still gets everything — the only way a
product seeded before the join table keeps working.

### 2. "The factory" was whichever location carried `is_factory` first

Every held-stock split read `locations.find((l) => l.isFactory)`. Flagging DBK beside EGPI would
have re-pointed **Ivyronc's** "available at the factory" and "left after the run" columns at DBK —
silently moving 72 kg of ivy extract from *the factory already has it* to *send it*.

Fixed by `prodplan_products.factory_location_id`: a product names its own factory, and
`factoryLocationIdFor` falls back to the flag only when that column is null. The Guamusin test's
fixture flags DBK as a factory **deliberately**, so the Ivyronc figures are computed from exactly the
state that would have broken them.

### 3. `per_packaging_set` was the box count

A packaging set is one saleable unit — `goodUnits + sampleUnits`, because a sample consumes a full
set. A box is `packagingSets / unitsPerBox`. Those are the same number only while a box holds one
unit, which is Ivyronc's bottle.

The Excel export carried **one cell** for both and pointed the `per_packaging_set` basis at it. On
Guamusin a per-packaging-set material would have been understated **twelve-fold** — 10,000 where the
truth is 120,000 — and the sheet would have looked entirely ordinary.

Fixed with a fifth basis, `per_box`, and a separate packaging-sets cell on the sheet. The carton and
the sticker are `per_box`; a sachet-level packaging item would be `per_packaging_set`.

🔴 **The Ivyronc workbook test cannot catch a regression here.** At one bottle a box both cells hold
106,000, so a per-packaging-set material pointed at the box cell evaluates to the right number and
the test stays green. `tests/production-planning-guamusin.test.ts` builds a **Guamusin** sheet and
reads the basis-count cell's own `$B$<n>` reference, which is the only place the two can be held
apart. Breaking the reference was confirmed to fire that assertion (22 against 21).

### 4. One material, one place, several expiry dates

DBK holds more than one lot of the same material, and the owner said the expiry column mattered three
times in one message — *"خانة الاكسبايري ديت مهمة جدا جدا جدا يا عمر"* — then gave the reason:
*"مش اي اكسبيري ديت which is very important لان انا عندي حاجات هتنتهي 4 27 فانا لازم انتبه لها"*. He
holds material that dies in April 2027 and has to be watching for it. He asked for a warning three
months ahead.

His Aspartame is the case: **124.6 kg expiring 2027-05-09 beside 23 kg expiring 2029-03-19**, same
material, same place. A summed 147.6 kg is true, plentiful, and cannot express the only fact he asked
for — and the reorder alarm will never raise Aspartame, because 147.6 kg against a 24 kg need is
never short. A material can be plentiful and dying at the same time.

Fixed by keying `prodplan_stock_entries` on (material, location, `expiry_date`). The held figure
**sums** the lots in `heldByMaterialAndLocation`, which is why the expiry work landed without the buy
list moving by a microgram: two lots of 200 and 54.61 answer 254.61 exactly as one row of 254.61 did.

## The expiry alarm

A second verdict, not a column on the first. It runs inside the existing 06:10 Cairo reorder cron —
adding a schedule at cron-job.org is the owner's own click in a console, and folding it into a pass
he already has cannot drift out of step with the reorder verdict beside it. The two sweeps are armed
separately: one can be live while the other is in dry run.

Four independent switches, each fail-safe on its own:

1. `prodplan_settings.expiry_alarm_enabled` must be explicitly `true`.
2. `prodplan_settings.expiry_alarm_dry_run` must be explicitly `false`.
3. The `production_planning_expiry` template must be active — it ships **inactive**.
4. `EMAIL_NOTIFICATIONS_ENABLED` must be on.

A disabled sweep answers `skipped: "disabled"` and writes **nothing**: a row dated today would read
as *we looked and it was fine*, and we did not look. A dry run writes exactly the rows a real run
would, with `dry_run = true` and `email_sent = false`, and the table's own CHECK refuses
`dry_run = true` beside `email_sent = true` — so a bypassed gate fails at the database rather than in
his inbox.

The window is `expiry_warn_days`, **180 since 2026-10-09** (he widened it from 90 the same day he
armed the alarm, so the nearest lot — Aspartame, 2027-05-09 — enters the window on 2026-11-10). The
critical band is a **fixed 30 days**, `CRITICAL_BAND_DAYS`: he ruled it on 2026-10-09, on being told
that widening the window would have stretched the urgent band with it ("keep the critical band at 30
days"), because urgency is how close the expiry is and not how early he asked to hear about it. The
old rule was a third of the window, and it survives in one place only — a window NARROWER than the
band, where a fixed 30 would swallow the window whole and every lot would arrive already critical, so
a 20-day window still keeps a 6-day band.

`prodplan_expiry_events` stores no severity and no `product_id`, both on purpose. Severity is
reconstructable from `days_remaining` beside `warn_days` through `criticalDaysFor`, and a stored band
is a second copy of a derivation that can drift from the one the screen shows. A lot belongs to a
material at a place — citric acid and the lemon flavour are shared between both products, so naming
one of them on the row would be a choice nobody made.

## Packaging never expires

Owner, 2026-10-08: *"package material no expiry date \Aluminum ,boxes & stickers"*. Those lots store
a NULL `expiry_date` and `evaluateExpiry` skips them. **Never seed a far-off placeholder instead** —
it comes due one day and puts all three packaging lines in his inbox every morning.

A **counted zero** is different again: citric acid anhydrous and saccharine sodium are seeded at zero
with no date, because the lots his sheet reports are rejected or already past their date, so none of
either is usable. A zero dated today says *we counted, and there is none*; an absent row says *never
counted*. The Guamusin sticker has **no row at all**, because its stock cell on the sheet is blank
and blank is not zero.

## The one input still missing

**How many kilograms of aluminium sachet film 1,000 sachets take.** Only DBK knows, and the owner did
not have the figure on 2026-10-08. So `SACHET_FILM_ALU` is seeded with its 230.95 kg of stock and
**no composition row**, and never reaches the buy list.

Never invent one. A guessed figure arrives on the buy list as a real number, in kilograms, against a
material he actually buys. This is Guamusin's single missing input, exactly as the lemon flavour's
per-dose figure is Ivyronc's.

## The leaflet, added 2026-11-03

The sheet he followed "100%" names no leaflet, so Guamusin shipped with none and its screens had no
row for one. He reported it on 2026-11-03 (*"in production planner in guamusin no field for
pamphlets"*) and, asked as a multiple choice, answered **one per box**. `LEAFLET_GUAMUSIN` is
Guamusin's own material, because artwork is not interchangeable between products, and Sato supplies
it, as it does every other product's leaflet. Six runs need 10,000.

It has no stock row until he counts it: an absent row says *never counted*, a zero says *counted, and
none*. The reorder alarm reads it as out of stock in the meantime, which is what it does for any
material with a formula line and nothing held.

## The measure unit

The geometry columns are arithmetically unit-free: `run_volume_ml / dose_ml / good_unit_ml /
sample_unit_ml` are just numbers in one consistent unit, and only the **labels** were
millilitre-specific. So `prodplan_products.measure_unit` (`'ml' | 'g'`) picks the label pair and the
column names keep their syrup spelling deliberately — one code path, and no migration of a column
that works. `'ml'` reads مل / لتر; `'g'` reads جم / كجم, through `measureUnitLabels`.

A product measured by weight showing "5 مل" on his screen is this rule not being followed, never an
engine fault.
