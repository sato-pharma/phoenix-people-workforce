---
name: old-crm-two-row-chain-visits-stay-as-history
description: "The vendor (old) CRM saved a chain visit as TWO rows, so it still counts 2 received for the rep on the Double Visit Analytics rep score — LEAVE IT; only Phoenix CRM chains count once (owner ruling 2026-10-08)."
metadata:
  node_type: memory
  type: project
  originSessionId: bb052740-fd7a-4cf0-aedb-63bfdcc19980
  modified: 2026-10-08T11:58:33.771Z
---

Phoenix CRM saves a chain visit (one rep, two managers) as one row, counted once for the rep and credited to both managers (PR #5499). The old vendor CRM split the same thing into two rows, so its history still reads as 2 double visits received.

Owner ruling 2026-10-08, asked directly: **leave the old history as it is** — do not re-count old-CRM two-row chains as one.

**Why:** the switchover rule is that a started team's vendor history stays exactly as it was; only new Phoenix visits follow the new rule.

**How to apply:** never dedupe or merge the vendor CRM's chain rows in any report or backfill. Related: [[outstation-evidence-credits-only-the-first-manager-on-a-chain-visit]].
