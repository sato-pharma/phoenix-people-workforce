---
name: two-break-suites-in-one-folder-contaminate-each-other
description: Two break suites run at once in the same folder write the SAME break-builder and the SAME broken workbook, so one suite's MISSes are the other suite's edits — never run them concurrently, and treat an overlapped log as void.
metadata:
  type: project
---

The ranking workbook's break suites (`break-full.sh`, `break-identity.sh`, `break-two.sh` in the
session scratchpad's `closing-sheet/`) each patch a COPY of the builder to the one shared filename
`closing-sheet/build-ranking-ai-break.mjs` and emit the one shared `-identity-v6-break` workbook.
Run two at once and each break verifies whatever the other suite happened to have on disk at that
instant.

**Why:** on 2026-10-13 `break-identity.sh` and `break-two.sh` overlapped. The identity log reported
17 fired / 2 MISSed — and each MISS carried FAIL lines that belonged to the *other* suite's
workbook (an Area × Product order of `Menoufia 1, Dakahlia 1, …`, i.e. the pre-team arrangement, and
`{"sheet":819,"published":91}`). Both MISSes were fictional; a clean re-run fired them. A suite that
reports a MISS with foreign FAIL lines under it is the tell.

**How to apply:** one suite at a time, sequentially in one background shell
(`bash break-identity.sh > a.log; bash break-banners.sh > b.log`), and never start a second while
one is live. A log written while another suite was running is VOID — re-run it, do not reason about
its MISSes. `break-banners.sh` is the exception that still needs care for a different reason: it
works in `ai-identity/`, swapping `banner-facts.json` and regenerating the strip PNGs the workbook
embeds, so it must not overlap a workbook build either. See [[verify-the-emitted-artifact-never-the-source]].
