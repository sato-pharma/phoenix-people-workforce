---
name: sonar-gate-conditions-are-invisible-and-hotspots-need-a-human
description: "RETIRED 2026-10-01 — THE SONARCLOUD GATE NO LONGER EXISTS: no sonar workflow is on origin/main at all, so none of this is live. Kept only as the account of why it went; never hunt this gate, and never read a red Sonar check into a PR that cannot have one"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2d66b5e6-1a1a-44ee-8e95-86506c216715
  modified: 2026-10-01T00:00:00.000Z
---

🔴 **RETIRED 2026-10-01 — THERE IS NO SONAR WORKFLOW IN THIS REPO ANY MORE.** `git ls-tree -r origin/main .github/workflows | grep -i sonar` returns nothing, so the gate described below cannot fail, cannot be read and cannot be satisfied. Everything after this line is the ACCOUNT of a gate that was removed, never guidance to act on. Its old citation `.github/workflows/sonarqube.yml:53` names a file that no longer exists. Found by the memory-citation sweep and confirmed against `origin/main`; the dated record [[branch-up-to-date-rule-disabled-2026-08-05]] also cites that file and is deliberately LEFT ALONE, because a dated record is never rewritten.

When `sonarqube` fails on a PR, **do not infer which condition failed — you cannot see it, and
guessing costs hours.**

- The scanner log prints only `ERROR QUALITY GATE STATUS: FAILED` plus the dashboard URL. No
  condition, no number.
- Every `sonarcloud.io/api/*` endpoint returns **404 anonymously** (private project).
  `SONAR_TOKEN` lives in GitHub secrets and is not readable.
- The only way to learn the failing condition is the dashboard — **ask the owner to read it.**

**"Security Hotspots Reviewed on New Code = 100%" is a WORKFLOW condition, not a quality one.**
It counts *human reviews*, not clean code. A hotspot must be marked Safe / Fixed / Acknowledged in
the SonarCloud UI. No code change satisfies it: remove one hotspot and the next one blocks you.
CI can never turn it green.

**Why:** 2026-08-05, PR #1784. Three wrong hypotheses in a row before the owner read the dashboard:
1. "coverage too low, write more tests" — wrong; it was a measurement bug (below).
2. "88.9% on new code clears the 80% gate" — wrong; Sonar reported **0%**.
3. "the `[\s\S]{0,600}?` ReDoS-shaped regex is the hotspot" — wrong; removing it changed nothing.
The real condition was `Security Hotspots Reviewed 0% / required 100%` all along.

**Also settled that day (PR #1749, merged `597571e0`):** `c8` only reports files it LOADED, and most
of this repo's tests are source-inspection tests (`readFileSync` + assert on text) that never
`import` the module. ~2,300 source files were absent from lcov — and **Sonar reads an absent file as
0%** while the local summary dropped them from the denominator. The workflow now uses
`c8 --all --src=src --src=app`. True numbers: repo-wide **22.7%**, **44.9%** after coverage
exclusions (`app/**`, `**/*.tsx`, `scripts/**`, `supabase/**`), branch coverage **73.8%**.
The 55% previously shown was never real.

**A UI review did NOT clear it either.** The owner marked the hotspot reviewed; the next analysis
was still red. Best explanation: branch protection requires up-to-date branches, so nearly every PR
here gets `gh pr update-branch` at least once, which moves the head — and a hotspot whose location
shifts is re-raised as NEW and needs reviewing again. At ~30 commits/day the requirement resets
faster than anyone can satisfy it, so on this repo the condition is effectively unsatisfiable.

**How to apply:** if a sonar gate blocks a PR, ask for the condition name + numbers before writing
any code. If it is Security Hotspots, **do not attempt a code fix and do not rely on a UI review** —
the durable resolution is removing that condition from the custom quality gate (SonarCloud UI,
owner-only). 🔴 **This line used to say "`sast-scan` still runs and still gates, so security analysis
is not lost." That is FALSE and it was a false reassurance about security coverage — corrected
2026-08-23.** Semgrep's `sast-scan` was deliberately never restored (4m14s per PR vs gitleaks' 13s)
and **no longer runs at all**, and it is not among the required checks — which are **TWO** as of
2026-10-01, `validate` and `checks` (read live against the branch-protection API; this line used to
name four, `validate`/`lint`/`typecheck`/`secret-scan`, and #4527 folded the middle two into
`checks` while `secret-scan` was dropped from protection on 2026-09-29). **The `sonarqube.yml`
reference this paragraph used to cite is also gone** — the whole workflow was deleted in `9b12f4dd5`
(#3484, *remove SonarQube Cloud entirely*, 2026-09-08), which makes the claim stronger, not weaker.
So dropping the Security Hotspots condition really does drop that coverage; what remains is gitleaks
secret scanning plus Sonar's own advisory analysis. See
[[github-personal-account-no-ghas-oss-scanning]]. Note the
sonar workflow is PR-only by design (a full main scan fails server-side on the free plan's LOC cap),
so a red result on main never clears itself. See [[ci-does-not-run-check-harden]].
