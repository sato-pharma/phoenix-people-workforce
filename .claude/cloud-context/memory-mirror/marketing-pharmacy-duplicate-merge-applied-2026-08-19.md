---
name: marketing-pharmacy-duplicate-merge-applied-2026-08-19
description: "Four duplicate marketing pharmacies merged on PROD 2026-08-19 — do not undo; backup is in the marketing_rollback schema."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-19T16:11:47.310Z
---

Applied to **production** on 2026-08-19 alongside the "my pharmacies" reuse feature (#2212).
Four duplicate `marketing_pharmacies` records were merged into their survivors and deleted:

| Survivor kept | Deleted | Shop |
| --- | --- | --- |
| `82f78296` | `41e1ac8c` | مستشفى فيكتوريا (A-10, El Raml 2) |
| `a54d709c` | `b26c8bd2` | المصريه الجديده (B-116, Heliopolis) |
| `e20d4578` | `6b2979f4` | سامي (B-116, Heliopolis) |
| `ea4730ac` | `063fea67` | Tabarak hospital (B-94, El Talbia) |

6 customer links, 4 `marketing_request_pharmacies` rows (all on the **rejected** request
`MKT-REQ-20260817-A60E46B0`) and 1 evidence photo were **re-pointed, not deleted** — the photo moved
to `ea4730ac`, which now holds two.

**Full row-level backup: `marketing_rollback.pharmacy_merge_20260819`** (jsonb payloads, 21 rows).
That schema and table have `anon`/`authenticated`/`public` grants revoked deliberately — a
`zz_backup_*` table in `public` would be anon-readable, see [[ad-hoc-backup-tables-are-anon-readable]].
Do not move it into `public`.

Two customers are both named **وليد كمال** (`a1fa68f4`, `faaa64e4`) — genuinely two records, each
correctly linked after the merge. Not a bug to "fix" without asking.

Related: [[duplicate-pharmacy-test-is-name-and-gps-not-brick]] · [[pos-pharmacy-codes-are-zero-padded]]
