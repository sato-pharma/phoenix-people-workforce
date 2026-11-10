# Phoenix CRM — the four far-visit safeguards

**Decided by the owner on 10 November 2026**, after one rep spent a working day refused at a doctor's door.
He asked *"how to avoid these issues so they never happen again?"* and chose all four answers; for the account
line he chose *"500 m"*. Rules: `src/lib/phoenix-crm/far-visit-safeguards.ts` (pure),
`src/lib/phoenix-crm/server/far-visit-safeguards.ts` (reads and writes). Pinned by
`tests/phoenix-crm-far-visit-safeguards.test.ts`. Migration: `20261110170000_phoenix_crm_far_visit_safeguards`.

## What happened

On 10 November 2026 Momen Fathy validated Dr. Doria Darraz indoors, on a stairwell. With no sky his phone
placed him from nearby Wi-Fi in Moharam Bek, 8.3 km from the clinic in El Raml, and claimed 46 m accuracy.
The photo's reading and the Capture-location pin were the same wrong point to the seventh decimal, so the
two-reading check caught nothing, and 46 m sits inside the place's 250 m line. Five minutes earlier his
visit to Al Hilal Hospital had saved in El Raml: 8.3 km in 5.3 minutes is 93 km/h through a city at midday.

From then on every visit he logged to her was measured against the wrong place and refused as away from the
place: 51 refusals while he stood at her door. Nothing told anybody. The place was moved by hand that
afternoon (Dr. Doria Darraz and Dr. Suzan Hamed, to his 13:06 El Raml reading).

## The four safeguards

| | What | Where |
| --- | --- | --- |
| A | **An impossible reading is refused at validation.** A place reading 3 km or more from the rep's own sharp visit (accuracy 50 m or better) saved in the last hour, at more than 80 km/h, is refused. So is the exact point (the same coordinates to the last decimal) already refused that way in the last 6 hours, because a Wi-Fi guess repeats itself. The rep reads "Your location has not settled yet. Step outside the building…", never a distance or a speed. Filed on the refused-readings board as `impossible_travel`. A photo reading judged impossible beside a good pin is filed too, and the place is saved from the pin. Judged from 10 November 2026 only; no place validated earlier is re-judged. | `judgeImpossibleLocation`, `IMPOSSIBLE_LOCATION_FROM_DAY` |
| B | **A stuck rep raises an alert.** The fifth sharp far refusal (accuracy 30 m or better) within 50 m of the same spot, on the same customer, on the same visit day tells the Super Admin and the SFE Manager once: in-app, on Telegram and the phone, never by email. Test seats raise nothing. | `stuckAtOneSpot`, `notifyStuckRep`, event `far_visit_stuck` |
| C | **Hold, don't refuse.** After those five, the rep's next visit from the same spot is SAVED and held. It counts in nothing (both countable views, `visitCountsInKpi`, the team page, the visit report) until the SFE approves it on **Visits Held for SFE** (`/admin/phoenix-crm/far-visit-holds`, the Super Admin and the SFE Manager only). Refused, it never counts. The SFE can also move the customer's place to where the rep stood, through the ordinary place move (written reason, 10 characters or more). The rep reads "Saved. This visit counts once SFE approves it." A rep who walks somewhere else is refused as before. | `holdInsteadOfRefuse`, `phoenix_crm_far_visit_holds`, `decideFarVisitHold` |
| D | **A wider line for an account.** An AM customer (a hospital or a pharmacy account) refuses a rep's visit only past 500 m; a PM doctor's clinic keeps the settings' 300 m. Only the refusal reads it: the visit's own location flag and every board keep 300 m, so nothing already measured moves. | `farRefusalLineFor`, `ACCOUNT_FAR_LINE_METERS` |

C bends the owner's 2026-10-20 rule that a rep's visit past the line is refused; it was his own choice.

## Why these numbers

Measured on production over the 30 days to 10 November 2026: of 12,244 consecutive readings within an hour
of each other (accuracy 50 m or better), 5 pairs implied more than 60 km/h over 3 km or more, Momen's
93 km/h among them. So 3 km and 80 km/h refuse almost nobody honest, and the refusal clears itself within
minutes (8.3 km is reachable again after about six).

Exact-duplicate coordinates are common on honest visits (53 pairs from 7 reps), so "repeats any earlier
point" would refuse honest reps. Only a point already refused as impossible is remembered.

The anchor is always the rep's latest saved visit, never a place pin and never a refused try. A wrong pin used
as an anchor would refuse every honest validation after it.

## The table and the views

`phoenix_crm_far_visit_holds` holds one row per held visit: status `sfe_pending`, `approved` or `refused`,
who decided and when, the try count and the spot. Service role only. The row is written before the visit
itself, so a held visit is never counted for an instant. There is no foreign key to the visit for that
reason.

`phoenix_crm_countable_visits` and `phoenix_crm_countable_visits_with_history` leave out a visit whose hold is
not approved, in the same shape as the recording review beside it. Until the first hold row exists, both
views return exactly what they returned before.

