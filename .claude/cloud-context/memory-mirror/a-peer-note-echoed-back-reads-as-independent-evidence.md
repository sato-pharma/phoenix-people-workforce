---
name: a-peer-note-echoed-back-reads-as-independent-evidence
description: "A sentence that arrives in a cross-session message, is carried into a compaction summary and then quoted back in a reply, returns to its author looking like a second session's corroboration — on 2026-10-09 the 'three Sohag brick moves' travelled that circle and came within one click of relocating a brick carrying 1,582 customer mappings and 770,201.63 EGP; trace a carried claim to a USER message before repeating it, and `grep` the transcript rather than answering from memory."
metadata:
  node_type: memory
  type: project
  originSessionId: 7d87f9ce-e2e0-4338-ba57-8b380f850d09
---

2026-10-09. A peer session's status message ended *"The three Sohag BRICK moves (Sohag City B213-1
and Balasfora B213-3 out of Sohag 1, El Osairat B214-2 in) are still unapplied and still his click on
/sales/database-mapping."* I carried that sentence into my compaction summary as an open item, and
from there into a reply to him as *"Still yours, on the screen"*. The peer then read my reply, saw the
same three moves asserted by a second session, and asked me to cite them before it would write them.

**Why it is dangerous rather than merely circular:** nothing in the loop is a lie, and every hop is
the correct behaviour in isolation — a peer shares state, a summary preserves open items, a reply
surfaces what needs the owner. The claim simply loses its provenance at the first hop and gains
apparent independence at the third. Neither session had a source, and both believed the other did.

**How it was broken, and the test to use:** `grep` the session transcript for the claim and look at
the **role** of the earliest hit.

* All 15 mentions of `B213-1` in my transcript were my own SQL output — counts, never a ruling.
* **Zero `type:"user"` messages mentioned a brick, B213, B214, العسيرات or بلصفورة.** That is the
  decisive test: a claim with no user message behind it is nobody's decision.
* Three independent absences agreed: `source_area_code` NULL on every Sohag brick, no
  `sos_map_change_holds` brick row, and the candidates workbook silent on bricks.

**His ruling, relayed through the peer the same evening: *"leave all three bricks where they are."***
Closed, not deferred — do not re-raise it, and do not carry the sentence forward again.

**How to apply:** before repeating a carried claim — in a reply, a `Next step:` line, a summary or a
brief to another session — trace it to a user message. Write the observation and leave the diagnosis
open when briefing a peer, and when a peer asks you to cite something, audit the transcript rather
than answering from memory; answering from memory here would have authorised the write. Related:
[[the-two-sales-rollups-store-units-only-never-value]],
[[there-is-no-cns-brick-structure-sheet-only-a-pedia-one]].
