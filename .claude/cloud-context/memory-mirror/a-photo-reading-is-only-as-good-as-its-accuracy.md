---
name: a-photo-reading-is-only-as-good-as-its-accuracy
description: "Before calling a CRM place's pin \"wrong\" because a visit sits nearer the photo reading, read `photo_accuracy_meters` — Afaf Abdel-Samee's photo reading was ±2,000 m, so moving the pin there would have cleared a real 'far' flag; the owner chose to keep the pin (2026-10-15)."
metadata:
  node_type: memory
  type: project
  originSessionId: 8e4ace51-3d8a-4c63-bf73-ae0867d641e6
  modified: 2026-10-15T17:16:43.434Z
---

On 2026-10-15 a fraud check on Georgette Hany Awad (Heliopolis, CNS) reported that Afaf Abdel-Samee's pin
"is wrong, not the visit": the 12 Oct visit was 498 m from the pin but 166 m from the place's photo reading.
When the owner asked to move the pin to the photo reading, the place row showed `pin_accuracy_meters` 45.9
but `photo_accuracy_meters` **2000**, and the visit's own fix was 22.5 m. A ±2 km point proves nothing about
where the clinic is, and moving the pin there would have turned the one `far` visit (line: `visit_far_meters`,
300 m) into `ok`. The owner chose **keep the pin** — nothing was changed.

**Why:** the place-move service (`src/lib/phoenix-crm/server/place-move.ts`, target `photo`) accepts any photo
reading whatever its accuracy, so the check has to be done by whoever proposes the move.

**How to apply:** compare distances only after reading both readings' accuracy. A reading whose accuracy is
wider than the distance being argued about is not evidence; say so before proposing a move.
