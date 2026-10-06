---
name: a-stale-mirror-report-is-measured-in-your-own-checkout
description: "A CLOUD MIRROR IS STALE banner names files relative to the checkout it ran in, so a behind primary reports drift that origin/main or an open PR already carries — and `diff -rq` against live memory is pure CRLF noise because the mirror is LF-normalised; the only authority is running sync-cloud-context.mjs and reading what it rewrites. Separately, fold.mjs RETURNS before the sync when no note is new or gone, so mirror drift from EDITED note content never self-heals on the 3x/day cadence."
metadata:
  node_type: memory
  type: project
---

Two ways a cloud-mirror staleness reading lies, both met on 2026-10-06 in one session.

**The banner is relative to the folder it ran in.** SessionStart reported *"3 of 1168 mirrored
memory files no longer match this laptop's live memory … MEMORY.md,
hiring-post-hr-section-head-is-a-leadership-seat.md, restoring-env-cannot-undo-a-memoized-client.md"*.
The primary checkout was **33 commits behind `origin/main`**, and all three were already refreshed on
the branch of the PR then open (#5410 — its merge resolution had regenerated the mirror), so the
work it asked for was done. Against `origin/main` they genuinely differed; against the PR head all
three were byte-identical. **Resolve a staleness banner by naming the ref you are comparing to** —
`git show <ref>:.claude/cloud-context/memory-mirror/<file>` against the live note — before
refreshing anything.

**`diff -rq` between live memory and the mirror is noise.** The laptop's notes are CRLF; the mirror
is LF-normalised, so a recursive compare reports hundreds of files "differ" that are identical in
content, and `_archive-orphans-*` and `_backups` show up as "only in" by design. **The only
authority is running `node scripts/sync-cloud-context.mjs` and reading which files it rewrites** —
remembering it is *not* read-only, `--check` included, and it also runs `build.mjs`, so in a shared
checkout it dirties the tree.

**And the cadence does not cover this case.** `scripts/module-memory/fold.mjs` computes the new and
gone slugs and returns at *"nothing to file — every note on this laptop is already filed on main"*
**before** it ever reaches `sync-cloud-context.mjs`. So drift caused by an EDITED note's content —
same slug, new body — is invisible to the 09:00/15:00/21:00 fold and waits for the next genuinely
new note. A mirror-only refresh is still a hand-run job.

See [[a-documented-cadence-is-not-an-installed-job]] and
[[verify-the-emitted-artifact-never-the-source]].
