# The car odometer reader

A car trip's kilometres are read from its arrival and departure photos, never typed (owner, 23 Nov 2026:
"the system reads the odometer from the car photo"; 136 of the 207 car claims filed since July had typed 0 or
nothing). Code: `src/lib/outstation/odometer-scan.ts` (the AI call) and `odometer-scan-rules.ts` (everything
pure). Desk check: `approvals/checks.ts` (`odometerCheck`, chained by `findOdometerChains`).

## How a photo is read

- **One look through the one AI door, on the strong tier, with the photo four ways:** as taken, a quarter
  clockwise, a quarter anticlockwise, upside down (`ODOMETER_VIEW_TURNS`). The reader picks the view whose
  odometer digits stand upright and reads it there (`upright_image`), and counts the digits first (`digit_count`).
- **Refused once, never twice.** An unreadable photo, or a departure reading below the same trip's arrival
  reading, is refused with what to do. The phone counts `odometer_refused` answers and sends the count; from the
  second photo on it is kept `unreadable` with `refusedTries`, and the desk's Odometer check fails so the approver
  reads the photo.
- **The system's own failure never refuses anyone.** No key, a failed call, an answer that is not JSON, or a photo
  the server cannot turn: the photo is kept `not_read`.

## Why it is built this way (25 Nov 2026)

Dina Hamdy (District Manager, Delta) drove to Kafr El-Sheikh on 25 Nov (claim 422). Her car shows the kilometres
on a narrow green strip whose digits stand on their side in a phone photo.

- Her arrival photo was refused 22 times between 10:54 and 11:51 Cairo. It was kept at 11:52 only because the
  reader broke ("ran out of room… max_tokens", 600 output tokens). The photo is sharp and lit, and shows 481,442 km.
- In the evening her departure photo was refused at 18:25 and accepted at 18:26 (481,456 km). She reported about
  half an hour of retakes; the departure route logs no refusals, so the evening count cannot be read back.
- **PR 781** gave the reader 2,000 tokens of room, made the refusal happen once, and added the backwards-reading
  check (claim 423: 57,108 km on arrival, 51,109 km at departure; the photo shows 57,109).

Re-running the reader on her two stored photos with production's keys:

| Reader | Arrival (481,442) | Departure (481,456) |
| --- | --- | --- |
| Cheap tier, photo as taken (before) | refused 4 of 4 | right 2 of 4, **148,456** 2 of 4 |
| Strong tier, asked which way to turn | the turn it named was wrong 3 times of 4 | |
| Strong tier, photo turned anticlockwise | right | right |
| Four views in one look | right, then **48,144** on 5 of 8 | right |
| Four views + "never drop a digit" + `digit_count` | right 8 of 8 | right 8 of 8 |

- **Never go back to asking the model which way to turn.** It judged by the speedometer numbers and the stamp
  text, not by the odometer digits.
- **`digit_count` is a counting aid, never a check.** Rollers show leading zeros (057108 is 57,108 in six digits),
  so a reading shorter than the count is not a misread.
- The same final reader on seven other stored photos, three reads each, gave the same answer every time: Saad
  Mohamed's 56,955 → 56,960 and 57,108 right, a second sideways display (claim 412) read 151,894, a street photo
  answered "not a dashboard". His 25 Nov departure photo (tiny digits, 57,109) is now refused instead of being
  misread as 51,109; with PR 781 the next photo is kept for the approver.
