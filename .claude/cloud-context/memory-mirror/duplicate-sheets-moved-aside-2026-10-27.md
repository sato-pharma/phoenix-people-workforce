---
name: duplicate-sheets-moved-aside-2026-10-27
description: "2,920 byte-identical spreadsheet copies on C, D, E and F were moved into \"Duplicate Sheets\" folders on 2026-10-27; where they went and how to put them back"
metadata:
  node_type: memory
  type: project
  originSessionId: 67f15b49-6120-498b-a4bb-a6cae3f7ce6d
  modified: 2026-10-27T18:18:39.765Z
---

On 2026-10-27, about 21:15 Cairo, the owner said "IF U FIND A DUPLICATED SHEET MOVE IN NA SEPARATE FOLDER". 2,920 extra copies (1.9 GB, same md5 as a kept copy) were moved, not deleted, each on its own drive, keeping its folder path:
`D:\Duplicate Sheets\` 1,198 · `E:\Duplicate Sheets\` 1,014 · `C:\Users\satoh\OneDrive\Duplicate Sheets\` 500 (mostly OneDrive Desktop) · `C:\Users\satoh\Duplicate Sheets\` 171 · `F:\Duplicate Sheets\` 37.

- Kept copy order: Sato Historical Sales and Sales per Disrb, then the email-attachment folders, then Documents, then Desktop and D:\EXCEL, then Downloads last.
- Never moved: backups, archives, Claude Scratchpad Archive, Hiring Posts, the repo, AppData, Documents\Codex, and Excel `~$` lock files.
- The moved-files list (moved from, moved to, kept copy, md5) is `F:\Duplicate Sheets\moved-list-2026-10-27.csv`. The script is beside it as `dedupe-2026-10-27.py`, and its `undo` mode moves every file back.

**Why:** if he asks where a file went, it is in that drive's Duplicate Sheets folder, and a copy with the same content is still in its original place.
**How to apply:** look a file up in the list before saying it is missing. Never delete anything in these folders. Related: [[pharmacy-database-sync-runs-only-by-hand]].
