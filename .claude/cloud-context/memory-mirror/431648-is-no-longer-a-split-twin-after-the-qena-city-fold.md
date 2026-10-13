---
name: 431648-is-no-longer-a-split-twin-after-the-qena-city-fold
description: The sales-imports rule line saying customer code 431648 must STAY split across B209-1/UE7 (IS) and B209B-1/UE8 (IS-S) is STALE — the Qena city fold of 13 Oct 2026 put both copies on B209B-4/UE8; never re-split it to satisfy that line
metadata:
  node_type: memory
  type: project
  originSessionId: 0be92338-9743-4b23-ba29-cd28bd8597f5
  modified: 2026-10-13T01:00:12.554Z
---

🔴 **`.claude/rules/sales-imports.md` CARRIES A LINE THAT IS NOW WRONG, AND OBEYING IT WOULD UNDO THE
OWNER'S RULING.** It says customer code **431648** is the worked example of a legitimate IS / IS-S
twin split and "must STAY split — `B209-1 / UE7` as IS, `B209B-1 / UE8` as IS-S".

That was true only while **Qena city existed as two bricks**. The fold of 13 Oct 2026 retired both
(`B209-1` and `B209B-1`, `effective_to = 2026-10-12`, 0 mapped shops, superseding into `B209B-4`),
so the split it describes cannot exist any more. Measured live on production:

| Distributor | Brick | Area | Updated (Cairo) |
| --- | --- | --- | --- |
| IS | `B209B-4` | UE8 | 13 Oct 01:45 |
| IS-S | `B209B-4` | UE8 | 13 Oct 02:03 |

**How to apply:** both copies agree, which is the twin rule's healthy state — leave them. Do **not**
re-split 431648, and do not treat the two copies agreeing as a defect to "restore".

**The rule line itself is already corrected** on branch `codex/address-first-importer` (the
address-first importer's own PR, 13 Oct 2026) — read there as "both copies correctly sit on
`B209B-4` — never re-split it, and never revive `B209-1` or `B209B-1` (dated history)", with the
`must STAY split` wording gone. So no separate edit is owed; if this note and `sales-imports.md` ever
disagree, the repo file is the live rule. That importer also skips every brick carrying
`superseded_by_brick_id`, so it cannot place a pharmacy back on either retired Qena city brick.

The surviving half of that rule is still true and must not be deleted with the stale half: **CA5,
GZ3, GZ6, GZ7, OT2, OT9, UE8 and UE9 are a real staffed area for one line and an `other_*` bucket
for another**, so IS and IS-S may legitimately differ there — just not on this code any more.

See [[qena-city-is-qena-2-on-every-line]].
