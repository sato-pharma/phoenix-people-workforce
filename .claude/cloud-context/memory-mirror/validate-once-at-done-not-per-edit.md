---
name: validate-once-at-done-not-per-edit
description: "Run only typecheck while iterating; the full gate (tests/build/harden) runs ONCE when the owner says done"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7d9767b-6023-40ee-aed7-29f5ee72470b
  modified: 2026-08-10T04:43:32.257Z
---

While the owner is still making edits, run **`pnpm run check:edit` (typecheck only)** — never the
full suite, never `check:harden`, never `build`. The heavy gate runs **once**, at the end, when he
says the work is done.

He said it plainly on 2026-08-04, angry, after I ran `check:harden` (82s build) plus three full
593-file suite runs mid-task on the direct-orders chain change: *"WHY THE FUCK U DID ALL THESE
TESTS I WSTILL HAVE MANAY EDITS AFTER I TELL U DONE U MAKE THESE BUG TESTS ONCE"*.

**It happened again on 2026-08-10** — six lint+typecheck+test runs while he was iterating on one
line of banner copy on the Finance Command Center: *"skip fucken validation and testing to the very
end when only i say"*. The trigger that time was my own habit of "verify after every change", which
is right for a browser check (cheap, seconds) and wrong for the suite. **A UI/copy tweak gets a
browser reload, not a gate.** The bar is not "have I changed something" — it is "has he said done".

**Why:** the laptop's RAM is soldered at 16GB ([[laptop-m17r2-ram-soldered-16gb-ceiling]]) and a
build/suite run thrashes the pagefile ([[laptop-thrashing-pagefile-feedback-loop]]), so every
premature gate costs him minutes of a machine he is still typing on — and re-validating work that
is about to change again proves nothing. AGENTS.md §7 already says this ("run typecheck+lint once
after the batch of edits — not after each one"); I ignored it. Fits his standing
[[owner-heavy-parallel-workload-reduce-friction]] rule.

**How to apply:** during iteration, typecheck only (`pnpm run check:edit`), and stay quiet about it.
Ask "done?" rather than assuming a pause means finished.

**Corrected 2026-08-23 — when he says done there is no local gate left to run.** This memory used to say
"then `check:harden`"; that gate was retired 2026-08-18 at the owner’s instruction and the script no longer
exists in `package.json`. Push the branch and let the PR’s required checks answer
([[local-validation-gates-are-gone-ci-is-the-gate]]). Still run the prove-it-fails step on any new regression
test ([[prove-it-fails-verify-which-assertion-fired]]), and still check **migrations** and **production deploys**
by hand immediately before the action — CI never sees those two.

**The cadence itself is unchanged and is the durable part of this memory: do not validate while he is still
editing.** That is what he was angry about both times, and it did not depend on which command was being run.

Absorbed `validation-cadence-preference.md` (retired 2026-08-23 as a thinner, older duplicate of this file).
Its one distinct point still holds: **`build` and the test suite run only on an explicit instruction**, never
on my own initiative during iteration.
