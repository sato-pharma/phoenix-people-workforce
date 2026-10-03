---
name: a-break-that-passes-may-be-rescued-not-correct
description: "Break-the-fix proved nothing twice in one session: a case that cannot fail (an unrelated heuristic rescued it) and a break caught by an EARLIER assertion. Demand that the break fire the SPECIFIC message, and when it cannot, say so and pin the thing that actually protects the behaviour."
metadata:
  node_type: memory
  type: feedback
---

The standing rule is "a regression test counts only if you break the fix and watch the NEW assertion
fire." Measured 2026-10-03, that rule is not self-enforcing — two of nine breaks reported a result
that would have passed for success if the harness had only asked "did the suite go red?".

**Shape 1 — the case that cannot fail.** A new test fed a one-time-password reader a dialog
containing Turbify's login URL and asserted it still returned the password. Deleting the URL
exclusion changed nothing: a *separate* letters-and-digits preference still picked the password,
because the test's password happened to carry a digit and the URL did not. The assertion was real,
the scenario was real, and the case was incapable of failing. Fixed by making the password
digit-free, so the exclusion is the only thing left doing the work.

**Shape 2 — caught, but by an earlier assertion.** Re-enforcing an ambiguous password rule reddened
the suite at the happy path's call-order check, three cases before the assertion written for it,
because every case in that file runs on a password that contains a repeated character. Narrowing the
break did not help: the happy path is genuinely the thing that pins the behaviour. So the honest
answer was to assert THAT outright — the suite's own fixture must keep a repeated character — rather
than contort the break until the intended line fired.

**How to run a break harness so it cannot flatter you:**

1. Match the expected FAILURE MESSAGE, never just a non-zero exit. `FAILED-WRONG-REASON` and
   `NOT CAUGHT` are different diagnoses and must print differently.
2. `NOT CAUGHT` means a second guard is covering the first. Find it, and pick inputs that disable
   the cover.
3. `FAILED-WRONG-REASON` means an earlier case is more sensitive. Either narrow the break, or accept
   that the earlier case IS the pin and assert its precondition explicitly.
4. Restore from a COPY taken before the first break, never `git checkout --`, which would discard the
   uncommitted fix along with the break. See [[verify-the-emitted-artifact-never-the-source]].

Write the rebuilt breaks into the account doc rather than quietly fixing them: "the test passed after
I broke it" is the exact shape that ships a defect.
