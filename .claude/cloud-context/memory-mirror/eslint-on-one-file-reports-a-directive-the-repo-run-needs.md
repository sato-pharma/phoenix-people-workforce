---
name: eslint-on-one-file-reports-a-directive-the-repo-run-needs
description: "linting ONE file reports `Unused eslint-disable directive` for `react-hooks/set-state-in-effect` that the SAME file needs when linted beside the rest of the repo - so removing the directive on that advice (or with --fix) turns a clean file into 3 CI errors, and the single-file run is the one that lies"
metadata:
  node_type: memory
  type: feedback
---

Measured 2026-10-06 in `_wt-production-planner`, on
`src/components/production-planning/production-planning-workspace.tsx`.

**What happens.** `node ./node_modules/eslint/bin/eslint.js --no-warn-ignored <one-file>` reported
two `Unused eslint-disable directive (no problems were reported from
'react-hooks/set-state-in-effect')` warnings. `--fix` duly removed them. Linting the SAME file in
the same command as the other ten changed files then reported **3 errors** from that exact rule -
the two whose directives had just been deleted, plus a third site. The rule's analysis is not
per-file stable: a `useCallback` whose dependency array changed, and the file's company on the
command line, both move it.

**Why it matters.** CI lints the repo, not one file. So the single-file reading is the one that is
wrong, and acting on it is how a file that was green becomes three lint errors on the PR - after a
push, which is 14 billable minutes to find out.

**The habit:** lint the way CI does. Pass the whole changed set in ONE command
(`git status --porcelain | awk '{print $2}' | grep -E '\.(ts|tsx|mjs)$'`), and never act on an
"unused directive" warning seen in a single-file run - re-read it in the multi-file run first. If
the rule fires there, the directive is load-bearing and the warning was the lie.

Related: [[a-green-test-run-carries-no-type-signal-at-all]] - a green lint carries no type signal
either, and the local typecheck is denied here, so `node scripts/remote-check.mjs all` on the
committed sha is the only thing that reads both.
