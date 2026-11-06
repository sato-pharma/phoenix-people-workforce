# Open dependency alerts — what gates, what does not, and why

A standing record, not a dated one-off: update it when the answer changes, rather than adding a new
file each time. It exists because "there is an open HIGH alert" and "a merge is about to be blocked"
are different statements, and a session at 4am that treats them as one will hunt a bump that does not
exist.

## The rule

The `static` job, which `checks` stands for, runs **`pnpm audit --audit-level=high --prod`** at the
repository root (`scripts/ci-dependency-audit.mjs`). An open Dependabot alert can turn that red **only** if it is in
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
`checks` the moment the audit feed learns the advisory, and by AGENTS.md §2.3 a red suite on a
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

## What this corrected (2026-10-06) — the two APIs spell MEDIUM differently

The same cry-wolf failure returned from the opposite direction, and the fail-closed rule above is
what let it: `KNOWN_SEVERITIES` listed `low, moderate, high, critical`. **The REST endpoint this
tool reads — `repos/<repo>/dependabot/alerts` — answers `medium`.** `moderate` is the GraphQL and
`npm audit` spelling. So every MEDIUM alert fell outside the known set, was graded urgent by the
unreadable-severity rule, and printed as:

```
WILL FAIL CI: UNREADABLE-SEVERITY(medium) — graded urgent because it could not be graded
```

under a headline `2 open HIGH+ alert(s)`. Measured against the live endpoint on 2026-10-06:
`postcss-selector-parser` (GHSA-rj75-hqrm-r3gf, CVSS **5.9**) and `sprintf-js`
(GHSA-hp3w-g68c-fv3c, CVSS **5.3**) both answered `severity: "medium"`. Neither can fail
`--audit-level=high`; `sprintf-js` has **no patched version at any version**, so once again the
instruction the tool gave could not be followed by anyone.

🔴 **The tell was in the message itself: a severity the line can PRINT is not a severity it could
not READ.** `UNREADABLE-SEVERITY(medium)` names the value it claims to have failed to read. Any
future report of that shape means a spelling is missing from the set, never that GitHub sent
nothing — and the fix is to add the spelling, never to widen `AUDIT_FAILING_SEVERITIES`, which
remains `high` and `critical` alone.

This does not soften the fail-closed argument, it pays its known price. Grading an absent severity
as urgent is still right; the bug was treating a *stated* severity as absent. Pinned by case **3b**
in `tests/dependabot-alerts.test.ts`, which asserts both spellings land below the gate and that
neither is described as unreadable.

## The standing decisions, per advisory

The policy above says an unreachable alert is reported rather than bumped. That is the *rule*. This
is the **record of each one it has actually been applied to**, so that "still open" reads as a
decision somebody made rather than an oversight nobody noticed. An alert with no row here has not
been judged yet.

🔴 **ALERT NUMBERS BELONG TO ONE REPOSITORY, AND THE 2 NOV AND 4 NOV 2026 MOVES EACH RESTARTED THEM AT 1.** A row keeps a
`#N` in its Alert cell only when that number is a live alert on `sato-pharma/phoenix-people-workforce`
for the same advisory in the same manifest. A row from before the move with no such alert names its old
number in words, so the check cannot read it, and a new alert that later reaches that number is never
taken as already accepted. If one of those advisories opens here again, put the new `#N` in its Alert
cell, but only for the same advisory and manifest. Rows read 2026-11-03 17:02 Cairo.

### `braces` — GHSA-vfj7-8cjw-p6xm · CVE-2026-93687 · HIGH (CVSS 7.5)

| | |
| --- | --- |
| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-10-04 at the owner's instruction. |
| Alert | none on this repository yet. It was number 112 on the old repository, opened 2026-10-03, root `pnpm-lock.yaml` |
| Scope | `development` — the `--prod` filter drops it, so it cannot turn `checks` red |
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
  then a reachable HIGH, it blocks `checks`, and AGENTS.md §2.3 applies
- the advisory is re-scored with a confidentiality or integrity impact
- `shadcn` stops being a `devDependency`

🔴 **This row is not a precedent for the other open alerts.** It accepts *this* advisory on *these*
three facts. The two that sit in `mobile/package-lock.json` are a different situation entirely, and
they are judged separately below — on different facts, and on a narrower acceptance.

### `braces` — GHSA-vfj7-8cjw-p6xm · CVE-2026-93687 · HIGH (CVSS 7.5)

