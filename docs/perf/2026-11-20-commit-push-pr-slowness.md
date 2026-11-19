# Why commit, push and opening a PR were slow — 20 Nov 2026

The owner, 20 Nov 2026 ~00:15 Cairo: *"deeep audit claude code desktop performance commit push prs
are very slow"*. This is what was measured, what changed, and what is left.

## Where the time went

| Step | Before | After | What changed |
| --- | --- | --- | --- |
| `node scripts/check-contracts.mjs`, the pre-push read every push points at | ~19 s typical, 25.6 s under load | 12.2–14.4 s | the loader flag, and a regex cache (below) |
| the `neutral-wording` gate | 9.4 s | 1.8 s | the loader flag |
| the `heredoc-backslash-damage` gate | 3.2 s | 1.3–1.9 s | the loader flag |
| the `access-registry-coverage` gate | 4.3–5.2 s | 0.6 s | each pattern's regex compiled once |
| `push-typecheck-guard.mjs`, on every push | 630–900 ms | ~355 ms | four git launches became one `rev-parse` plus one `for-each-ref` |
| a commit and a push in one command | refused, then sent again as two (218 refusals in a week) | one command, scanned inside it | bash-guard C12, `docs/hook-dispatcher.md` |

The rest of `check-contracts` is ESLint on the changed files (~5.5 s for 8 files, which grows with
the change) and three gates that are slow in their own right: `react-418` (~4.2 s, spread across
comment stripping, reads and lexing), `hr-id-storage-casing` (~3.5 s) and `migration-check` (~2.2 s).

## The main cause: `--experimental-loader` slows every regex

On Node 24.15.0, starting Node with `--experimental-loader`, even with an EMPTY hooks file, makes
every allocating regular-expression call on the main thread many times slower. Same input, same
machine:

| How the alias loader was attached | `split(/\r?\n/)` on 41 MB |
| --- | --- |
| `--experimental-loader ./tests/alias-loader.mjs` | 9.5–11.6 s |
| `--experimental-loader` an empty file | 9.5 s |
| no loader | 98–127 ms |
| `--import ./tests/register-alias-loader.mjs` (`module.register`) | ~100 ms |
| `module.registerHooks` | ~100 ms |

A `/g` replace was about 6× slower too. `neutral-wording` spent 5.7 of its 7.2 s in that one split.
The hooks are the same either way. Only the flag differs, and Node's own warning for that flag
recommends `register()`.

`scripts/check-contracts-gates.mjs` now attaches the loader with
`--import ./tests/register-alias-loader.mjs`, and `tests/check-contracts.test.ts` refuses
`--experimental-loader` or `--loader` coming back.

## Not changed here

- **The test suite and about 80 `package.json` scripts still pass `--experimental-loader`.** That
  includes `test`, which CI's `unit` jobs run, so CI probably has the same slowdown on every
  regex-heavy test. Switching them is its own change, measured on CI, not this one.
- **The "~8s" in CLAUDE.md** is left alone; a run is now 12–14 s, most of it ESLint on the changed files.
