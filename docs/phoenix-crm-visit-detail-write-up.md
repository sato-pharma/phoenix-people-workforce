# The rep writes up his own saved visit afterwards

The account behind the rule in `.claude/rules/phoenix-crm-visits.md` — *"the rep comes back to his own
saved visit and writes up its soft detail"*. Owner instruction, 15 October 2026.

## What he asked for

> they go from doctors to doctor and they may not have suitable time to do the full report needed by
> the company … in between the visits … I want them to be able to log as much fast as it could be. The
> most important thing for me is capture location while they log the visit and the time.

Then, in the same instruction, what must **not** become editable:

> they will not be able to edit in AM or PM … not whether it's single, double, or chain … not in
> product discussed.

And what must:

> the comment which they wrote while they were doing the visit, leave it and make them able to add
> another detailed comment … all the optional questions and features in logging a visit like at a
> pharmacy, what you left, did the customer push back, what did you do next, make this editable. They
> can go to the visit, press on it, have those things editable and another is non-editable. But
> anything edited, it should appear that this is edited in the date and time.

Three questions were put to him in chat the same afternoon, and he answered:

| Question | His answer |
| --- | --- |
| How long after the visit may he edit it? | **Any time** — no deadline |
| The pharmacy name he did or did not record at the door | **Add a name, never change one** |
| Who may fill in or correct the detail | **Only the rep** |

## Why the soft fields were empty before this

Measured on production in the module's first three live days: `next_step` filled on **1 visit of 332**,
`objection` on **2**, `samples_given` on **19**, `product_availability` on **77**. So `commitments.ts`,
`call-prep.ts`, `missing-stock.ts`, `samples-report.ts` and "What the field heard" were all running on
nothing — not because the fields are unwanted but because nobody answers eight questions standing in a
corridor between two doors. Before this change a saved visit could not be pressed at all: `VisitCard`
and `VisitTable` carried no `onClick`, no actions and no expand, and the module's only edit door was the
Super Admin's correction of **somebody else's** visit (`phoenix_crm_admin_edit_visit`, 2026-10-06).

## What moves, and what cannot

Editable by the rep, on his own visit: `detail_comment` (new, ≤ 2,000 characters), `objection` and
`objection_note`, `next_step` and `next_step_on`, `samples_given`, `product_availability`, and
`pharmacy_name` **only when the visit carries none** and the customer is not itself a pharmacy.

`next_step_on` gets an input here for the first time. The door form always sends it as `null`, so every
live row sits in `commitments.ts`'s "no day" bucket; the day belongs where he has time to think, and the
door form does not grow a step.

Frozen, and absent from the update statement column by column: `customer_id`, `visit_date`,
`captured_at`, `lat`/`lon`/`accuracy_meters`, `place_id`, `distance_meters`, `location_flag`, the photo
and the voice note, `capture_source`, `dwell_seconds`, `list_type` (AM/PM — copied from the customer's
own list, never a field he chose), `kind` and who was on the visit, `products`, and the off-plan reason,
which is an approval input. `kind`, `products` and the **door comment** stay the Super Admin's to
correct, exactly as shipped on 2026-10-06; this change neither widens nor narrows that door.

Two boundaries decided while building it:

- A visit carrying `linked_from_visit_id` — the pharmacy visit a doctor's visit filed — is not
  separately editable. Its detail belongs to the parent visit it came from, and the panel sends the
  reader back to it.
- A visit is the rep's when `rep_hr_id` is the actor. That includes a record the Super Admin entered
  for a visit he missed logging (he made the visit; the Super Admin only recorded it), and excludes a
  manager's own single visit, which carries no rep at all.

## The write path

`phoenix_crm_edit_visit_detail(p jsonb)` is `security definer`, shaped on `phoenix_crm_admin_edit_visit`:

1. `pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat))` — the same per-seat lock
   `phoenix_crm_save_visit` takes, so a save and an edit cannot interleave.
2. `select … for update`, scoped `id + seat_id + is_test`.
3. Refuse unless `rep_hr_id = v_actor` (`phoenix_crm:visit_not_yours`) and `linked_from_visit_id is null`
   (`phoenix_crm:visit_is_linked`); refuse a second pharmacy name (`phoenix_crm:pharmacy_name_fixed`).
4. **Drop, never raise**, an unknown `next_step` / `objection` / samples key, clearing each dependant
   with its parent — the rule `save_visit` already uses, for the same reason: a phone one release behind
   must not cost a rep the paragraph he has just typed.
5. A no-op short-circuits to `{visit_id, changed: false}` — no audit row, no write, no stamp.
6. The audit insert into `phoenix_crm_visit_edits` comes **before** the update, because production has no
   PITR; then the five soft columns and the two stamps.
7. A pharmacy name added here files that pharmacy's own visit on the parent's `visit_date`, by lifting
   `save_visit`'s `linked_pharmacies` block, and **skips** a pharmacy already visited that day rather
   than raising — `phoenix_crm_visits_one_a_day` is `(seat_id, customer_id, visit_date, is_test)` and one
   pharmacy counts once in a day.

## Why the stamp is the rep's own, and separate

`detail_edited_at` / `detail_edited_by_hr_id` are written **only** by this path. The Super Admin's
correction keeps writing to `phoenix_crm_visit_edits` alone, as it does today: *"the Super Admin corrects
a visit … and the rep is told nothing"* is settled, and one shared "edited" stamp on the row would show a
rep that his visit had been corrected. Because only the rep may edit the detail, his stamp is always
unambiguously his own work.

The marker follows the house rendering already in the Visit report generator
(`server/visit-report-values.ts`, `Yes · <date time>`), so every screen reads **"Edited · 15 Oct 2026,
6:30 PM"** in Cairo, never a bare badge. It shows on his own visit card and table row, on the day page a
manager opens, in the customer's timeline, and as two new Visit report fields (`detailComment` in
`content`, `detailEdited` in `when`) beside the existing `editedBySuperAdmin`.

## Two deliberate choices, stated

- **The detailed comment is not fed into "What the field heard"** (`field-heard.ts`). That report's quotes
  are the **customer's** words and are kept only where an objection was raised; a 2,000-character write-up
  in a quote cell breaks the fits-the-screen rule. It reads back on the visit card, the table row, the day
  page, the customer timeline and the two Visit report fields instead.
- **It is typed, not spoken.** `CrmSpeak` writes the words *and* keeps the recording as the visit's voice
  note, which is frozen evidence here; a second recorder would either overwrite that note or orphan audio.

## Reading the detail back

Nothing notifies anybody, in either direction — a rep completing his own report is not a check on him,
and the function queues nothing. The read (`server/visit-detail-edit.ts`) names no measurement at all:
its `VISIT_COLUMNS` literal simply never mentions `distance_meters`, `accuracy_meters`, `location_flag`,
`capture_source` or `device_skew_minutes`, the way `loadVisitEditForm` does it, because a field the
browser receives counts as shown.

Pinned by `tests/phoenix-crm-visit-detail-edit.test.ts`, ten sections, registered in
`tests/run-tests.ts`.
