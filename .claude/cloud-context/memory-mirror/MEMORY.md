# Memory Index

**Module memory holds everything module-specific** — `.claude/rules/<module>.md` in the repo, loaded when a session works in that module (AGENTS.md §2.2, docs/module-memory.md). This index holds what is true everywhere, plus the inbox. Nothing is trimmed from it any more.

**Hooks only - the FILE is the fact. Rules: `AGENTS.md` §2.2.**
- [ARCHIVE](MEMORY-ARCHIVE.md) - the pre-2026-10-02 archive; every note in it is now filed in a module.

## 🥇 RULE #1 - never trim, never forget
- 🔴 [**`B-10` is the OWNER himself**](b-10-is-the-owner-himself.md) - sole Super Admin, so EVERY `decided_by` is his. Never advise him to "tell B-10" or notify him of his own decisions.
- 🔴 [**Monthly Closing** = the ONLY sales+target truth](sos-monthly-closing-is-the-only-sales-truth.md) - every surface reads ITS sales AND target (targets confirmed 2026-09-27); Weekly excluded; Marketing ROI the ONE exception.
- 🔒 [Head Office is in NEITHER weekly NOR monthly - unmapped is CORRECT](head-office-products-are-not-tracked-weekly-golden-rule.md) - tracked = **CNS · Anti Infective · Pedia** ONLY; HO is **90% of weekly VALUE**. NEVER flag or map it; ALWAYS filter before quoting a number.
- 🔒 [Lacto: family NAMES split; family_code still shared](lacto-advanced-and-basic-share-family-and-family-code.md) - `Lacto Advanced` (Pedia) + `Lacto Basic` (HO); no bare `Lacto`. **Both keep family_code=`LA` DELIBERATELY** - the direct-order basket allow-list; tidying it un-combines the order.
- 🔴 [NEVER add units of different products/concentrations](units-of-different-products-are-never-added.md) - a unit total is valid for ONE product_code only; above that aggregate by **VALUE**. Same for TARGET units.
- 🔴 [Head Office is ABSENT from `phx_monthly_achievement`](head-office-sales-are-absent-from-phx-monthly-achievement.md) - no rows ≠ zero: it rendered real July units as 0. Royanoxicam DOES return (line NULL), Lacto Basic and Satoslim do not. `direct_value` is NOT the sales value; HO has NO price, units only.
- 🔴 Pre-July: [reconcile per customer×product](closing-reconcile-per-customer-product-not-area-pre-july.md)·[CURRENT price + backfill targets](closing-pre-july-revalue-and-backfill-targets-at-phoenix-price.md)
- 🔴 [a price fix RESTATES every published month](a-price-fix-silently-restates-every-published-closing.md) - INTENDED; drift sees VALUE now, price outside the lock. **July AI stays as published (owner).**·🔒 [the matrix can NEVER fit; summary ships BESIDE it](monthly-closing-matrix-cannot-fit.md) - leave the scroll.

## In flight
- 🔴 Email: [NEVER bulk/test sends](never-fire-bulk-emails-ever.md)·[both cuts LIVE](email-inventory-audit-2026-08-13.md) - probation email OFF **except Day 30/60/75 → Yasmeena, cc B-10**·[every automated email ALSO pings his Telegram](every-automated-email-also-mirrors-to-the-admin-telegram.md) - a test send reaches him.

## Owner's rules (don't "fix" back)
- 🔴 [the Next step box is NOT a notepad](the-next-step-box-must-not-manufacture-the-next-task.md) - he SENDS what is in it. Never a task Claude invented; a shipped feature is DONE.
- 🔴 [hand HIM PowerShell, never bash](commands-handed-to-the-owner-must-be-powershell.md) - his Terminal rejects `&&` before anything runs.
- 🔴 [fix means fix - no unrequested work](fix-means-fix-no-unrequested-work.md)
- 🔴 [NEVER approve for the CEO](never-approve-for-the-ceo.md) - he INTERRUPTED his own "approve them both". The work up to the decision is mine; the decision is his.

## Traps that bite any session
- 🔴 **Never re-add a module fact here or to `AGENTS.md`** - it goes in that module's `.claude/rules/<module>.md`; session traps live in §2.1's clusters.


