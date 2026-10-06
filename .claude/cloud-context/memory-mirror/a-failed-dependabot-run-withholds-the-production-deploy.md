---
name: a-failed-dependabot-run-withholds-the-production-deploy
description: a failed Dependabot updater run on a main commit withholds that commit's production deploy for good — it is routine here, it CANNOT be re-run, later green suites do not undo it, and staging shipping the same sha is the one-read proof the build was fine
metadata:
  type: project
---

Railway's "Wait for CI" waits on EVERY check suite on a `main` commit, and the commonest thing that
fails here is not our code — it is a **Dependabot updater run**. Measured 2026-10-06 over every
`main` commit since 09-28: **five shas carried a failed `dynamic` run and not one of their
production deployments ever reached `success`** (`0e3b53483`, `21f76daf3`, `1350e7536`, `1985f0216`,
`43308c587` — each exactly `in_progress → inactive`), while the neighbouring sha whose six runs were
all green (`5348e6195`) shipped in 14 minutes. So #5348 and #5353 both merged without shipping, and
their content only reached production when a later clean merge carried it.

The cause is `security_update_not_possible`, and it fails identically on every retry — the error
names a `latest-resolvable-version` BELOW the `lowest-non-vulnerable-version`. 🔴 **BUT DEPENDABOT
GIVING UP IS NOT PROOF THE BUMP IS IMPOSSIBLE, and I got this wrong once already.** Both of
2026-10-06's were resolvable BY HAND: it reported `latest-resolvable 2.0.7` for `proxy-addr` when
2.0.8 is published and `express@5.2.1` declares `^2.0.7`, which satisfies it; and `7.1.4` for
`postcss-selector-parser` against `shadcn`'s `^7.1.0`, which 7.1.6 satisfies. **Read the declared
range off the registry before believing the resolver, and edit the lockfile yourself** — that ends
the recurring failure for good. Only where no published version sits outside the advisory range
(`sprintf-js`: every version, 0.0.7 through 1.1.3) is there nothing to bump — and that is nothing
to bump TODAY, not for ever. Its chain is `mammoth -> argparse@1.0.10 -> sprintf-js`, and
`argparse@2` has no dependencies at all, so an override would remove it outright at the risk of
breaking the DOCX reader — a real option, never an impossibility.

🔴 **A Dependabot run CANNOT be re-run** — `gh run rerun` answers `This workflow run cannot be
retried` — so the documented "produce a succeeding run on that same SHA" repair does not exist for
this flavour. 🔴 **And the skip is FINAL for that commit:** on `0e3b53483` production went
`inactive` at 02:58:19Z, six seconds after the two failures, and three successful suites landed
afterwards (`ci.yml` 03:10:16Z, `Staging Branch Sync` 03:10:42Z, a dispatched smoke 03:02:32Z) with
production still `inactive` 23 minutes later. **The repair is the next clean merge, which carries
the stranded commit forward** — never a re-run, never `railway redeploy`.

🔴 **STAGING IS THE ONE-READ DIAGNOSTIC, because it has no CI gate.** It deployed the SAME commit to
`success` at 02:58:52Z, 33 seconds after production gave up. A staging `revision` equal to `main`
while production lags **proves the build is sound and isolates the fault to the gate**, before
anyone opens a build log.

Separately found the same day and now fixed: `scripts/dependabot-alerts.mjs` listed only `moderate`
in `KNOWN_SEVERITIES`, but the REST alerts endpoint answers **`medium`** — so every medium alert was
reported as `WILL FAIL CI: UNREADABLE-SEVERITY(medium)` under a headline `N open HIGH+ alert(s)`.
**A severity the message can PRINT is not one it could not READ**; that shape means a spelling is
missing, never that GitHub sent nothing.

Related: [[the-merge-guard-reads-a-concurrent-merge-as-not-green]],
[[ci-on-main-is-hosted-so-an-actions-incident-withholds-the-deploy]]