The refused-readings reason list gains a tenth value, `impossible_travel`. It may carry `distance_meters`
(to the rep's own visit) and never `place_id`.

The system audit's visit-lifecycle detector expects a held visit to be absent from the countable views
(exclusion `far_visit_held`), and its decision time is read as a fact that changed.

## What does not change

- No saved visit is re-judged and no existing row is touched.
- A visit a manager enters still saves, flagged, at any distance.
- The phone's offline queue keeps its own name, "held visit". This feature is always "far-visit hold" in
  code, so the two never share a word.
- Phoenix CRM sends no email; the alert is in-app, Telegram and the phone.

## Still open on 10 November 2026

Seven other reps refused at one spot that day were never checked.

## 11 November 2026 — the validation audit, and six gaps closed

The owner asked for every validation mistake in Phoenix CRM, its root cause and the gap behind it
("Build all six fixes"). Each number below was read on production that day, real work only.

| What was found | Root cause | What closes it |
| --- | --- | --- |
| 34 active places with a pin and a photo reading more than 250 m apart | The door never compared a capture's two readings | `readingsApartMeters` and `refuseReadingsApart`: a rep's place, a manager's capture and a venue are refused and filed `readings_apart` |
| 26 validated customers with no place (23 by an add approval, 3 stamped by hand on 29 October) | `phoenix_crm_decide_request` stamped `validated_at` whatever had happened to the door since the request was filed | The approval admits to "To validate" when no active place exists; two deferred constraint triggers refuse any other route |
| 41 rep visits since 20 October (13 reps) logged before the customer had a place, past the line of the place he was then validated at (300 m, 500 m for an account), all counting | The far rule lived only in the save | `visitsToHoldBeforePlace`: the re-stamp writes a `before_place` hold before it measures the visit |
| 722 far refusals on 181 places since 20 October; 74 customer-days stopped at two to four refusals | The stuck rule read one day | `STUCK_LOOKBACK_DAYS` = 7 |
| Nobody read any of it until five refusals in one day | No list | Places to re-check on the held-visits page, and three nightly checks |
| 30 active places with no brick | Saved before the seat's own area could reach past the trust radius | `scripts/phoenix-crm-refile-no-brick-places.ts` plans the re-file; a bulk change, applied only on the owner's word |

### Decisions worth keeping

- **The guard is two triggers, not one.** A `WHEN` clause may read `OLD` only on an update, and the update
  must ask only when the stamp goes from empty to set: an edit that carries `validated_at` along must never
  re-judge a customer. Both are deferred, so a function that stamps the customer and inserts the place in
  one transaction passes.
- **The triggers guard a NEW validation only**, so the doors that return a customer who already holds
  the stamp carry the test themselves (`20261111013233`, found by the review of the first file): a
  bring-back (`phoenix_crm_decide_request`, kind `restore`) and the Administrator's undo of a drop
  (`phoenix_crm_reverse_list_request`) put him on the list only while he holds an active place, and
  otherwise in "To validate" with the stamp cleared. His last place can be retired while he sits in the
  Archive, because a rejected venue or review un-validates only an active customer. The nightly check
  (`phoenix-crm-validated-customer-holds-a-place`) reads whatever is left.
- **An add that admitted to "To validate" can still be undone.** The Administrator's undo of an add
  required status `active`; it now accepts `pending` too. Anything that moved the customer since the
  decision is refused earlier in the same function, as before.
- **`phoenix_crm_reverse_list_request` on production was the October file's body with its comment lines
  removed** (md5 `8393e50a…` against the file's `6e7a1837…`). Read the live body before replacing a
  function: a hash that differs from the file is not always a different function.
- **The rep is told his location has not settled** (`READINGS_APART_REFUSED`): what is wrong with the
  capture, never the distance or the check's name, like every other capture refusal. It is not a fifth
  exception to the blind app.
- **A before-place hold leaves the counts until SFE decides**, like every hold: the countable views drop
  any hold that is not approved, whatever its basis. 12 of the 41 visits found on 11 November were double
  visits the rep entered with his manager beside him.
- **Pharmacies are exempt.** A pharmacy is validated by its own pin and holds no place row.
- **Test customers are not a defect.** 1,026 customers marked `is_test` were validated before 21 October
  with no place at all; nothing has validated a test customer without one since. Every count and every
  nightly check filters `is_test = false`.
- **A before-place hold holds only a visit never measured** (`location_flag = 'no_place'`). A moved place
  re-measures every visit, and holding those would un-count work the door once accepted.
- **A seated place is never filed on its own.** A seating copies its venue's location and never resolves
  it again, so the re-file script files the venue once and every seat in it takes that answer.
- **The migration went through `scripts/apply-sql-file.mjs`.** The database connector declined it on
  staging; staging also lacked the 10 November holds table, which was applied there first.

### The three nightly checks

`src/lib/reconciliation/checks/phoenix-crm-places.ts`, all `known-open` until the data is repaired:
every validated doctor and account holds a place; every active place holds a brick; no active place holds
two readings that disagree. The third reads the page's own list (`readPlacesToRecheck`), so the page and
the check cannot disagree.

### Still open on 11 November 2026

- The data repairs wait for the owner's word: 23 add-approved customers back to "To validate", 41 visits
  into holds, 29 places and 6 venues re-filed.
- Three hospital accounts stamped validated on 29 October with no place and no event: the writer was not found.
- 59 validated places with an unread signboard or timetable and no review were not traced.
- A before-place hold raises no notice of its own; the SFE finds it on the page and in the nightly check.