## Inbox — new notes land here
- [a mirror refresh must carry `assignments.json`](a-mirror-refresh-must-carry-assignments-json-or-main-goes-red.md) - staging only `.claude/cloud-context` orphans the new notes, reds main and WITHHOLDS the deploys.
Put each new memory note's pointer here, one line. The weekly fold (`node scripts/module-memory/fold.mjs --apply`) files it under its module in ONE PR; once that merges, the next fold removes the line.
- [port 3000/3001 may be the PREVIEW TUNNEL, not a dev server](a-listener-on-port-3000-may-be-the-preview-tunnel.md) - read the listener's command line before recommending a stop.
- ["suggestions not appearing" has FIVE layers](prompt-suggestions-have-five-layers-and-four-are-not-it.md) - the four you reach first are usually already correct; the APP's own `prompt_suggestions` applies only from a session's next start, and the status bar is a different feature.
- [no suggestion after a RESUME = the session was unloaded](a-missing-suggestion-after-a-resume-is-the-session-being-unloaded.md) - check for `SessionStart:resume` before blaming the 10k size gate.
- [a local test subset chosen by grepping your symbols misses the SOURCE-PINNING tests](choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones.md) - 21 green suites, and the full off-laptop run failed twice on tests that name no symbol from the diff; the notification's exit code is not the verdict either.
- [a background poller DIES with the worktree it runs in](a-background-poller-dies-with-the-worktree-it-runs-in.md) - and a loop settling on "exit code is not the waiting code" reads the crash as a settled answer; grep for the real verdict line instead.
- [a backgrounded remote-check's notification exit code is NOT the verdict](remote-check-background-exit-code-is-not-the-check-verdict.md) - a peer saw "exit code 0" while the file read `FAIL`; read the output file's final `remote-check: PASS/FAIL` line, never the task-notification exit code.
- [Phoenix CRM email has NEVER sent in production](phoenix-crm-email-has-never-sent-in-production.md) - its only `plan_edit` delivery row is a TEST-world in-app copy, so that absence is not a defect; prove the pipeline from another module, and check `event_key` for `:test:` first.
- [a merge approval naming only a NUMBER reaches every session](a-merge-approval-naming-only-a-number-reaches-every-session.md) - owner rule 2026-10-02 "send merge approvals to this session only"; two sessions acted on one `merge 5174` ten seconds apart and shipped an empty squash. ASK by naming the session, and never quote a PR number before the PR exists.
- [a roll-up ships a member's STALE head, not its latest](a-rollup-ships-a-members-stale-head-not-its-latest.md) - `--apply` snapshots each head at BUILD time; #5188 pushed 4 min later and #5191 shipped its superseded commit 1 and left it DIRTY. The tell is `--settle` declining to call a listed member `CARRIED`.
- [`railway deployment list` can omit the deployment that is SERVING](railway-deployment-list-omits-the-active-deployment.md) - phoenix-headwind showed 100 SKIPPED rows and none of them live, so a sweep read 0 lines for a service holding 791 error lines; take the active id from `railway status` (which needs `-e` as well as `-p`).
- [`canonicalPersonHrId` is NOT a validity test](canonical-person-hr-id-is-not-a-validity-test.md) - it hands an unrecognised id straight back UPPER-cased, so resolving a login through it would have written `OPS-CONSOLE` into an employees(hr_id) FK; only a DECLARED alias may stand in for a missing hr_id.
- [ORPHAN module-memory notes you never wrote = your branch predates a fold](orphan-module-memory-notes-mean-your-branch-is-behind-the-fold.md) - `git merge origin/main` fixes it; filing them by hand collides with the assignments main already has. Two sessions hit it inside an hour.
- [a DEREGISTERED worktree folder answers git from the PRIMARY, on main](a-deregistered-worktree-folder-answers-git-from-the-primary.md) - so the branch-deletion gate "byte-identical on origin/main" compares main with main and passes having looked at nothing; prove the folder with `git rev-parse --absolute-git-dir`, or gate from the primary against the archived tip.
- [a concurrent `pnpm install` makes the shared node_modules look BROKEN](a-concurrent-pnpm-install-makes-node-modules-look-broken.md) - `next` gone and 63 entries → 61 right after removing a worktree's junction reads as "I deleted through the link"; find the running install before believing it, and remove a junction with `cmd /c rmdir`, never `rm -rf`.