| | |
| --- | --- |
| **Decision** | **Accepted for this repository's audit gate only.** Recorded 2026-10-05 at the owner's instruction. |
| Alert | none on this repository yet. It was number 111 on the old repository, opened 2026-10-03, `mobile/package-lock.json` |
| Scope | **`runtime`** — but in a manifest `pnpm audit` never reads at the root, so it still cannot turn `checks` red |
| Patched version | **none exists** |
| What it is | Stack-exhaustion denial of service through deeply nested patterns |
| Impact vector | `C:N/I:N/A:H` — availability only |

**This is a narrower acceptance than the `braces` row above, and the difference matters.** That one is
`development` scope, so nothing vulnerable is in a shipped graph at all — that is a scope fact.
This one is `runtime` scope within its own lockfile. What makes it unable to gate is only that the
root audit never walks that manifest, which is a statement about **this repo's CI**, not about the
package being harmless wherever that lockfile is built. There is no patched version to move to, so
there is no action this repository can take either way.

### `node-forge` — GHSA-86w9-cpqp-85rv · CVE-2026-85393 · HIGH

| | |
| --- | --- |
| **Decision** | **Accepted for this repository's audit gate only.** Recorded 2026-10-05 at the owner's instruction. |
| Alert | #2, opened on this repository 2026-11-04 03:02 Cairo, the same number it had on the previous repository, `mobile/package-lock.json`. Before that it was number 110 on the old repository, opened 2026-10-03 |
| Scope | **`runtime`**, in a manifest the root audit never reads |
| Patched version | **none exists** |
| What it is | RSA PKCS#1 v1.5 signature verification accepts extra nested `DigestAlgorithm` elements |
| Impact vector | `C:N/I:H/A:N` — **integrity**, not availability |

🔴 **This one is not the same kind of finding as the two `braces` rows, and the record should not
flatten them together.** A signature-verification bypass is an integrity defect: it lets a crafted
signature verify as valid. The reasons the other rows lean on — "availability only", "a developer
hanging their own terminal" — **do not apply here** and must not be borrowed for it.

What this acceptance does and does not say:

- **It does say** the alert cannot turn `checks` red, because the root audit does not read that
  manifest; verified the same way as the rows above, by the gate command exiting 0 with it open.
- **It does say** there is nothing to bump to — `first_patched_version` is null — so no PR in this
  repository could clear it today.
- 🔴 **It does NOT say the package is safe in whatever is built from that lockfile.** That artifact
  has its own scanning and its own judgement, and this file has no standing over it.

**What would reverse this** — any one of these, for either row:

- a patched version is published → bump it and delete the row
- the advisory appears in the **root** `pnpm-lock.yaml` graph → it is then a reachable HIGH, it
  blocks `checks`, and AGENTS.md §2.3 applies
- **anything is next built or distributed from `mobile/package-lock.json`** → the `node-forge`
  integrity finding is re-judged first, on its own merits, by whoever owns that artifact. An
  acceptance recorded against a CI gate is not a clearance for a shipped binary.

### `source-map-js` — GHSA-68fv-2mgg-jv7q · CVE-2026-93749 · HIGH (CVSS 7.5)

| | |
| --- | --- |
| **Decision** | **Accepted for this repository's audit gate only.** Recorded 2026-10-06 at the owner's instruction. |
| Alert | none on this repository. It was number 113 on the old repository, opened 2026-10-06 05:56 Cairo, `mobile/package-lock.json` |
| Scope | **`runtime`**, in a manifest the root audit never reads |
| Patched version | **1.2.2 exists** — and that is what makes this row different from the three above |
| How it arrives | `source-map-js@1.2.1` ← `postcss`, which declares `^1.2.1` |
| What it is | Event-loop denial of service through indexed source-map section offsets |
| Impact vector | `C:N/I:N/A:H` — availability only |

🔴 **GITHUB CLOSED THIS ALERT AS `fixed` THE SAME DAY, 2026-10-06 17:53 Cairo — so this row is the
record of a decision, not a live acceptance.** Read live: `gh api
repos/it-gawish-hr/phoenix-people-workforce/dependabot/alerts/113` returns `state: fixed`, `fixed_at
2026-10-06T14:53:13Z`, `dismissed_at: null`. Nothing in this repository dismissed it and no bump
was made here, so the closure came from GitHub's own re-scan and the alert itself does not record
why. **That is not evidence the acceptance below was unnecessary**: it was taken at 05:56 Cairo on
an open HIGH, twelve hours before the alert closed, and the reasoning is what a session needs the
next time a patched-but-unreachable finding appears.

