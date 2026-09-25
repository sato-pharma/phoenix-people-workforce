---
name: regen-readslivedata-flag-matches-a-comment-not-a-call
description: "The scratchpad regen plan's readsLiveData flag, and any keyword scan like it, matches the word Supabase wherever it appears - including in a comment - and also flags ANY .jpg filename, because the regex alternative pg-at-a-word-boundary matches the tail of jpg. It flagged video_uploads_2026-09-15.xlsx as rebuilt from live data when its generator imports only openpyxl and carries every number as a literal. Read the imports and the call sites before warning the owner that a rebuilt file holds today's numbers."
metadata:
  node_type: memory
  type: project
  originSessionId: a15b5e6b-24b6-4909-80db-3f15af239e86
  modified: 2026-09-21T02:55:00.000Z
---

Measured 2026-09-21. `scratchpad-regen-run.mjs --run` rebuilt 9 lost scratchpad
documents and wrote `_regen-results.json`. One row carried `readsLiveData: true`, and on
the strength of that flag alone the owner was told that
`video_uploads_2026-09-15.xlsx` had been rebuilt from **today's** figures under a
15 September name, and was asked to decide whether to keep it. **That warning was
wrong.**

`build_video_report.py` imports `openpyxl` and nothing else. It contains no
`create_client`, no `requests`, no `urllib`, no `httpx`, no `psycopg`, no `os.environ`,
no `getenv` and no URL. Every figure is a literal in a `rows = [` list at line 11. The
only occurrence of "Supabase" in the whole file is a comment on line 5 recording where
the numbers were read from on 2026-09-15 - and the workbook prints that same provenance
into cell A2.

**How to apply:** a regex flag over source text is a *hint*, never the finding. Before
telling him a rebuilt or regenerated artifact carries different data from the original,
open the generator, read its imports, and find the actual call. It takes one grep. The
eight other rebuilds that session were all literal-data scripts too, so **all nine were
faithful** - the correct headline, and the opposite of what the flag implied.

**A second false-positive path, measured the same day:** the flag is one case-insensitive regex
(`scratchpad-regen-plan.mjs` line 141, `/supabase|SUPABASE_|postgres|psycopg|pg\b|createClient/i`),
and its `pg\b` matches the tail of `jpg` - so `logo = "sato-pharma-logo.jpg"` flags a script as a
database client, while `mark.png` does not.

The same shape bites anywhere a scan decides a fact: a word in a comment, a string in a
docstring and a disabled line all match. Provenance for the rebuilt set now sits in
`F:\Claude Scratchpad Archive\_regenerated-README.txt`.

Related: [[verify-the-emitted-artifact-never-the-source]] and
[[looking-at-a-generated-workbook-two-ways-that-lie]].
