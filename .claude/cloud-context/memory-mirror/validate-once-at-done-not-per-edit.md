---
name: validate-once-at-done-not-per-edit
description: "Never validate while the owner is still editing — not even a typecheck (a local typecheck is denied outright; check:edit and check:harden are retired). A UI/copy tweak gets a browser reload. When he says done, push the branch and let CI's required checks answer — no local gate, no quick lint+typecheck subset first."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7d9767b-6023-40ee-aed7-29f5ee72470b
  modified: 2026-10-02T16:39:26.754Z
---

While the owner is still making edits, run **no validation at all** — not the suite, not `build`,
and **not a typecheck**: a local typecheck is denied mechanically in every spelling
(`bash-guard.mjs` clause C8, CLAUDE.md), and `check:edit` and `check:harden` are both retired. When he
says the work is done, **push the branch and let the PR's required checks answer**
([[local-validation-gates-are-gone-ci-is-the-gate]]) — no "quick subset" of lint + typecheck first.
**Superseded 2026-10-02:** previously "run `pnpm run check:edit` (typecheck only) while iterating; the heavy gate runs once at done" — the retired local gates and C8 typecheck denial (`local-validation-gates-are-gone-ci-is-the-gate`, CLAUDE.md "CI is the gate").

He said it plainly on 2026-08-04, angry, after I ran `check:harden` (82s build) plus three full
593-file suite runs mid-task on the direct-orders chain change: *"WHY THE FUCK U DID ALL THESE
TESTS I WSTILL HAVE MANAY EDITS AFTER I TELL U DONE U MAKE THESE BUG TESTS ONCE"*.

**It happened again on 2026-08-10** — six lint+typecheck+test runs while he was iterating on one
line of banner copy on the Finance Command Center: *"skip fucken validation and testing to the very
end when only i say"*. The trigger that time was my own habit of "verify after every change", which
is right for a browser check (cheap, seconds) and wrong for the suite. **A UI/copy tweak gets a
browser reload, not a gate.** The bar is not "have I changed something" — it is "has he said done".

**Why:** the laptop runs on 16GB of RAM — two SODIMMs, NOT soldered, 32GB-capable
(`~/.claude/CLAUDE.md`, corrected 2026-09-24; [[laptop-m17r2-ram-soldered-16gb-ceiling]] is the older
reading) — and a build/suite run starves free RAM ([[laptop-thrashing-pagefile-feedback-loop]]), so every
premature gate costs him minutes of a machine he is still typing on — and re-validating work that
is about to change again proves nothing. AGENTS.md §7 said so even then; I ignored it. Today §7 goes
further — "CI is the gate. Do not run a local full validation" — and a local typecheck no longer fits
this box at all. Fits his standing [[owner-heavy-parallel-workload-reduce-friction]] rule.
**Superseded 2026-10-02:** previously "RAM is soldered at 16GB" and "§7: run typecheck+lint once after the batch of edits" — `~/.claude/CLAUDE.md` "This machine" (not soldered, 2026-09-24) and the current AGENTS.md/CLAUDE.md §7 (CI is the gate, C8).

**How to apply:** during iteration, run nothing — a browser reload for a UI change is the only check —
and stay quiet about it. Ask "done?" rather than assuming a pause means finished.
**Superseded 2026-10-02:** previously "during iteration, typecheck only (`pnpm run check:edit`)" — `local-validation-gates-are-gone-ci-is-the-gate` and the C8 local-typecheck denial.

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