🔴 **THIS IS THE FIRST ROW HERE WHERE A FIX EXISTS, SO THE USUAL SENTENCE CANNOT BE USED.** Every
acceptance above rests partly on `first_patched_version` being null — *"there is nothing to bump to"*.
That is **not true here**: 1.2.2 is published, and `postcss`'s own `^1.2.1` already permits it, so the
change would be a one-line lockfile resolution. What makes this one unable to gate is **only** that
`pnpm audit --prod` never walks `mobile/package-lock.json` at the root — the same narrow ground as
the second `braces` row, and nothing more.

**Why it is accepted rather than bumped.** The file is under `mobile/`, which AGENTS.md §4's first
bullet freezes until the owner lifts it in his own words — and that freeze is enforced, not merely
written down, by `.claude/hooks/mobile-freeze-guard.mjs`. So no session here can make that one-line
change, and nothing is built or distributed from that lockfile while the freeze stands. The
acceptance is therefore about **where the fix has to happen**, never about the finding being small.

- **It does say** the alert cannot turn `checks` red: the root audit does not read that manifest,
  verified the same way as the rows above.
- 🔴 **It does NOT say there is nothing to do** — there is, and it is a one-line bump. It is simply
  not this repository's to make today.
- 🔴 **It does NOT say the package is safe in whatever is built from that lockfile.**

**What would reverse this.** Any one of these, and it stops being accepted:

- **the freeze is lifted** → bump to 1.2.2 in the first dependency PR after it, and delete this row.
  🔴 Unlike the rows above, this one has no "wait for upstream" condition left to satisfy: the only
  thing standing between the alert and its fix is the freeze.
- the advisory appears in the **root** `pnpm-lock.yaml` graph → it is then a reachable HIGH, it blocks
  `checks`, and AGENTS.md §2.3 applies
- anything is built or distributed from `mobile/package-lock.json` → re-judged first, by whoever owns
  that artifact, and with a published patch available the answer is very unlikely to be this one

### `sprintf-js` — GHSA-hp3w-g68c-fv3c · MEDIUM (CVSS 5.3)

| | |
| --- | --- |
| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-10-06 at the owner's instruction — asked directly, he answered *"leave sprintf-js as it is — it never loads"*. |
| Alert | none on this repository yet. It was number 116 on the old repository, opened 2026-10-06 05:56 Cairo, root `pnpm-lock.yaml` |
| Scope | **`runtime`** — it IS in the production graph, so scope is not what makes this quiet |
| Severity | **MEDIUM**, so `--audit-level=high` does not fail on it. This is the alert that exposed the `medium`/`moderate` spelling bug above |
| Patched version | **none at any version** — every published release, 0.0.7 through 1.1.3, is inside `<= 1.1.3` |
| How it arrives | `sprintf-js@1.0.3` ← `argparse@1.0.10` ← **`mammoth@1.12.3`**, a production dependency (the .docx reader behind CV extraction) |
| What it is | Denial of service through unbounded precision specifiers in `sprintf` |
| Impact vector | `C:N/I:N/A:L` — **availability only, and LOW.** No confidentiality or integrity impact |

**It is never loaded, and that is measured rather than assumed.** `argparse` is referenced in
exactly one file of the installed `mammoth` package — `node_modules/mammoth/bin/mammoth`, the
command-line tool — and in its `package.json`. A full require-graph walk from the library entry
`mammoth/lib/index.js` visited **78 files and never reached `argparse`**. Phoenix only ever uses the
library API (`import * as mammoth from "mammoth"` in `src/lib/recruitment/cv-extraction.ts`, calling
`mammoth.extractRawText`), and nothing in this repository runs the `mammoth` binary. So the package
is on disk and never required: the vulnerable `sprintf` is never called, by us or by mammoth.

**What it would take to remove it.** `mammoth@1.12.3` and the current `1.13.0` both declare
`argparse: ~1.0.3`, so bumping mammoth does not help. `argparse@2` has **no dependencies at all**,
so a `pnpm.overrides` entry forcing it would delete the chain outright — at the cost of a real risk
to the .docx reader, since argparse 2 dropped APIs its CLI uses. That is a live option with a live
cost, **not an impossibility**: an earlier draft of this page's sibling note called this dependency
"permanently unfixable" and that was wrong on both counts — see the 2026-10-06 section above, and
`proxy-addr`, which was called the same thing and was bumped by hand the same day.

