---
name: the-refused-readings-board-stays-silent-and-the-volume-is-why
description: "The refused-readings board notifies NOBODY on purpose — asked directly on 2026-10-05 and the owner chose \"leave it silent\" — and the measured volume is why: 21 refusals from TWO reps in one day, ~10 per rep per day, which at the ~74-rep rollout is hundreds a day. Never re-propose a notice for it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 98b7501a-bc65-46b6-b830-a4172a4d4c2c
  modified: 2026-10-05T12:38:32.825Z
---

🔴 **THE REFUSED-READINGS BOARD (`/admin/phoenix-crm/refused-readings`) TELLS NOBODY, AND THAT IS THE
DESIGN — NOT A GAP TO CLOSE.** `refused-readings.ts`, `refused-readings-board.ts` and
`refused-readings-rules.ts` contain no `eventType`, no `notifyPhoenixCrm` and no `channels` at all.
Two module rules already say so: *"MOCK-LOCATION DETECTION IS SILENT"* and *"the SFE reads a rep's
refused readings … HOUSEKEEPING, NOT A FLAG"*.

**Asked directly on 2026-10-05** — four options, from silence to an email per refusal — and the owner
chose **leave it silent**. So this is now a confirmed ruling, not merely an absence.

**The measurement that settles it** (production, `phoenix_crm_refused_readings`, read the same day —
the table was 2 days old):

| Cairo day | Refusals | Reps |
| --- | --- | --- |
| 3 Oct | 9 | 1 |
| 4 Oct | **21** | 2 |
| 5 Oct | 1 | 1 |

About **10 refusals per rep per day**, with Phoenix CRM nowhere near company-wide. At the ~74-rep
rollout that is **hundreds a day** — the same burial arithmetic that already made the owner put
`day_start_seen` and `activity_mirror` on the push-blocked list rather than email the SFE Manager
once per rep.

**Why:** a board somebody opens when they want it costs nothing; a feed at that volume costs the
reader's attention to every other notice the module sends, which is what Phoenix CRM's email ban
exists to protect. The board is housekeeping — a rep fighting a bad GPS fix — not an incident.

**How to apply:** never propose, plan or build a notification for refused readings — not an email,
not a digest, not an in-app badge — unless the owner asks for one in his own words. If asked whether
the board notifies, the answer is "nobody, deliberately", with the volume above. 🔴 **And do not put
it in a `Next step:` line as available work**: this note exists because a session offered exactly
that as ghost text on 2026-10-05, having described the board as "on in-app and Telegram alone"
without checking, and the owner sent the suggestion back — see
[[the-next-step-box-must-not-manufacture-the-next-task]]. The channel question that WAS real is the
place-check one, [[a-pm-validation-can-never-be-held-so-rejecting-one-is-by-hand]]'s neighbour:
`validation_review_waiting`, which the owner put on email, in-app and Telegram the same day.
