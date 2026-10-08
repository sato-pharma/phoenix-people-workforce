---
name: planner-screen-retires-a-material-but-cannot-enter-a-formula-line
description: "The Production Planner screen RETIRES and restores a material since 2026-10-08 (setMaterialActive), so taking one off is a click — but it still cannot enter or change a formula line: saveMaterialAndComposition and its route are correct and UNREACHED by any control, so a composition is still a database change and a restore brings the material back with no line"
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-08T21:15:00.964Z
---

**Half of this hole is closed and half is not — do not read either half as the other.**

**Closed (2026-10-08, his instruction "let the planner screen deactivate a material").**
`setMaterialActive` in `src/lib/production-planning/service.ts`, reached by the same
`POST app/api/production-planning/materials/route.ts` split on `"active" in body`. A retire closes
every formula row in force at today, switches the `prodplan_product_materials` rows off, never
touches stock, and the Settings tab offers it with the other products that share the material named
first. The retired list is a separate unexported read, so `computePlan` can never see an inactive
material. Rules and the whole design: `.claude/rules/production-planning.md`, "Taking a material OFF
the planner". Pinned by `tests/production-planning-retire-material.test.ts`.

**Still open — and the earlier version of this note had it backwards.** It said the screen "can ADD
a material to a formula". It cannot, and never could: `saveMaterialAndComposition` can patch
`is_imported`, `lead_time_days`, `min_order_qty`, `purchase_increment`, `reorder_cover_runs` and
`notes` and can version the composition, and it is **correct, tested and unreached** — measured
2026-10-09, the Settings tab posted to `/stock`, `/fx`, `/prices`, `/runs`, `/settings` and
`/access-grants`, and to `/materials` **not at all**. The two retire/restore buttons are the first
two controls in the module that call it. It also only touches the composition when `qtyPerBasis`
parses **> 0** (`qtyMustBePositive`), so zero is refused rather than read as removal.

**Why:** entering or changing a formula line — a basis, a quantity, a supplier, an overage — is
therefore still a database change, and the restore hint says plainly that the material comes back
**with no composition** rather than promising a place to type one. A hint that said "enter it again"
would be the screen claiming something only a migration can do.

**How to apply:** a material coming off a product is now a CLICK — the Settings tab, never SQL, and
never the LEAFLET-style migration that three materials needed (the combined `LEAFLET`,
`STICKER_GUAMUSIN`, `LEAFLET_OLD`). A formula line being entered or corrected is still a migration;
say so plainly, and the obvious next piece of work is wiring the existing
`saveMaterialAndComposition` to a composition editor in that same tab. The module's 🔒 "EVERYTHING
IS EDITABLE FROM THE SCREEN AND STORED IN THE DATABASE" rule is satisfied for removal and still
unsatisfied for the formula line. See [[guamusin-spec-is-the-corrected-sheet]].
