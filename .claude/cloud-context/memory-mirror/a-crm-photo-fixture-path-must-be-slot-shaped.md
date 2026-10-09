---
name: a-crm-photo-fixture-path-must-be-slot-shaped
description: A hand-made Phoenix CRM photo shows "No photo" unless its storage path is slot-shaped — test/<seat>/<yyyy>/<mm>/place|visit/<uuid>.jpg — because the sign route authorises by path SHAPE and one bad path 403s the WHOLE batch.
metadata:
  type: project
---

`signPhotoPaths` (`src/lib/phoenix-crm/server/photos.ts`) authorises a display link from the path
alone: `photoPathTerritory` parses `[test/]<seat-segment>/<yyyy>/<mm>/place|visit/<uuid>.jpg` and
anything else returns null → `403 forbidden` for **every** path in that batch, so one invented path
blanks the whole board into "No photo" tiles with no error on screen.

Measured 2026-10-09 on the admin board walk-through: fixture photos at
`phx-crm-test/board/venue-a-signboard.jpg` rendered as "No photo"; the same images re-uploaded at
`test/SEAT-AIF-REP-D13/2026/10/place/<uuid>.jpg` rendered immediately, every
`POST /api/phoenix-crm/photos/sign` turning 200. The bucket also refuses `image/png` outright —
"mime type image/png is not supported" — so a fixture image must be a real JPEG (`sharp` is in
`node_modules`). See [[board-fixture-rows-go-on-staging-not-production]].
