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

## The standing decisions, per advisory

The policy above says an unreachable alert is reported rather than bumped. That is the *rule*. This
is the **record of each one it has actually been applied to**, so that "still open" reads as a
decision somebody made rather than an oversight nobody noticed. An alert with no row here has not
been judged yet.

### `braces` — GHSA-vfj7-8cjw-p6xm · CVE-2026-93687 · HIGH (CVSS 7.5)

| | |
| --- | --- |
| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-10-04 at the owner's instruction. |
| Alert | #112, opened 2026-10-03, root `pnpm-lock.yaml` |
| Scope | `development` — the `--prod` filter drops it, so it cannot turn `validate` red |
| Patched version | **none exists** — there is nothing to bump to |
| How it arrives | `braces@3.0.3` ← `micromatch@4.0.8` ← `fast-glob` ← **`shadcn`**, a `devDependency` |
| What it is | Stack-exhaustion denial of service through deeply nested patterns |
| Impact vector | `C:N/I:N/A:H` — **availability only.** No confidentiality or integrity impact |

**Why accepting is the right answer rather than the convenient one.** Three things have to be true
together, and all three are:

1. **There is no fix to apply.** `first_patched_version` is null. The only alternatives to accepting
   are a `pnpm.overrides` pin to a version that does not exist, or dropping `shadcn` — a tool used by
   hand to scaffold components, whose removal would cost real workflow to avoid a risk that does not
   reach anything.
2. **It is not in the production graph.** `shadcn` is a `devDependency`; `braces` is never bundled,
   never served, and never present on the Railway image. The scope is read from the alert payload,
   not inferred — and the gate command agrees: `node scripts/ci-dependency-audit.mjs` exits 0 on
   *"No known vulnerabilities found"* with this alert open.
3. **The attack needs input nobody untrusted supplies.** The DoS needs a deeply nested glob pattern.
   The patterns `shadcn` expands are written by a developer in this repository, on a laptop, at a
   moment of their choosing. There is no path by which an employee, a rep, or an anonymous request
   reaches it. The worst outcome is a developer hanging their own terminal.

**What would reverse this.** Any one of these, and it stops being accepted:

- a patched version is published → bump it, in its own PR, and delete this row
- the alert's `scope` turns `runtime`, or `braces` appears in the root `dependencies` graph → it is
  then a reachable HIGH, it blocks `validate`, and AGENTS.md §2.3 applies
- the advisory is re-scored with a confidentiality or integrity impact
- `shadcn` stops being a `devDependency`

🔴 **This row is not a precedent for the other open alerts.** It accepts *this* advisory on *these*
three facts. The alerts that sit in a manifest the root audit never reads are a different situation
entirely: they are not accepted here, they belong to that application's own scanning, and nothing in
this file should be read as judging them.

## Reading it

```bash
node scripts/check-dependabot-alerts.mjs          # exit 1 only on an alert that can really go red
node scripts/check-dependabot-alerts.mjs --json   # the whole reading, including the unreachable set
```

🔴 **THE CHECK READS THE ROWS ABOVE, so a decision written here stops the tool demanding one.** An
unpatched alert with a row prints `risk ACCEPTED, recorded <date>`; one without keeps
`needs an override, a replacement, or a recorded risk decision`. Added 2026-10-05, because the
demand used to print on **every** unpatched alert including `#112`, whose decision was already
written and dated — and the ship skill reads this check before every merge, so a session read that
line at the moment it was deciding to merge, believed three alerts were unjudged, and put the
already-answered question to the owner. A demand that outlives its answer is the same cry-wolf
failure as the 2026-10-04 false `WILL FAIL CI`, arriving from the other direction.

**It is keyed on the alert NUMBER, never the GHSA** — which is what makes the red note above true
mechanically rather than only in prose. One advisory opens one alert per manifest, so `braces`
`GHSA-vfj7-8cjw-p6xm` is open as both `#112` here and `#111` elsewhere; keying on the advisory would
turn this file's explicit refusal to judge the other one into an automatic acceptance, silently.

**The parser fails closed**, like every other grading in `dependabot-alerts.mjs`: a row is honoured
only when one `###` section positively yields **one** alert number and a Decision cell saying
**Accepted** with a `Recorded <date>`. A differently-worded decision, a missing date, no alert
number, two numbers in one cell, or an unreadable file all record nothing and leave the demand
standing. 🔴 **So the table shape above is load-bearing** — if you restyle a row, keep its
`| **Decision** | **Accepted …** Recorded YYYY-MM-DD |` and `| Alert | #N … |` cells, or the
decision silently stops being honoured. `tests/dependabot-alerts.test.ts` asserts that at least one
decision still parses out of this file, so a restyle that breaks it goes red rather than quiet.

🔴 **`skipped — …` is still not a pass.** It means nothing was read — no `gh`, not authenticated, no
network, or a token without `security_events`. A zero from a repo with alerts switched off still
exits 1. Neither of those changed here.
