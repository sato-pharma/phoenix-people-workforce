---
name: a-docs-pointer-in-a-subfolder-does-not-count-for-the-long-bullet-gate
description: "The long-bullet gate only recognises docs/<file>.md — a pointer like docs/devices/headwind-rustdesk.md is invisible to it, so a bullet over 1,200 bytes citing one still fails validate."
metadata:
  node_type: memory
  type: project
  originSessionId: 8d9ef456-7d5b-448c-bbe6-0191201d52c5
  modified: 2026-11-26T11:20:47.499Z
---

`tests/agents-long-hooks-cite-docs.test.ts` matches an account pointer with
`/docs\/[A-Za-z0-9._-]+\.md/` — **no slash in the character class**, so a pointer into a
subfolder (`docs/devices/headwind-rustdesk.md`, `docs/security/…`) does NOT satisfy it. A rule
bullet in AGENTS.md §2/§4 or a `.claude/rules/<module>.md` Rules block that goes over 1,200 bytes
while citing a subfolder doc is reported as "names no docs/ file" and reddens the required
`validate` job, which reads as the citation being ignored rather than unmatched.

**Why:** 26 Nov 2026, adding the `network_quiet` sentence to the `phoenix-tablet-fleet-watch`
bullet in `.claude/rules/devices.md`. It cited `docs/devices/headwind-rustdesk.md` §8.22 and the
gate still failed, which cost three rounds of trimming to diagnose. Every other long bullet in
that file happens to sit under 1,200 bytes, so the gap had never shown.

**How to apply:** when a bullet's only account lives in a `docs/` subfolder, keep the bullet
**under 1,200 bytes** — measure it, do not estimate (`Buffer.byteLength(line)`). Widening the
regex to allow subfolders is the real fix and belongs in a PR that already touches the gate;
never delete a rule to make room. The same test also caps how many bullets may exceed 1,200 at a
tenth of all of them, counted across AGENTS.md and every module rules file.
See [[owner-ops-refuses-to-apply-from-a-tree-behind-origin-main]].