**What would reverse this.** Any one of these, and it stops being accepted:

1. **Something in this repository starts running the `mammoth` binary**, or calls `sprintf` with a
   format string it did not write itself. The acceptance rests on reachability, not on severity, so
   this is the condition that actually matters — re-walk the require graph from
   `mammoth/lib/index.js` if the .docx path is reworked.
2. **A patched `sprintf-js` is published.** There is then something to bump to, and the reason for
   accepting disappears; take it in the next dependency PR.
3. **The advisory is re-scored above MEDIUM**, which would make it able to fail
   `--audit-level=high --prod` on a `runtime`-scope package — the one combination this page treats
   as blocking.

**Why it is worth a row despite being below the gate.** The alert's own creation, at 05:56:00, is
what triggered the Dependabot updater runs four seconds later; those runs failed
`security_update_not_possible` — correctly, there is nothing to update to — and **that withheld the
production deploy of the commit merged seconds earlier**. So an alert that cannot fail the audit
still cost a deploy. The mechanism is recorded in `docs/agents-session-traps-clusters.md`.

### `glob` — GHSA-3g3m-2fjr-6pw4 · MEDIUM

| | |
| --- | --- |
| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-11-03 at the owner's instruction, choosing "Accept both" when asked about this alert and the `minimatch` one below. |
| Alert | #19, opened on this repository 2026-11-04 03:02 Cairo, the same number it had on the previous repository, root `pnpm-lock.yaml` |
| Scope | **`runtime`**, because `@sentry/nextjs` is a production dependency, but this code only runs during the build |
| Severity | **MEDIUM**, so `--audit-level=high` does not fail on it |
| Patched version | **14.0.2 only** — no 13.x release carries the fix, and `@sentry/bundler-plugins` 11.10.0, its newest, still asks for `^13.0.6` |
| How it arrives | `glob@13.0.6` ← `@sentry/bundler-plugins` ← `@sentry/nextjs`, and the development tool `c8`. `glob@7.2.3` under `exceljs` is below the affected range |
| What it is | A walk cancelled through `signal` keeps reading directories in the background |

**The flaw needs a cancel signal, and Sentry never passes one.** The whole of its use is
`build/cjs/core/glob.js`: `glob(patterns, { absolute: true, nodir: true, ...options })`, and its callers
pass only `ignore` or `root`. A search of the installed package for `signal:` found none (3 Nov 2026).
`next.config.ts` is the only file that loads `@sentry/nextjs/config`, and only on a build that holds a
Sentry token. Nothing else outside the frozen application imports `glob`.

**What would reverse this.** Any one of these:

1. **Code in this repository calls `glob` with a `signal`**, or Sentry's build tools start to.
2. **The advisory is re-scored above MEDIUM**, which would let it fail the audit on a `runtime` package.
3. **Sentry's build tools accept a patched `glob`.** Take it in the next dependency refresh.

### `minimatch` — GHSA-g3hv-75wg-m249 · MEDIUM

| | |
| --- | --- |
| **Decision** | **Accepted. Not bumped, not overridden.** Recorded 2026-11-03 at the owner's instruction, choosing "Accept both" when asked about this alert and the `glob` one above. |
| Alert | #20, opened on this repository 2026-11-04 03:02 Cairo, the same number it had on the previous repository, root `pnpm-lock.yaml` |
| Scope | **`runtime`**, because `@sentry/nextjs` and `exceljs` are production dependencies |
| Severity | **MEDIUM**, so `--audit-level=high` does not fail on it |
| Patched version | **11.0.1 only** — 3.1.5, 5.1.9 and 10.2.6, the three we resolve, are each the newest of their line |
| How it arrives | `10.2.6` ← `glob@13.0.6` above, and development tools. `3.1.5` ← `glob@7.2.3` ← `archiver-utils` ← `archiver` ← `exceljs`, and ESLint. `5.1.9` ← `readdir-glob` ← `archiver` ← `exceljs` |
| What it is | A crafted glob pattern multiplies during preprocessing and uses up CPU and memory |

