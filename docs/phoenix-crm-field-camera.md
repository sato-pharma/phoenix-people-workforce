# The Phoenix Camera — sealed offline photos for "Validate with my photo"

Owner, 20 Nov 2026: a separate Android camera app, not part of Phoenix, that photographs the place with the time,
date and location, works in a clinic with no network, and is sent to the System Administrator on a call — "I'll
build my own, but you must take every precaution against fake locations and fraud, and keep its seal".

## The two halves

| Half | Where | What it does |
| --- | --- | --- |
| The camera | `sato-pharma/phoenix-field-camera` (private; a separate repository, never under `mobile/`) | Live camera only, the phone's position and the satellites' time, a stamp burned into the picture, and a seal signed by a key held in the phone's secure chip. Built and signed by that repository's `build` workflow. |
| The verifier | `src/lib/phoenix-crm/field-camera/` (the browser-safe format and the payload rules), `src/lib/phoenix-crm/server/field-camera-seal.ts` (the signature and the phone's chain) and `src/lib/phoenix-crm/server/field-camera.ts` | Reads the seal from the uploaded file and decides whether it may stand in for the rep's live reading. |

## The file

`JPEG | seal JSON | uint32 big-endian length of the seal JSON | "PHXSEAL1"` — a viewer stops at the JPEG's end,
so the file still opens as a photo. The seal JSON is `{v, payload, sig, chain}`: the payload is JSON text naming
the JPEG's SHA-256, the rep, the fix, the satellites, the three clocks and the phone's own checks; `sig` is
ECDSA-SHA256 over the payload's bytes; `chain` is the Android key attestation chain, leaf first.

The rep sends it on WhatsApp as a **Document** (the app shares it as `application/octet-stream`), because a photo
sent as a photo is re-compressed and its seal is gone.

## What Phoenix refuses, and the trick each refusal stops

| Refusal | Trick |
| --- | --- |
| A changed byte in the picture or the stamp | editing the photo or its stamp |
| A signature not made by the attested key | a seal copied from another photo |
| A chain not ending at Google's attestation roots, or a revoked certificate | a key made outside a real phone |
| A software-only key, an unlocked or unverified boot | a modified phone that can sign anything |
| Another package or another signing certificate (`FIELD_CAMERA_SIGNING_DIGEST`) | a look-alike app |
| A fix marked mock, or a fake-location app switched on | a fake-location app |
| Root, an emulator | a phone that can lie about everything |
| A position not from the phone's own location service (`gps`, `fused`, `network`), a satellites-only fix with fewer than 4 satellites, taken more than 2 minutes before or 30 seconds after the shutter | a position typed in or from memory |
| A position the phone is 98% sure of only to more than 74 m (`accuracyMeters` over 40) | a position too loose to tell one clinic from the next |
| No named time source (`satellites`, `phoenix`, `phone`) | a seal that hides where its time came from |
| The satellites' time more than 10 minutes off Phoenix's clock (when the time is the satellites' and the phone has read Phoenix's) | a spoofed satellite signal |
| Older than 72 hours, or in the future | a photo kept for later |
| A seal already used (`seal_id`, partial unique index ignoring cancelled watches) | one photo for two customers |

Developer options, USB debugging, the phone's own clock off the time used, a time from the phone's own clock, and
a position taken more than a minute before the photo (`SEAL_OLD_FIX_NOTE_MS`) are **warnings**: shown to the Super
Admin, deciding nothing.

### Inside a building: the photo at once, the location locked after

Owner, 20 Nov 2026: *"they're going to capture the pictures inside of buildings, inside of polyclinics"*, then
*"I don't want him to wait for the satellites ... he can take the photo now ... make sure the location is 100%
accurate, or at least 98% accurate"*. From version 1.2.0:

- **The location starts when the app opens** and runs two sources side by side: the phone's combined position
  (Google's fused location, which answers inside a polyclinic within a second or two) and the satellites alone.
- **The shutter is never held back by the location.** The photo is taken at once; the camera then seals it with
  the most accurate reading from 2 minutes before the shutter to 20 seconds after it, the moment one is within
  20 m (Android's 68% radius; 98% within about 37 m), or after 20 seconds the best within 40 m. With none the
  photo is not kept and the rep is told to step near a window or the door.
- **"98%" is computed, not claimed:** Android's accuracy is the 68% radius, and the 98% radius of a circular
  normal spread is 1.853 times it (`RADIUS_98_FACTOR`). The stamp shows "98% within N m"; Phoenix refuses past
  `SEAL_MAX_ACCURACY_METERS` (40 m, 98% within 74 m).
- **The time comes from the satellites, then Phoenix, then the phone.** The satellites' UTC is pinned to the
  phone's uptime counter (which changing the time in Settings does not move), so a photo taken indoors an hour after
  the last satellite fix still carries the satellites' time; it is forgotten when the phone restarts. The seal
  names its `timeSource`; a time from the phone's own clock is a warning.
- **A fake-location mark refuses the photo on every source.** A mocked reading in the last 30 seconds stops the
  shutter and the seal, whichever provider it came from.

The seal's `fixAgeMs` is positive for a reading before the shutter and negative for one just after it
(`SEAL_MAX_FIX_AGE_MS` 2 minutes, `SEAL_MAX_FIX_AFTER_MS` 30 seconds, a margin over the camera's 20). Four
satellites are asked of a `gps` reading only. A 1.0.x or 1.1.0 seal (always `gps` and `satellites`) still passes
under the same limits.

`checkFieldCameraPhoto` runs **before** the photo is stored. A passing seal creates the watch already captured,
with `rep_source = 'sealed_photo'`, the seal's fix in the `rep_*` columns and `seal_report` (no photo bytes, no
key); `phoenix_crm_validate_with_admin_photo` then validates it exactly as a live one, still under the 250 m
reading rule. The live path reads only `rep_source = 'live'` watches.

## Camera 2.0 — the rep's own offline visit app

The owner, 20 Nov 2026: each rep logs in with his HR ID and Phoenix password, sees his own list and today's plan,
chooses Planned, Unplanned or Add new customer, and takes the photo; "if he has network the application refuses
and tells him go validate in the main account"; and "we're not relying on WhatsApp ... the application will
synchronize with Phoenix ... the validation will register and the visit will register". He chose: no numbers on
the rep's screens, the same visit form as the main account, the sync sending itself when the network returns, and
a new customer goes as a request for approval.

Phoenix's half is two doors, both the app's alone (`captureClientOf` = `app`, a bearer token and no session
cookie; a browser is answered 404):

| Door | What it does |
| --- | --- |
| `GET /api/phoenix-crm/field-camera/pack` | What the phone keeps for a day with no network: his territory, his customers with today's plan, whether each is validated, what he discussed last time, and the line's products. Read from `loadVisitForm`, so the camera can never offer a customer or product the main account would not. |
| `POST /api/phoenix-crm/field-camera/sync` | One sealed photo (base64, at most 15 MB) and the visit it was taken for. |

The sync, in order (`src/lib/phoenix-crm/server/field-camera-sync.ts`):

1. The seal is judged in full by `checkFieldCameraPhoto`, exactly as for the Super Admin's upload.
2. The seal must carry a **visit block** — `{seatId, customerId, visitId, offline: {anchorId, elapsedMs, bootId}}` —
   inside the signature, so nothing sent beside the photo can move it to another customer, territory or day.
   It must name THIS rep (`hrId`) and THIS territory.
3. A customer with no place is validated on the seal (`validateWithRepSeal`), the rep as the actor, through the
   same door as every validation (status, an existing place, `blockedReasonFor`). A customer who already has a
   place is not touched.
4. The visit is saved by `saveVisit`, unchanged, as the app: the seal's position is its reading and the seal's
   offline clock dates it (anchor plus uptime, never the phone's clock). Every field that says who, where or when
   is taken from the seal AFTER the body's fields, so the body cannot override one.

A resend of the same sync is the same visit (the same uuid) and the same seal (`allowResend`: a used seal whose
every use was this customer counts as a resend, never a second validation). What goes back to the phone is
"recorded" or the refusal's plain words — no distance, accuracy or check is named (golden rule #1).

## Camera reviews — Phoenix rejects nothing, the Super Admin decides

The owner's rulings of 20 November 2026: *"Phoenix will not reject anything … leave the decision to the decision
maker."* Every photo the camera syncs becomes one `phoenix_crm_camera_items` row, keyed by the seal's visit id so a
resend is the same item, and the phone hears one answer: received. The rep's screens say "sent" and nothing else.

**Nothing records itself** (owner, 21 November 2026: *"EVERY VISIT GOES TO CAMERA REVIEWS EVERY VISIT"*, *"EVERY
VISIT GOES TO MANUAL REVIEW FIRST"*). Every item **waits** for the Super Admin, with every check beside it
(`cameraArrival` in `src/lib/phoenix-crm/camera-item-rules.ts`): a failed seal, the next day (the Phoenix day ends at
02:00 Cairo), no location, a time not confirmed, a new customer, a name photo to check, and a visit over the day's
allowance. One with no reason reads "Every check passed". Over 36 hours old it goes to the archive. Until 20 November an
item that passed every check under the daily limit was recorded at once; those rows stay in Recorded.

**The day's allowance** (owner, 21 November 2026: *"U ARE ALLOWED 3 A DAYS IF MORE NEEDED WE NEED APPROVAL FROM
MANAGERS VIA EMAIL AND SYSTEM ADMIN WILL UPDATE IT FOR THIS DAY ONLY"*). Approve records at most the daily limit of
camera visits for one rep's Phoenix day (3 by default, the Daily limit tab, 1 to 20, in
`phoenix_crm_settings.camera_daily_cap`); the next one is refused with the count. Once the manager's approval is in by
email, he raises that one rep's one day on the visit itself, writing the approval beside it
(`phoenix_crm_camera_day_allowances`, one row per rep, day and test world; service role only). The rep is never told.

**The time** is Phoenix's own anchor when the seal carries one, else the satellites inside a seal that holds, else
"time not confirmed". **The location** is the closest good fix within ten minutes of the shutter; the page shows the
gap, the rep sees no numbers.

**Name photos and business cards.** A name photo goes through the photo reader, and its verdict is written beside the
item; an unclear one is flagged "Name photo to check". A business card is always flagged, and counts only beside a
location inside the polyclinic. A customer whose
name photo waits is not refused a third visit, and a building with no timetable is never refused for one.

**The page** — `/admin/field-crm/camera-reviews`, the Super Admin's alone (`canEnterMissedRecords`), never the SFE. Tabs:
Waiting, Recorded, Archive, Daily limit. Each row shows the photo, the rep, the time taken and the time it arrived, every
check, and the seal in red when it failed. **Approve** records the visit through his *Record a missed visit* door, in his
name, up to the rep's allowance for that day; **Reject** on an item recorded at once before 21 November takes it back
whole. Routes: `camera-reviews/decide`, `camera-reviews/cap` and `camera-reviews/day-allowance`, all at
`phoenix_crm` `update` behind `assertSameOriginMutation`.

**A test account's item names the test login** (owner, 23 Nov 2026: "if a record is done by test account, show that this
is the test Ibrahim"). A test account files under the HR id of the person it mirrors, so its item read exactly like that
person's own work. `cameraSenderName` (`camera-item-rules.ts`) prints it as the test login is named, "Test · Aya Ibrahim",
and the row wears a "Test account" tag; a real rep's item keeps his own name. The same day the six items the Aya Ibrahim
test login had sent (20–21 Nov) were deleted with their photos, on his word ("Camera items only" — the test visit, places
and plans it made stay); their rows are kept in `phoenix_crm_backup_20261123.aya_test_camera_items`.

**The update button.** `scripts/phoenix-camera-publish-release.ts` uploads a signed APK under `releases/` in the same
private bucket and writes one `phoenix_crm_field_camera_releases` row; every pack then carries it as `latestApp` with a
link that lasts a day. A dry run is the default; publishing reaches every rep's phone and is the owner's word alone.

## The signing key

PKCS12 at `C:/Users/satoh/.phoenix-secrets/phoenix-camera/` with a copy in `F:/Phoenix Secrets Backup/phoenix-camera/`;
in the camera repository it lives only in the secrets `PHOENIX_CAMERA_KEYSTORE_BASE64` and
`PHOENIX_CAMERA_STORE_PASSWORD`. The certificate's SHA-256 is `FIELD_CAMERA_SIGNING_DIGEST`. A new key means
a new digest in Phoenix in the same change, and every phone reinstalling the app. Losing the key means the same.

## Tests

`tests/phoenix-crm-field-camera-seal.test.ts`, with fixtures from `scripts/field-camera/make-seal-fixtures.mjs`
(openssl; its private keys are made in a temporary folder that is deleted on exit, and only certificates and
signed files are kept).
