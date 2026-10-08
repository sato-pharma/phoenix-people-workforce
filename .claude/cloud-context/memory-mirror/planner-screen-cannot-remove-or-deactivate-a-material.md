---
name: planner-screen-cannot-remove-or-deactivate-a-material
description: "The Production Planner screen can ADD a material to a formula but never remove one or deactivate it — saveMaterialAndComposition has no is_active and refuses qtyPerBasis <= 0 — so \"everything is editable from the screen\" has a hole and a removal is a database change, never a click"
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-08T18:20:47.977Z
---

`saveMaterialAndComposition` in `src/lib/production-planning/service.ts` is the module's only write
path for a material and its formula line (one `POST` at
`app/api/production-planning/materials/route.ts`). It can patch `is_imported`, `lead_time_days`,
`min_order_qty`, `purchase_increment`, `reorder_cover_runs` and `notes`, and it can version the
composition — but:

- it never writes `is_active`, so **no screen can deactivate a material**, and
- it only touches the composition when `qtyPerBasis` parses **> 0** (`qtyMustBePositive`), so
  **no screen can remove a formula line**; writing 0 is refused rather than treated as removal.

**Why:** so taking a material off a product — Guamusin's sticker, 2026-10-08 — is a database change
and cannot be handed to him as a click. Measured while trying to find him a screen route after the
Supabase production write was declined four times; there is none, and sending him to
`/admin/production-planning` for it would be wrong.

**How to apply:** when a material has to come off a product, say plainly that it is a database
change and do not offer the screen. The shape to use is the LEAFLET precedent — delete the
composition row and the product join, **deactivate** the material rather than deleting it. Check
`prodplan_plans` first: with no committed plan under that formula a delete loses no history, which
is what made the delete correct for the sticker rather than the usual `effective_to` close
(see [[guamusin-spec-is-the-corrected-sheet]]).

This is also the one real gap in the module's own 🔒 "EVERYTHING IS EDITABLE FROM THE SCREEN AND
STORED IN THE DATABASE" rule in `.claude/rules/production-planning.md` — the rule is about not
hard-coding values, and it holds for every value; what has no UI is *removal*.