**Only 10.2.6 holds the flawed code, and no user reaches it.** `firstPhasePreProcess` appears in the
installed 10.2.6 and nowhere in 3.1.5 or 5.1.9, which the advisory's `< 11.0.1` range catches by number
alone. `glob` does run 10.2.6 at the `optimizationLevel: 2` the flaw needs, so the safety here is who
writes the pattern: Sentry's build tools and `next.config.ts`, never a request. Nothing outside the frozen
application imports `minimatch`. `exceljs` uses `archiver` only to write zip files, and never calls its
`glob` or `directory`.

**Forcing the fix is the wrong trade.** `minimatch@3.1.5` exports a callable function, which its
callers depend on, and 11.x does not: the same break `pnpm-workspace.yaml` records for
`brace-expansion` 5.x would be likely here, in ESLint and the Excel exports (not tested). `exceljs` 4.4.0
is already its newest release and asks for `archiver ^5.0.0`, and 120 files import it.

**What would reverse this.** Any one of these:

1. **Code in this repository or a request-time path passes a pattern a user wrote** to `minimatch` or
   `glob`. The acceptance rests on who writes the pattern, so this is the condition that matters.
2. **The advisory is re-scored above MEDIUM**, which would let it fail the audit on a `runtime` package.
3. **`exceljs` moves off these lines, or `exceljs` is replaced for another reason.** Re-read the chain then.

🔴 **`check-dependabot-alerts.mjs` KEEPS PRINTING `bump to 14.0.2` AND `bump to 11.0.1` FOR THESE TWO, ON PURPOSE.** It adds
`risk ACCEPTED` only to an alert outside the audited tree, and both of these are in the root lockfile, so
a recorded acceptance can never read as a reason to leave something that could turn `checks` red. Read
the two rows above before acting on those lines.

## Reading it

```bash
node scripts/check-dependabot-alerts.mjs          # exit 1 only on an alert that can really go red
node scripts/check-dependabot-alerts.mjs --json   # the whole reading, including the unreachable set
```

🔴 **THE CHECK READS THE ROWS ABOVE, so a decision written here stops the tool demanding one.** An
unpatched alert with a row prints `risk ACCEPTED, recorded <date>`; one without keeps
`needs an override, a replacement, or a recorded risk decision`. Added 2026-10-05, because the
demand used to print on **every** unpatched alert including the first `braces` row, whose decision was already
written and dated — and the ship skill reads this check before every merge, so a session read that
line at the moment it was deciding to merge, believed three alerts were unjudged, and put the
already-answered question to the owner. A demand that outlives its answer is the same cry-wolf
failure as the 2026-10-04 false `WILL FAIL CI`, arriving from the other direction.

**It is keyed on the alert NUMBER, never the GHSA** — which is what makes the red note above true
mechanically rather than only in prose. One advisory opens one alert per manifest, so `braces`
`GHSA-vfj7-8cjw-p6xm` was two alerts on the old repository, one in the root lockfile and one elsewhere;
keying on the advisory would turn this file's explicit refusal to judge the other one into an automatic
acceptance, silently.

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

🔴 **A 403 can mean the alerts are off, not that the token is short.** The endpoint answers
`Dependabot alerts are disabled for this repository. (HTTP 403)` when the setting is off. The check
now reports that as `SWITCHED OFF` and exits 1. Until 3 Nov 2026 it blamed the token and exited 0,
which hid that alerts had never been turned on after the 2 Nov move to
`gawishtheit/phoenix-people-workforce`: a repository setting does not come across with the code.
Turning them on is the owner's click, in the repository's Security settings. It is not a bump, and
the audit behind `checks` is still the gate.

🔴 **Switched on does not mean scanned.** On 3 Nov 2026 alerts read on at 15:43 and the check printed
`OK` on a zero, while GitHub's dependency list (`dependency-graph/sbom`) still answered 404. It held
1,812 packages by 16:00, and the first of 20 alerts came at 16:11. A zero now asks that list too:

- **Empty or 404:** exit 1, saying GitHub has not scanned the repository.
- **Could not be read:** exit 0 and "this is not a pass", like any other skip.
- **Filled:** `OK`, with a warning. Between 16:00 and 16:11 the list was filled and the alerts were not
  there yet, and nothing GitHub answers tells those minutes from a finished scan. A zero within about
  30 minutes of switching alerts on can still be early, and the check says so.

GraphQL `dependenciesCount` read 0 on all 33 manifests at 16:00 with the list already filled, so it
is not a signal for this.
