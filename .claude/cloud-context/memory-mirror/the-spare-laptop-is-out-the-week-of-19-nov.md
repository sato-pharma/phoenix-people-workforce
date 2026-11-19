---
name: the-spare-laptop-is-out-the-week-of-19-nov
description: "Owner, 19 Nov 2026 11:27 Cairo - \"forget the spare for this week its in a issue\"; the spare laptop is out of action until about 26 Nov 2026, so nothing waits on it and nobody asks him to switch it on."
metadata:
  node_type: memory
  type: project
  originSessionId: 7f0d345d-0d9a-4ff4-b3bd-177284b2e004
  modified: 2026-11-19T09:28:03.067Z
---

On 19 Nov 2026 at about 11:27 Cairo the owner wrote: "forget the spare for this week its in a issue". The spare laptop (hostname `Gawish`, `ssh phoenix-spare`) is broken or busy with a problem of its own, not merely switched off or on a new address.

**Why:** that morning three sessions (the enterprise-audit control session, the Phoenix CRM reads session, the test-foundation session) kept telling him to switch it on for screenshots and the 375-pixel phone check. He wants that stopped for the week.

**How to apply, until about 26 Nov 2026 or until he says it is back:**
- Never ask him to switch the spare on, and never put "the spare is back" words in a Next step line or button.
- Never queue work on it (`spare-test.ps1`, `on-spare.ps1`, `spare.ps1`): `localhost:3000` will not answer. The PR's own CI (GitHub-hosted) is the verdict, as always.
- Work that truly needs a signed-in browser by role (the phone check, the panel screenshots) is parked until he says the spare is back. A local dev server here is allowed only at 3 GB or more of free RAM ([[the-spare-laptop-changes-address-it-is-not-off]] covers the address finder, which does not apply while it is out).
