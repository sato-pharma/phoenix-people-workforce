# Phoenix CRM — validating a customer on a trusted point

## What he asked for

Owner (Super Admin), 10 November 2026:

> "what administrator validates will be validated as follow: we will search all locations for this customer in
> phx crm, then we will compare with the locations of checkins of this customer from the old crm until we find a
> trusted point or trusted average location... based on this location we will extract the brick, area and all
> what we need."

He chose to build it as **his** validation, with the customer's visits measured from that point.

The case that started it: Dr Bahaa Kamal (Pedia, Giza). His clinic has no signboard, so no rep can validate him at
the door. He therefore had no place, and none of his visits was ever measured. Yet the reps who call on him have
stood at the same door for months, both in Phoenix and in the old CRM. Their readings are the evidence.

## The readings

`gatherTrustedPointReadings` (`src/lib/phoenix-crm/server/trusted-point.ts`) reads three sets of rows.
`mergeTrustedPointReadings` (`src/lib/phoenix-crm/trusted-point-rules.ts`, pure and tested) then merges them:

- **Every Phoenix visit with a location.** Archived visits are left out.
- **Every place ever captured for him, retired ones included.** A rejected validation retires the place, but its
  readings are still real GPS fixes taken at his door. Each place gives two readings:
  - the photo's own reading, dated by the photo's capture (Cairo day);
  - the Capture-location pin, dated by the place's capture. A pin identical to the photo reading is counted once.
- **Every old-CRM (iReports360) check-in** of his reference contact or his own Phoenix contact id
  (`src/lib/crm/trusted-point-checkins.ts`). Only rows with `source <> 'phoenix'` are read. The unified view also
  mirrors every Phoenix visit at the visit's own coordinates (13,087 rows on 10 Nov 2026), and counting those would
  count each Phoenix visit twice.
- **A visit copied from iReports360** (`imported_from_ireports360_at`) is the same check-in again. It is skipped when
  its check-in is among the old-CRM rows read, and counted as one old-CRM reading otherwise.

One known gap: the old-CRM view leaves out departed agents, so their check-ins are not among the readings.

## The rule — `findTrustedPoint`

1. Drop a reading outside Egypt's field range, and a Phoenix reading less accurate than the visit's line
   (`VISIT_MAX_ACCURACY_METERS`). Old-CRM check-ins carry no accuracy.
2. Pick a seed. If there are any Phoenix readings, the seed is their per-axis median. Otherwise it is the reading
   with the most neighbours within 30 m.
3. The core is every reading within **30 m** of the seed (`TRUSTED_CORE_METERS`). Outliers, which ran from 80 m to
   6 km in the readings measured, fall outside it.
4. The point is the per-axis **median** of the core, never a mean.
5. The point is trusted only when the core holds at least **5 readings** taken on at least **3 different Cairo days**.

When the point is not trusted, the reason is written in plain English for the Super Admin, and there is no button.

## The place

- **Brick, area and region:** `resolvePlaceLocation` reads them from the point. It is the same resolver every
  captured place uses, with the seat's own area breaking a tie.
- **The write:** `phoenix_crm_place_on_trusted_point` (migration `20261110213959`) writes the place under the
  seat's lock, with `point_source = 'trusted'`, no photo, an empty timetable and a `trusted_basis` record of the
  evidence. The rep adds the days and hours later through the usual editor.
- **The customer:** a pending customer becomes active. A customer who is already active stays as he is, and the
  place is added to him.
- **The event:** it is recorded as `customer_validated` or `place_added`, with `mode: 'trusted_point'`.
- **His past visits:** after the write, they are measured against the new place (restamp, scope "unplaced").
- **What it refuses:** an archived customer, a customer off the list, a pharmacy, a customer who already has an
  active place, and a place still waiting on Place checks.

The table's CHECKs still require a photo on every place except one born on a trusted point.

The basis CHECK is deliberately one-way: a trusted place must carry a basis, but a basis does not require
`point_source = 'trusted'`. If the Super Admin later moves the place, it becomes `point_source = 'moved'`, keeps its
basis as the record, and still has no photo.

## Who can use it

- **Only the Super Admin.** The rule is `canPlaceOnTrustedPoint` = `canDecideSharedPlaces`: Super Admin with
  `update`, and never a test account. The route asserts `phoenix_crm:update`, and the service repeats the gate
  before it reads anything.
- **The button:** it is on the customer's page, only for a customer with no places, and labelled
  "Super Admin · trusted point".
- **The rep never sees any of it** (golden rule #1). On the rep's screen, a trusted place shows the plain
  "No photo" tile.

## The screens a photo-less place reaches

- **Photo thumbnails** take a `missingText` and say "Trusted point — no photo".
- **The nightly signboard reader** skips a place with no photo, in all three of its reads, and so does
  `scripts/phoenix-crm-reread-signboards.mjs`.
- **The fingerprint candidates** need no change: they already require a photo path.
- **`mapPlaceRow`** never stringifies a null path, because `String(null)` is the path "null", and the photo signer
  refuses a whole batch for it.

## The script

```
node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
  --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-trusted-point.ts \
  --customer <uuid> --actor <HR id> [--apply]
```

A dry run is the default: it prints the readings, the point or the reason there is none, and the brick and area. `--apply` writes one place for one customer.

Pinned by `tests/phoenix-crm-trusted-point.test.ts`.
