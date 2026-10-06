---
name: a-backup-keyed-by-basename-restores-the-wrong-file
description: "a break-and-restore matrix that copies its backups to `<basename>.good` silently restores the WRONG file when two paths share a basename — measured 2026-10-07, `tests/e2e/auth.setup.ts` and `tests/synthetic/helpers/auth.setup.ts` are both `auth.setup.ts`, so a restore wrote the synthetic setup's whole body into the e2e path and the test still passed; key backups by full path, and read the committed diff before pushing"
metadata:
  node_type: memory
  type: project
  originSessionId: 88f7e8d0-d89e-411a-ba16-91bea2773471
  modified: 2026-10-06T23:39:10.050Z
---

Proving a regression test fires means breaking the fix, watching the assertion, then **restoring
from a copy** — `git checkout --` would take the uncommitted fix with it. The copy is the
dangerous part.

Measured 2026-10-07 (Cairo), while pinning the login-form locators. The matrix backed four files
up with `cp "$F" "$SP/$(basename $F).good"`. Two of them are:

    tests/e2e/auth.setup.ts
    tests/synthetic/helpers/auth.setup.ts

Both have the basename `auth.setup.ts`, so the second `cp` **overwrote the first backup**, and a
later restore wrote the synthetic setup's entire body into the e2e path — `SYNTHETIC_ADMIN_HR_ID`,
`SYNTHETIC_BASE_URL` and a storage state of `tests/synthetic/.auth/admin.json`, in the file whose
job is to log in as `a-12` and write `tests/e2e/.auth/user.json`.

🔴 **Nothing complained.** The locator assertions all still passed — the locators *were* correct
in the copy that landed. Only the identity had moved. The committed diff was `19 insertions, 34
deletions` on a change that should have been `+5 −2`, which is the only thing that gave it away;
on `main` it would have failed the login smoke and withheld a production deploy exactly as #5418
did. It was caught by reading `git diff HEAD~1 HEAD` on the real file before pushing.

**Why:** a break-and-restore loop looks symmetric and is not — the break is verified by a test,
the restore is verified by nothing, so a bad restore is the one step in the procedure that cannot
announce itself. Two sibling test files sharing a conventional name (`auth.setup.ts`,
`route.ts`, `index.ts`, `service.ts`, `page.tsx`) is the normal case in this repo, not the
exception.

**How to apply:** key every backup by its **full path** (`path.replace("/", "__")`), restore each
path from its own copy, and after the matrix diff the tree against the commit you branched from —
expecting the exact line counts of your intended change, not merely "passes". `git status` is not
enough: the corrupted file was clean, staged and syntactically valid. Prefer `git stash` or a
scratch commit over hand-rolled copies where the fix is already committable.

The specific collision is now refused in the repo as well: `tests/login-form-locator-contract.test.ts`
asserts that no two login setups declare the same `AUTH_STATE_PATH` (#5424), which is the
consequence this trap produces. The trap itself is general and is not pinned anywhere.

Related: [[a-main-only-check-makes-a-prs-green-meaningless]] ·
[[verify-the-emitted-artifact-never-the-source]]
