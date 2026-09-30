---
name: a-field-that-does-not-exist-is-a-silently-dead-branch
description: "Reading a property the type does not have is `undefined` at runtime, not an error - so `if (obj.wrongName && ...)` is a dead branch that logs nothing and looks exactly like \"there is no data\""
metadata:
  node_type: memory
  type: feedback
  originSessionId: c4c4b0e5-a5a1-4db6-ad2f-a8cb9d275542
  modified: 2026-09-30T10:07:44.029Z
---

`if (seat.repHrId && …)` — where `OrgSeat` has `occupantHrId` and no `repHrId` — is **never true**. It
does not throw. It logs nothing. The whole block inside it silently never runs, and the screen looks
exactly like a correct query that found nothing.

Cost half an hour on 2026-09-30 staring at a Phoenix CRM List that showed no shared doctors and no
check-in pins, re-querying the database to find out whether the data existed. It did.

**Why no single signal caught it — three independent blindnesses at once:**

1. A nonexistent property reads `undefined` rather than throwing.
2. A second guard (`!isTest`) excluded the only accounts the feature would ever be tried on — a
   `TEST-` login always reads as the test world (`territoryForRead` sets `isTest: true` for every
   `viewer.isTestPersona`).
3. The local unit suite was green and says nothing about types: `--experimental-strip-types` **erases**
   types, it does not check them. 1,900 passing tests, zero signal.

**How to apply:** when a block "does nothing" and the empty result is plausible, suspect the
*condition* before the data. Prove the branch runs (a log line, or read the field first-hand against
its type) before believing the query. And get a typecheck onto it — the PR's `checks` job or
`node scripts/remote-check.mjs typecheck`, never locally ([[never-run-a-local-typecheck-it-does-not-fit]]).
This is exactly why bash-guard C8 denies a local typecheck and sends you to CI instead of letting a
reaped run look like a typo.

Related: [[verify-the-emitted-artifact-never-the-source]] — the same family of error, where the thing
you are reading is not the thing that runs.
