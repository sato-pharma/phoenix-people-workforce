---
name: validation-photos-folder-is-never-deleted-from
description: "F:\\Phoenix Workforce\\Validation Photos holds reps' validation photos by Line\\Region\\Area\\Rep; nothing in it is ever deleted, moved or overwritten."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e1992cbc-abf6-43e3-8ca0-e292d73dc7fb
  modified: 2026-11-23T20:49:26.938Z
---

`F:\Phoenix Workforce\Validation Photos` holds every validation photo downloaded from production. It is laid out as `<Line>\<Region>\<Area>\<Rep name>\`, and each file is named `<YYYY-MM-DD HH-mm Cairo> - <place> - <timetable|place|building> - <status>[ - AI-MADE].jpg`. The first build, on 23 Nov 2026, copied 1,988 photos. The six AI-made timetables carry `AI-MADE` in their file names. `build-folder.mjs` sits in the folder: it copies with COPYFILE_EXCL and skips files that already exist.

**Why:** the owner said on 23 Nov 2026: "never delete anything from this folder". It is his evidence of reps' AI-made and typed timetables.

**How to apply:** only add to this folder, copying with no overwrite. Never delete, move, rename or clean up anything in it, and there is no stand-down marker. Also recorded in the global CLAUDE.md under "Never delete documents". Related: [[the-delete-guard-now-has-a-named-file-stand-down]]
