---
name: a-router-refresh-after-a-one-shot-action-erases-its-only-account
description: "router.refresh() after a one-shot action remounts the card and wipes the result — on 2026-10-03 a failed Turbify run's only explanation vanished before anyone read it, and on success the same line would have erased a new hire's password."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-03T20:16:57.993Z
---

A client card that fires an action and then calls `router.refresh()` can come back **remounted**, with
its own `useState` back at the initial value — so the result of the action it just performed is gone
from the screen. The card then looks exactly as if nothing had ever been clicked.

**Measured on production 2026-10-03 at 23:02:13 Cairo**, in
`src/components/new-hire-mailbox/invite-inbox-card.tsx`. A live Turbify invite-inbox adoption failed.
`if (!dryRun) router.refresh();` fired, the card remounted, and the sentence naming what had stopped
the run was lost. The audit row for the same run held `adopted: false, refusal: null` and nothing
else, so **the diagnostic existed nowhere at all** — and the action is capped at three live runs an
hour, so it could not simply be repeated.

🔴 **The worse half is the SUCCESS path.** The same line ran on a successful adoption, where the
result carries the hand-over sentence the employee has to be told — and for a new hire the company
password becomes their real password. A refresh there erases a credential that is not recoverable
from that screen.

**The rule.** Weigh what the refresh buys against what it destroys. Refreshing a queue list so it is
one click fresher is never worth erasing the only account of a one-shot, rate-limited, or
credential-bearing action. Remove the refresh and let the next navigation update the list.

**Two things that make this invisible:**

- the failure looks like the click never registered, so the next move is to click again — which on a
  rate-limited action spends the budget that would have produced the answer;
- it is not reproducible from a unit test of the component, because the remount depends on the
  server render changing underneath it.

So the symptom to recognise is **"I clicked, something clearly happened, and the screen says nothing
at all"** — look for a refresh on that path before suspecting the action.

Related: [[a-break-that-passes-may-be-rescued-not-correct]] and
[[a-source-assertion-is-satisfied-by-the-comment-explaining-the-call]] — the guard written for this
needed the braced-JSX-child form, because a bare-property pattern was satisfied by the `x.handover ?`
condition while nothing was being drawn.
