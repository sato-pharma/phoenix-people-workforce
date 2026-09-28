---
name: the-integrity-board-keeps-the-name-location-integrity
description: "The Phoenix CRM integrity board KEEPS the name \"Location integrity\" - owner decision 2026-09-27, taken after it grew to carry photo and behaviour cases as well as position; never re-propose a rename"
metadata:
  node_type: memory
  type: project
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-09-27T17:25:25.161Z
---

🔒 **The board at `/admin/phoenix-crm/integrity` keeps the name "Location integrity", in the
sidebar and on the page.** Owner decision, 2026-09-27, asked directly and answered in three words:
"keep the name Location integrity".

He was asked because the name had stopped describing the board. It began as GPS evidence only, and
that day it gained two more detectors: the nightly photo sweep (D5, `source = 'photo'`) and the
per-rep-per-month behaviour pass (D4, its own table `phoenix_crm_behaviour_integrity`). Three kinds
of case now sit under a name that says one.

**Why:** it is HIS wording and it is a screen he opens; a rename is a cosmetic change nobody asked
for, and the sidebar label is pinned in `tests/fixtures/sidebar-label-widths.json`
("Location Integrity": 103), so changing it drags a fixture regeneration and a width check behind it.
He looked at the trade and chose the name. That is settled, not deferred.

**How to apply:**
- Never re-propose renaming it - not when a fourth detector lands, not as tidying, not as part of
  "aligning the module". Widen the DESCRIPTION instead; the page and the nav card both carry one.
- The cases themselves stay distinguishable by their `source` chip ("position" / "photo") and by the
  behaviour board's own section, so the name costs the reader nothing.
- Audience is unchanged and is the narrow point of the whole thing: Super Admin and SFE Manager only,
  via `canReadIntegrityBoard`, refusing with `notFoundError` because a 403 naming the board is itself
  the disclosure. See [[a-pharmacy-is-not-a-contact]] for the other standing naming rule he has
  ruled on directly.
