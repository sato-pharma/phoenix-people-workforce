---
name: a-licence-verdict-is-permanent-and-has-no-correction-path
description: "The pharmacy licence-vs-sign verdict now shows forever on the Customer Database register, but nobody can change it once the request is decided — the write gate needs a step that stops existing."
metadata: 
  node_type: memory
  type: project
  originSessionId: 552d0894-e597-451a-b26a-062cfcca1d2f
  modified: 2026-08-28T09:28:00.844Z
---

Since #2426 (merged 2026-08-26, prod revision `0730e3ee`) the licence-vs-sign verdict is rendered
permanently on the marketing **Customer Database** register — Super Admin and SFE only — as
`Confirmed to match` / `Does NOT match` / `Not checked yet`. Before that it existed only inside the
approval request that recorded it, so it vanished from view the moment the request was decided.

**There is no way to correct a wrong verdict.** The write gate requires the caller to hold the
request's *current* approval step, and once the request is decided that step stops existing — so the
field is effectively write-once, at approval time, by whoever happened to hold that step. A Super
Admin cannot fix it afterwards. It is now displayed indefinitely on a register.

Live at the time of writing: **325 pharmacies, 0 with a verdict** — the whole register reads
`Not checked yet`, which is the honest answer and not a bug. That is also why the mapper coerces
with `== null` rather than `Boolean()`: a `Boolean()` there would have printed `Does NOT match`
against all 325 and accused every pharmacy in the company of a licence mismatch.

**Re-measured 2026-08-28 in production (`ozucdzovmcqvepbozvqf`): 326 pharmacies, still 0 verdicts,
`license_name_checked_at` set on 0 of them.** The separate direct-order desk
(`direct_order_pharmacy_validations`) holds 6 rows, also 0 verdicts, with **1 licence uploaded** —
so the first verdict in the company is close but has not been recorded anywhere yet. These counts
live here rather than in `MEMORY.md` on purpose: `AGENTS.md` §2.2 names this very hook as its
example of a tally that rots ("325 pharmacies" is now 326), and a hook whose content is a number is
one that will one day be wrong. The durable half — the verdict is write-once at approval and has no
correction path, so **ask the owner before the first one is recorded** — is what the index carries.

**Why:** the owner has not been asked whether a post-decision correction path should exist. It is a
product decision with a data-correctness consequence, not a bug to fix quietly — adding a
Super-Admin override widens who can write a compliance verdict, and that is his call. It is
documented in the #2426 PR body, which nothing loads into context.

**How to apply:** before anyone records the first real verdict, put the question to him — should a
Super Admin be able to correct a decided verdict? If yes, it needs its own gate and an audit row,
not a relaxation of the existing step check. Until then, treat a recorded verdict as permanent and
never backfill one from an assumption. Related: [[marketing-venue-evidence-was-writable-only-at-insert]],
[[optional-field-written-unconditionally-is-a-silent-erase]],
[[marketing-system-validated-means-no-human-looked]],
[[the-screen-that-shows-a-badge-is-not-the-screen-a-rep-can-open]].
