---
name: marketing-unverified-code-override-has-a-ui-2026-08-18
description: "PR #2185 (live prod 2026-08-18, 23265ca2) gave the marketing capture gate's written-reason override an actual portal input — before it, the API's documented escape hatch was unreachable from every screen; do not undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 93e5b1f8-1092-41f5-be57-ce7bb47c2bed
  modified: 2026-08-18T12:16:49.025Z
---

**LIVE on prod 2026-08-18 — merge `23265ca2`, PR #2185, verified serving via `/api/healthz`. Do
not undo.**

The submission capture gate refuses a pharmacy code whose `reference_status` is `not_found` and
tells the rep to *"record why it must be used as-is"*. From the day it shipped until this PR,
**no screen ever sent `unverifiedCodeReason`** — `marketing-request-drafts.tsx` posted
`{ distributorCodeId }` alone. The override existed only in `service.ts`, so the gate was a hard
block wearing a soft block's error message, and a rep with a real shop and a real code had no way
through at all.

Now: a reason box opens under any **ticked** pharmacy whose code is `not_found`, Save stays
disabled until the text clears the minimum, and it is sent per pharmacy. Unticking the pharmacy
hides the box — dropping it is the other valid answer.

**`UNVERIFIED_CODE_REASON_MIN_LENGTH` now lives in `src/lib/marketing-requests/types.ts`**, not in
`service.ts`. That module imports nothing, so the client can import it safely. **Never re-declare
it on either side** — two copies drift, and the drift is invisible until a rep types nine
characters, sees an enabled Save, and is refused by the API anyway.
`tests/marketing-submission-capture-gates.test.ts` pins both halves and the single definition.

**Scope that must not widen:** only `not_found` demands a reason. `ambiguous` and `pending` still
attribute and were deliberately left un-gated — asking for a justification on those would be
theatre and would block every newly-added pharmacy code.

**How this surfaced:** POS code `1501992`, entered 2026-08-18 by B-94 for a Badrshein pharmacy. It
is genuinely absent from our POS list (`0001501990` and `0001501996` are both present), so the
refusal was right — see [[pos-pharmacy-codes-are-zero-padded]] for why a `not_found` today is a
real gap and not padding drift, and [[marketing-reference-list-is-a-point-in-time-import]] for why
the list itself goes stale.
