---
name: a-refused-crm-save-is-traceable-only-in-the-upload-slot
description: "a REFUSED Phoenix CRM save left no reading anywhere until 2026-10-03 — read phoenix_crm_refused_readings FIRST for anything after that, and for an EARLIER one the only trace is phoenix_crm_photo_uploads / _voice_uploads with used_at NULL plus real bytes in storage.objects, which proves camera, mic, upload, network and session all worked"
metadata:
  node_type: memory
  type: project
  originSessionId: 1bbd035a-c8cc-4430-9c07-798a09c9000e
  modified: 2026-10-04T04:28:19.170Z
---

🔴 **FIXED FOR ANYTHING AFTER 2026-10-03, at the owner's instruction ("record the refused readings so
the next refusal is traceable"): a refused capture now files `phoenix_crm_refused_readings`** — the
coordinate, both accuracies, the line it missed, `reason` (`no_fix` | `rough`), the mock flag and the
Cairo visit day, written by `src/lib/phoenix-crm/server/refused-readings.ts` from all three refusing
doors. **Read that table FIRST.** Everything below is how to answer the same question about a refusal
from BEFORE that date, which is where this note was earned — and it is still the only way, because
nothing backfills.

🔴 **AND IT HAS A SCREEN SINCE 2026-10-04 — `/admin/phoenix-crm/refused-readings`, the Super Admin's and
the SFE Manager's** (owner: "build the refused readings view for the SFE"). It lists the last 14 days
per rep and whether each customer he was refused on was later SAVED; the phone's mock-location answer
shows for the Super Admin only. **Each refusal also shows the PHOTO the phone sent (owner 2026-10-04,
"show the refused photo on the refused-readings page") to both readers, signed through the scoped photo
route; a row with no kept pointer reads "None kept".** Read it before opening SQL. Logic is
`src/lib/phoenix-crm/refused-readings-rules.ts`, reader `server/refused-readings-board.ts`.

`phoenix_crm_location_integrity` is written **only when a place or visit actually SAVES**, so a
refused attempt before 2026-10-03 leaves no reading, no accuracy and no coordinate anywhere. Saying
"nothing is recorded since <time>" is therefore WRONG and it cost a whole audit on 2026-10-03.

**The trace that does exist:** `phoenix_crm_photo_uploads` and `phoenix_crm_voice_uploads` — one row
per attempt, `issued_at` set and **`used_at` NULL** — plus the file itself in `storage.objects` with
real `metadata->>'size'` bytes. Join them and a refused attempt is fully visible:

```sql
select (issued_at at time zone 'Africa/Cairo')::timestamp(0), purpose, used_at, path
from phoenix_crm_photo_uploads where issued_to_hr_id = '<B-xxx>' and issued_at >= now() - interval '9 hours';
select (created_at at time zone 'Africa/Cairo')::timestamp(0), (metadata->>'size')::bigint
from storage.objects where name like '<SEAT-ID>/%' and created_at >= now() - interval '9 hours';
```

**Bytes in storage prove a lot at once** — camera, microphone, upload, network and session all
worked, so whatever refused the save is SERVER-side logic, never the device. Yasmeen Samy (B-130,
`SEAT-CNS-REP-D11`) left **18 such rows between 16:12 and 18:47 Cairo**, every one carrying 4–145 KB
of real file, and not one `used_at`. `app_error_events` held nothing of hers and
`phoenix_crm_photo_fingerprints` is computed only after a save, so neither helps.

**What it proved that day:** her phone reported accuracy exactly **2000 m** all day (Android
approximate-location blurring, an exact 2 km grid point). That SAVED at 10:25/10:54/10:58/11:10 and
was flagged; [#5234](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/5234) ("both
readings within 100 m") merged **08:24:27 UTC = 11:24 Cairo**, 14 minutes after her last successful
save, and from then on the same reading is refused at the door. **The phone did not change — the code
did.** Read a rep's dead end against the deploy time before blaming the device.

🔴 **AND A PLACE'S `lat`/`lon` IS NOT WHAT THE PHONE SENT once `point_source = 'moved'`** — it is
where a manager later moved it, and `accuracy_meters` then reads NULL. Her four places read
30.4657…/30.4667… (four distinct hospitals, looking like a precise capture) while
`photo_lat`/`pin_lat` both held the SAME 2 km grid point at 2000 m. **Always read
`photo_lat, photo_lon, photo_accuracy_meters, pin_lat, pin_lon, pin_accuracy_meters, point_source`
for the raw readings**; the moved point nearly produced a published conclusion that her camera reading
was precise and only the button was broken. Both mechanisms get the same blurred fix — the photo's
`watchPosition` and the button's `getCurrentPosition` carry identical options.

🔴 **A reverse-geocoded address proves NOTHING about precision.** Her refusal screen showed a
plus-code street address in Banha 2 whose point decodes 49 m off the grid point: Google answers a
coarse query with the nearest addressable feature, so a street-level address on screen is NOT evidence
that the blurring stopped. The only proof is the raw `accuracy_meters` and whether the coordinate is an
exact multiple of 2/111° (a 2 km grid snap).

Related: [[a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360]].
