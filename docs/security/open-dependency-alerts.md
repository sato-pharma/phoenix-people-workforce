# Open dependency alerts — what gates, what does not, and why

A standing record, not a dated one-off: update it when the answer changes, rather than adding a new
file each time. It exists because "there is an open HIGH alert" and "a merge is about to be blocked"
are different statements, and a session at 4am that treats them as one will hunt a bump that does not
exist.

## The rule

`validate` runs **`pnpm audit --audit-level=high --prod`** at the repository root
(`scripts/ci-dependency-audit.mjs`). An open Dependabot alert can turn that red **only** if it is in
a tree that command actually walks. Two kinds cannot:

| Why it cannot reach the gate | Read from |
| --- | --- |
| **`scope: development`** — the `--prod` filter drops the whole dev graph | `dependency.scope` on the alert |
| **A manifest the root audit never reads** — a second application's npm or yarn lockfile elsewhere in the repo | `dependency.manifest_path` |

`pnpm-workspace.yaml` declares **no `packages:` list** ("This is a single-package repo: no
`packages:` list on purpose"), so the root audit walks exactly one tree: `package.json` +
`pnpm-lock.yaml`. That pair is `AUDITED_MANIFESTS` in `scripts/dependabot-alerts.mjs`, and
`tests/dependabot-alerts.test.ts` fails if a `packages:` list ever appears without the set growing to
match.

## The decision this records

**An open HIGH alert outside the audited tree is reported, not bumped, and does not block a merge.**
It is not suppressed and not hidden: `node scripts/check-dependabot-alerts.mjs` prints every one with
the reason it is out of reach, and exits 0 only because the gate genuinely cannot go red on it.

**This is not a risk acceptance for anything that ships.** A `development`-scope package is not in
the production graph, so nothing vulnerable reaches production by this route — that is a scope fact,
not a tolerance. A finding in another application's lockfile belongs to that application's own
scanning, not to this repo's audit gate.

🔴 **A reachable HIGH is unchanged and still blocks.** Scope `runtime` in the root lockfile fails
`validate` the moment the audit feed learns the advisory, and by AGENTS.md §2.3 a red suite on a
`main` commit makes Railway mark that production deploy **SKIPPED** for good. Bump those in one PR
before merging anything else.

## It fails closed, and that is the whole safety argument

An alert is downgraded **only when the reason is positively read**. Every absent or unrecognised
answer stays failing:

- an absent `scope`, or one that is neither `development` nor `runtime`
- an absent, empty or unreadable `manifest_path`
- **an unreadable `severity`** — reachability answers "can this turn the gate red", which is weaker
  than "is this dangerous", so an alert nobody could grade stays loud whatever tree it is in

So the worst a wrong reading can do is keep an alert noisy. It can never quiet one. Each of those
four directions is pinned by its own named assertion in `tests/dependabot-alerts.test.ts`, and each
was verified by breaking the rule and watching that assertion — not a neighbouring one — fire.

## What this corrected (2026-10-04)

`scripts/dependabot-alerts.mjs` graded purely on severity. Its own comment gave the reason:
the `--prod` filter is about prod-vs-dev, *"which the alert payload does not state, so guessing it
here would produce a confident wrong answer."*

**The payload does state it.** Every open alert carries `dependency.scope`. Grading without it is
what produced the confident wrong answer: on 2026-10-04 the tool printed `WILL FAIL CI` for three
alerts and exited 1, while the gate command itself — `node scripts/ci-dependency-audit.mjs` — exited
**0** on *"No known vulnerabilities found"* with all three open, and `pnpm audit --audit-level=high
--prod` agreed. None of the three had a patched version, so the instruction the tool gave (bump them
before merging) could not be followed by anyone.

That mattered because the ship skill reads this check before every merge. A pre-merge gate that cries
wolf is one people learn to wave through, which is the same failure as not having it — and the
2026-09-30 incident it was built for is the case where waving through costs three production deploys.

## Reading it

```bash
node scripts/check-dependabot-alerts.mjs          # exit 1 only on an alert that can really go red
node scripts/check-dependabot-alerts.mjs --json   # the whole reading, including the unreachable set
```

🔴 **`skipped — …` is still not a pass.** It means nothing was read — no `gh`, not authenticated, no
network, or a token without `security_events`. A zero from a repo with alerts switched off still
exits 1. Neither of those changed here.
