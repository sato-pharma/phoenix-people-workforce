---
name: grepping-a-wrapped-report-turns-an-explanation-into-a-verdict
description: "Grepping a wrapped multi-line report returns a middle line that reads as a finding — repo-doctor's `MEMORY.md back over budget.` is the TAIL of `Do NOT give these an index line: that would…`, and it sent a session trimming an index that was 43 bytes UNDER budget."
metadata:
  node_type: memory
  type: reference
  originSessionId: 2798e53f-77f8-410a-b9c0-09a076bb0d41
  modified: 2026-09-29T17:39:20.233Z
---

`scripts/repo-doctor.mjs` and the other report scripts here **wrap their prose at ~95 columns**. A
grep matches ONE line of a sentence that spans three, and the middle of an explanation reads exactly
like a verdict.

Measured 2026-09-29. The real output:

```
  MEMORY.md 21.4KB — budget 21.5KB, loader cliff 23.8KB — 43 bytes of budget left
  68 memory file(s) are reachable from AGENTS.md rather than the index — relocated on purpose
  (AGENTS.md 2.2). Do NOT give these an index line: that would undo the relocation and put
  MEMORY.md back over budget.
```

`grep -iE "orphan|memory|stranded"` returned the first, second and **fourth** lines and dropped the
third. What the session read was `MEMORY.md back over budget.` as its own line, directly under a
line about relocated files — a clean, plausible finding. It was reported to the owner as one, and he
spent a message asking for a trim. **The file was 21,957 of 22,000 — 43 bytes UNDER.** The sentence
was telling the reader NOT to add index lines; the tool was completely correct.

**The rule: never grep a report script's output. Read the section.** `grep -A/-B` is not a fix —
context flags still centre on the matched line and can cut the sentence's head. These scripts are
written to be read: `repo-doctor.mjs`, `memory-index-reachability.mjs`, `verify-shipped.mjs`.

**The tell, when a grep is unavoidable:** a line that starts mid-sentence — no capital, no bullet, no
leading label — is a continuation, never a finding. `MEMORY.md back over budget.` has no `->`, no
indent marker and no verb of its own; every genuine verdict line in these tools carries one.

**And measure the thing itself before acting on any report line about it.** One `Buffer.byteLength`
on `MEMORY.md` settled this in seconds and would have cost nothing before the report was believed.
Same family as [[verify-the-emitted-artifact-never-the-source]]: the artifact here is the file's own
byte count, not the tool's sentence about it. See also
[[a-green-test-run-carries-no-type-signal-at-all]] — the other way a green-looking readout said
nothing at all on the same night.
