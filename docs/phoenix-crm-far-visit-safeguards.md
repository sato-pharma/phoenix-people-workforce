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
