# Phoenix CRM — the location warm-up, and why the camera waited

The validation camera keeps **Take the photo** switched off until it has a location reading. This page
explains why that wait was long, and what changed on 12 and 13 November 2026.

Code: `src/components/phoenix-crm/location-receiver.ts`, `live-photo-capture.tsx`, `capture-location.tsx`.
Test: `tests/phoenix-crm-photo-reading.test.ts` §3. Rule: `.claude/rules/phoenix-crm-validation.md`.

## What the owner saw

On 12 November 2026 the owner tested validation with a medical rep account during a training session.
The whole room did the same step at the same time. In his words, the "finding location" before the
capture took a very long time (12 Nov: "the location took hilarious time"; 13 Nov: "the finding location
… is taking very long time").

## What production recorded (12 Nov 2026, 15:53–16:33 Cairo)

- About ten people took part: eight trainee reps and the owner's test account. Between them they asked for
  25 photo upload slots, and only 6 photos went on to a saved place.
- **Every reading in the room was a Wi-Fi reading, not a satellite reading.** The one place saved from the
  test account carried a photo reading of ±68 m and a pin of ±77 m. Indoors, a phone gets no satellites.
- **The pin was saved 22.7 s after the photo.** The pin asks for a brand-new reading (`maximumAge: 0`).
  Indoors, that is how long one takes to arrive.
- **Three of the trainees (one iPhone, two Android phones) had location blocked** (eight
  `blocked/location` rows). That is a setting on the phone, not a wait.
- There were **many retakes**. Signboard refusals (`signboard_unreadable`, `signboard_no_plate`) sent
  people back to the camera again and again. Each retake started the location wait from the beginning.
- The phones were Android Chrome, iPhone Safari and iPhone Chrome. The test account was on a Windows laptop.

## The cause

The camera only lets the rep take the photo once it holds a reading. In three ordinary situations it
started from nothing and asked the phone for a brand-new, best-accuracy reading. Indoors that takes many
seconds, and can run up to the 30 s "Still finding your location" line:

1. **The warm-up never started for a first-time rep or an iPhone.** The warm-up (22 Oct 2026) keeps the
   phone's receiver running while a validation screen is open, but only where the browser says location
   is *already* allowed (`navigator.permissions.query`). A rep using validation for the first time (the
   whole training room) had not allowed it yet. An iPhone on Safari's default "Ask" setting answers
   `prompt` every time, even after the rep pressed Allow. In both cases there was no warm-up at all.
2. **Each retake threw the reading away.** The camera stops its own watch after the shot. With no warm-up
   running, the next Open the camera — after every refused signboard — started cold again.
3. **The 12 Nov fix accepted a warm reading only if it was under 15 seconds old.** A running watch reports
   again only when it has something new to say, so a phone standing still indoors can go longer than
   15 seconds without a new report. The one reading the page held was then thrown away.

## The fix

- **12 Nov 2026 (#295).** The warm-up keeps its newest reading, and the camera starts from it.
- **13 Nov 2026.** The camera accepts that reading up to `WARM_SEED_MAX_AGE_MS` (60 s) old. The reading is
  kept only while the warm-up's watch is still running (`stopWarmWatch` forgets it), and a running watch
  that has said nothing new means the phone has not moved.
- **13 Nov 2026.** The first reading the rep's own press produces — the camera's watch or the Capture
  location pin — calls `locationAllowedOnThisPage()`. That starts the warm-up for the rest of the screen,
  even where the browser's own permission answer said "not yet". Every retake then starts from a reading.
  The warm-up still never **asks** for the permission: only a reading that the rep's own press produced
  switches it on.

## What did not change

- The Capture-location pin and the shutter's fresh reading never read the warm-up's reading. Each stays
  its own fresh reading (`maximumAge: 0`), so the photo-versus-pin check still compares two readings and
  not one reading twice (`read-shutter-fix.ts`, 12 Oct 2026).
- The cold-receiver rule (22 Oct 2026) still judges every reading by when the receiver was switched on. A
  later reading that contradicts a cold one still wins.
- Nothing new is shown to the rep (Golden Rule #1).
- The very first reading on a page, before the rep has allowed location, is still a fresh one. The
  owner's rule says the warm-up never puts a permission prompt in front of the rep before he has pressed
  anything, so that first reading cannot come from the warm-up.
