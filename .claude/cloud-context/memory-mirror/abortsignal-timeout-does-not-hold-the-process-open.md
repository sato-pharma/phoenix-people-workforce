---
name: abortsignal-timeout-does-not-hold-the-process-open
description: "Awaiting only the abort of AbortSignal.timeout(n) in a test or script can exit Node with code 13 and no message, because that timer is unref'd and the loop empties."
metadata:
  node_type: memory
  type: project
  originSessionId: baf64ed3-74c5-4de1-abb3-05d11464e6f6
  modified: 2026-11-02T10:22:50.179Z
---

`AbortSignal.timeout(n)` runs on an unref'd timer. A top-level `await` on nothing but its `abort` event can leave the event loop empty, and Node then exits 13 ("unsettled top-level await") with empty stdout and no assertion. Seen 2 Nov 2026 in `tests/direct-orders-sheet-webhook.test.ts`: the run passed once by luck, then 5 of 6 break runs and the clean run exited 13 while "nothing fired", which reads as a test that catches nothing.

**Why:** the failure looks like a broken regression test, not a timer, and it is intermittent, so one green run proves nothing about it.

**How to apply:** hold the loop with your own ref'd `setInterval` until `signal.aborted`, then read `signal.reason`. An exit code of 13 from a test runner means an await never settled, not that an assertion passed or failed. Repeat a new async test a few times before trusting it.
