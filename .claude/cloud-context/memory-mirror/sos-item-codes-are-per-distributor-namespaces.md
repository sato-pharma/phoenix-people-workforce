---
name: sos-item-codes-are-per-distributor-namespaces
description: "An SoS item code only means something inside the issuing distributor's numbering — aggregate exports reuse the same digits, and the column header is the reliable namespace test"
metadata: 
  node_type: memory
  type: project
  originSessionId: f3deb2a3-78c9-4188-9750-0ce65dec6904
  modified: 2026-08-09T20:26:16.331Z
---

A SoS item code is meaningful **only inside the numbering of the distributor that issued it**. Item
`5976` in a Pharma Overseas file and `5976` in a weekly backup export are different objects that
happen to share a digit string.

**Why:** on 2026-08-09, hunting 85 unverified codes across the drives produced 24 confident-looking
"Phoenix deletes real sales" conflicts. Every one was sourced from an *aggregate* workbook —
`phoenix-data-backup-weekly-*.xlsx`, `Total IMS_*.xlsx`, `Egypt_Combined_*`, `sato egy 18-1.xlsx` —
which carry their own numbering. Restricting evidence to files the issuing distributor actually sent
collapsed 24 conflicts to 3, and all 3 were real.

**How to apply:** when identifying a code from a spreadsheet, accept the evidence only if the file
came from that distributor, or the matched column carries that distributor's own header vocabulary.
Filenames are a weak proxy (Ibn Sina's export is `Weekly_Sales_and_Stock_For_SATO_PHARMA_(PAS)…`,
EPDA's is `ساتو صيدليات.xlsx`), so prefer the header:

| Header | Distributor |
| --- | --- |
| `Mat. Code` | PS · `Material` → PS-T |
| `Item Code` | IS / IS-S / IS-T |
| `ITEM_CODE` | EG / EG-BR / EG-HOS |
| `ك.صنف` | RM / RM-T |
| `ITEMIDE`, `OLDITEM` | SF / SF-T |
| `class_code` | EP-PHS / EP-BK · `ProductSerial` → EP |
| `دالصنف` | MC |

Tooling: `scratchpad/hunt_codes2.py` (broad drive scan) and `hunt_targeted.py` (distributor files
only) record which column matched; `build_rulings.py` holds the ownership test. Related:
[[closing-uses-total-qty-not-effective-units]], [[sos-distributor-folder-labels-are-unreliable]].
