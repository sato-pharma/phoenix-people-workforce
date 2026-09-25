---
name: migration-timestamp-collides-across-parallel-branches
description: "Two sessions authored 20260805210000 on different branches — check every ref for the timestamp before naming a migration, not just main"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbfccdf5-5bbf-4ee5-94df-254a1b202152
  modified: 2026-08-09T21:56:05.898Z
---

**Round-numbered migration timestamps collide across parallel sessions.** On
2026-08-05 two branches independently authored `20260805210000`:

- `codex/sales-channels-by-rep` → `20260805210000_sales_channels_by_rep.sql`
- `codex/phx-customer-directory-address-fallback` → `20260805210000_phx_customer_directory_address_fallback.sql`

`scripts/check-migrations.mjs` fails a duplicate timestamp prefix outright
("use a unique timestamp"), so whichever merged second would have turned the
required `validate` job red **for everyone**, not just its own PR. Neither branch
could see the problem: each was cut from `origin/main`, and the other file was
only ever on a sibling remote branch.

**Why it happens here:** this repo names migrations by hand at round times
(`...210000`, `...120000`, `...090000`), 4-6 sessions run at once, and a session
that branched from `main` never looks at other branches.

**How to apply:** before naming a new migration, scan **all refs**, not `main`:

```bash
git fetch origin --quiet
git log --all --pretty=format: --name-only -- supabase/migrations/ \
  | grep -oE '[0-9]{14}' | sort -u | tail -20
```

Pick a timestamp not in that list. If the collision is only found after pushing,
`git mv` to a free timestamp and commit the rename — content is unchanged, and
because the production ledger records its own apply version (not the filename),
renaming the file does not affect what is already live. Do NOT force-push to fix
it.

**RESOLVED 2026-08-05: `codex/phx-customer-directory-address-fallback` moved to
`20260805220000`, so `20260805210000` is now held only by
`codex/sales-channels-by-rep`.**

**That `git log --all` scan is right for PICKING a name and WRONG for asking
"is there still a collision".** It reads history, so it keeps reporting a
timestamp that a rename already vacated — a later session re-read this note, ran
it, and told the owner #1815 would redden `validate` when the other branch had
already moved. To test whether a collision is *live*, read the current trees, not
the log:

```bash
git for-each-ref --format='%(refname)' refs/remotes/origin/ | while read ref; do
  git ls-tree -r --name-only "$ref" -- supabase/migrations/ 2>/dev/null
done | sed 's|.*/||' | grep -oE '^[0-9]{14}' | sort | uniq -d
```

Empty output means no live duplicate. Use `git log --all` to choose a *fresh*
timestamp (it conservatively avoids ever-used ones); use the tree scan to decide
whether anything actually needs renaming.

Related: [[two-sessions-fixed-one-bug-main-was-never-ci-validated]],
[[list-migrations-reports-ledger-not-reality]],
[[check-constraint-drop-recreate-collides-across-branches]] (same root cause — parallel branches
blind to each other — but colliding on constraint CONTENT rather than filename).
