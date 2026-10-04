---
name: a-branch-behind-main-reads-as-unshipped-under-a-byte-test
description: Whole-file byte-identity only proves a branch is carried when it is AHEAD of main; a branch that is BEHIND reads as holding unshipped work, because main's file is bigger and different. Test its own ADDED lines instead — and grep -Fq "$L" errors on a line starting with `-`, printing MISSING for a line that is there.
metadata:
  type: feedback
---

**Retiring a branch asks one question: does it hold anything `main` does not?** The test that
answers it is the branch's **own delta** — every added line from `merge-base..tip` present on
`origin/main`, and every deleted line absent from it. Comparing whole files by blob hash answers a
*different* question, and only coincides when the branch is strictly ahead.

Measured 2026-10-04 on `codex/selector-capture`: 11 commits **behind** `origin/main`, 1 ahead. Its
`.claude/rules/turbify.md` was 25,029 bytes against main's 25,981, and
`docs/mailbox-robot-calibration.md` 84,739 against 90,819 — because later PRs had added more on top
of the branch's own lines. The blob test called both files "NOT ON MAIN" and I reported two files of
unshipped work existing on one disk. The delta test said **320 of 320 added lines present, 5 of 5
deletions honoured**: the commit had merged hours earlier as #5307. Bigger-and-different read as
missing when it meant superseded.

🔴 **And the check that disproves it can itself fail open.** `grep -Fq "$L"` with a line beginning
`-` — every markdown bullet — exits with `grep: unknown option`, and a loop that treats non-zero as
"not found" prints `MISSING` for a line sitting on `main` at a known line number. Use
`grep -Fq -e "$L"`. Same shape as a `git diff` that errors and leaves a counter at 0: a command that
*failed* is not a command that found nothing, and in a retirement gate that difference is a branch
deleted on a check which never ran.

**So a retirement gate fails closed on all of it:** a failed `fetch`, a branch that does not resolve,
an empty merge-base, a non-zero `git diff`, an unreadable open-PR count, a file unreadable on both
sides. Push the tip to `refs/backups/<branch>-<date>` and read it back by SHA before deleting —
[[there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure]] is why origin is the only copy
that survives the drive. Related: [[a-closed-pr-still-takes-a-push-and-reports-a-stale-head]],
[[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]].
