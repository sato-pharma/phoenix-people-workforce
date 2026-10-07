---
name: disk-idle-is-not-evidence-against-paging
description: "A 95%-idle disk with a 0.00 queue does NOT mean the box is not paging — `Memory\\Pages Input/sec` is the only test, and it read 9,447/sec here while the disk reported idle; `node scripts/slow-audit.mjs` reads it first."
metadata:
  node_type: memory
  type: project
  originSessionId: a77de15c-0ebe-49a8-bdd3-4bb32a1960ae
  modified: 2026-10-07T22:23:55.451Z
---

**The counter that decides whether this laptop is slow is `Memory\Pages Input/sec`, and the disk
figure cannot see it.** Measured 2026-10-08, 01:00–01:15 Cairo, with 8 Claude sessions open:
**9,447 hard page faults/sec** (peak 38,885) at **730 MB free of 16,174**, while
`PhysicalDisk % Idle Time` reported **91–95% idle** and CPU sat at 47%. An NVMe serves ~9,400
random 4K faults a second at a queue depth near zero, so it reports idle while every one of those
faults still costs the faulting thread its timeslice.

🔴 **This corrects the inference in the 2026-09-17 machine-ceiling note** — *"disk sat 99.6–99.9%
idle with a 0.00 queue while the box was slow"*. The observation was right; the conclusion drawn
from it, that paging was therefore not involved, is wrong. Do not reach for it again.

**Why it matters for a diagnosis.** Thrashing is the one cause that slows *everything at once* —
file reads, hook spawns, keystrokes, UI repaint — so that symptom shape rules the repo and CI out
before you look at them. It also contaminates other measurements: the same nine PreToolUse hooks
cost **686ms per Bash call at 958 MB free and 1,008ms ten minutes later at 730 MB**, with one bare
`node` spawn going 65ms → 138ms and nothing changed in between. A hook, build or test figure read
under pressure is a thermometer, not a cause — which is why `slowness-audits-compare-before-and-after`
holds and a single reading proves nothing.

**How to read it now:** `node scripts/slow-audit.mjs` (`--quick` for the machine layer only,
`--history` for every past run). It leads with the fault rate, prints the disk figure labelled as
proving nothing, appends every run to `~/.claude/logs/slow-audit.jsonl` and prints the delta
against the previous one. `tests/slow-audit.test.ts` fails if the disk figure ever appears inside
`verdict()`. Account: `docs/slowness-audit.md`.

Related: [[a-slow-reply-is-the-effort-level-not-the-machine]] ·
[[slowness-audits-compare-before-and-after]] ·
[[a-skipped-ci-step-is-0001-01-01-not-null]]
