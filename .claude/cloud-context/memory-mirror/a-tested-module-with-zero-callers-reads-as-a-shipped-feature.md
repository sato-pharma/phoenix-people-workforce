---
name: a-tested-module-with-zero-callers-reads-as-a-shipped-feature
description: "A module that is written, documented, tested and MERGED but invoked from nowhere looks exactly like a working feature in every status report — grep for callers of the entry points before calling a flow done, because a test suite proves the function, never the wiring."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-03T21:07:26.390Z
---

A module can be written, carefully documented, unit-tested against a real captured fixture, reviewed
and **merged to production** while being invoked from nowhere at all. Every signal a session reads
says the feature works: the file exists, the suite is green, a required check passed, the PR shipped.
Nothing in any of that asks whether anything calls it.

**Measured 2026-10-03/04.** `src/lib/new-hire-mailbox/robot/invitation.ts` — `readInvitation`,
`readTempPassword`, `pickInvitation` — read Turbify's activation email correctly: matched by identity,
refused a changed label, refused a near-miss address, never quoted the credential, all tested against
the real message. It had **zero callers** in `src/` or `app/`. So the invite inbox was readable and
nothing read it, and every mailbox the robot created still ended as a PENDING row with its password
sitting unread in a mailbox Phoenix owns and monitors. The flow had been described as "the invitation
carries the password, and that is the whole provisioning flow" in its own account doc for a day.

🔴 **A UNIT SUITE CANNOT CATCH THIS, BY CONSTRUCTION.** The suite imports the module directly, so it
is itself a caller — a thorough test suite is exactly what makes a dead module look alive.

**The check, before reporting any flow as working:**

```bash
git grep -n "entryPointName" -- src app | grep -v "/the-module-itself.ts"
```

Nothing but the definition and the test means the wiring is missing, whatever the suite says. Run it
against each exported entry point, not against the module name — a module can be imported for one
helper while its real entry point is dead.

Two things make it hard to notice: the account doc describes the DESIGN in the present tense, which
reads as a description of running code; and a module with no callers can never regress, so it stays
green for ever while the feature it was written for silently does nothing.

Related: [[verify-the-emitted-artifact-never-the-source]] is the same error one level down — green
source is not a working artifact; here green tests are not a wired feature. And
[[a-source-assertion-is-satisfied-by-the-comment-explaining-the-call]] is its sibling: the comment
proving the call, the suite proving the function, neither proving the behaviour.
