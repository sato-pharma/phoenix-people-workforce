---
name: a-break-that-passes-may-be-rescued-not-correct
description: "Break-the-fix proved nothing SIX ways: a case that cannot fail, a break caught by an EARLIER assertion, a substituted value that was not a defect, a case RESCUED BY A FIXTURE DEFAULT so it never built the input it claimed (`??` cannot express absence — use `in`), and an UNREACHABLE assertion whose readFileSync threw before assert.ok ran. and a cheap PRECONDITION asserted after the code that consumes it, where the consumer (ExcelJS, not another case) reaches the broken input first and reports the symptom. Demand the break fire the SPECIFIC message; a break that fires another case's message, or neither a pass nor a failure, is itself the diagnosis — and a WRONG-REASON can mean the assertion is in the wrong PLACE in the suite, not misaimed. TWO MORE live in the HARNESS, not the test: a harness that re-imports measures its own ESM module cache, so every later break fires the FIRST break's message and the restore looks failed against a file that is correct on disk — one CHILD PROCESS per break; and a SHORT break anchor patches a sibling line, since String.replace takes the first match, which scores NOT CAUGHT against an assertion that was right all along."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-04T05:40:00.000Z
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

**Shape 3 — the "break" was not a defect at all, so the test was right and the EDIT was wrong.**
Measured 2026-10-04 wiring the Turbify invitation reader. A date comparator mapped a missing header to
`-Infinity` so an undated message sorts last; the break substituted `0`, the suite stayed GREEN, and
that reads exactly like an unpinned guard. It is not: `0` is 1970, which is older than every real
date, so the substitution changes no behaviour. The real hazard was the third value — unguarded
`NaN`, where every comparison is false, the comparator is inconsistent and the sort may leave the
array as the server gave it. 🔴 **So a `NOT CAUGHT` is a claim about the BREAK as much as about the
test: ask "is the value I substituted actually a defect?" before touching the assertion.** The fix
here was to re-break with `NaN` (it fired) and to correct the module's own comment, which had claimed
`0` and `NaN` were equally dangerous — a wrong explanation that the green break had just disproved.

**Shape 4 — the FIXTURE DEFAULT rescued the case, so it never built the input it claimed.** Measured
2026-10-04 grading Dependabot alerts by audit reachability. Four fail-closed cases asserted that an
absent field must NOT downgrade an alert; two of them passed a field as `undefined` into a helper
written `over.manifest ?? "package.json"`. `??` cannot distinguish "absent" from "not supplied", so
both cases silently built the DEFAULT — the audited manifest — and were testing the opposite of their
own label. Breaking the fix fired the *fourth* case's message, not the third's, which is the tell: a
loop whose cases are supposed to be independent fired out of order. 🔴 **A fixture that defaults with
`??` can never express absence — use `"key" in over ? over.key : <default>`** — and when a break fires
a DIFFERENT case's message than the one you expected, suspect the earlier cases before congratulating
the harness.

**Shape 5 — the assertion was UNREACHABLE, so its message could never print.** Same session.
`assert.ok(readFileSync(path, "utf8").length > 0, "the record must exist")` reads as a file-exists
check and is not one: deleting the file makes `readFileSync` throw ENOENT *before* `assert.ok` is ever
evaluated, so the suite dies with a stack trace and the written message is dead code. The break
printed neither `PASS` nor an `AssertionError` — **an outcome that is neither is itself the
diagnosis.** Use `existsSync` for existence, and treat any assertion whose argument can throw as
unproven until a break has printed its own words.

**Shape 6 — the assertion was in the wrong PLACE in the suite, so the code under test reached the
broken input before it did.** Measured 2026-10-04 pinning that a Phoenix CRM report's title is a
legal Excel worksheet tab name (31 characters, none of `: \ / ? * [ ]`) — a rule that only became
load-bearing when the workbook started reading the screen's own `SECTION_TITLES`. The loop sat in
the suite's last section, behind six sections that build real workbooks, so the two breaks landed in
**ExcelJS**: an over-long name reported "… is really in the built workbook", which names the symptom
and not the cause, and a forbidden character threw with **no message at all**. Neither is shape 2 —
no earlier *assertion* is the real pin, and narrowing the break cannot help, because the thing that
fires first is the production code. 🔴 **The fix is to MOVE the assertion, not re-aim the break: a
cheap check on an INPUT belongs before anything that consumes it**, as the suite's own section 0.
Both breaks then fired on their own words. The tell is a failure message about the artifact when the
break was about the input.

**How to run a break harness so it cannot flatter you:**

1. Match the expected FAILURE MESSAGE, never just a non-zero exit. `FAILED-WRONG-REASON` and
   `NOT CAUGHT` are different diagnoses and must print differently.
2. `NOT CAUGHT` means one of two things: a second guard is covering the first (find it, and pick
   inputs that disable the cover), or the substituted value is not a defect (shape 3 — re-break with
   one that is).
3. `FAILED-WRONG-REASON` means an earlier case is more sensitive — **or merely that a shared helper
   threw first with its own message, which is the right assertion under a different wording.** Read
   the message before concluding the test is misaimed; one of these in 16 was only the harness's
   `expect` regex being wrong.
4. A break that fires ANOTHER case's message, or that prints neither a pass nor an assertion
   failure, is shape 4 or shape 5 — the case was rescued by a fixture default, or the assertion is
   unreachable because its own argument throws first.
5. Restore from a COPY taken before the first break, never `git checkout --`, which would discard the
   uncommitted fix along with the break. See [[verify-the-emitted-artifact-never-the-source]].

🔴 **TWO MORE SHAPES, AND BOTH LIVE IN THE HARNESS RATHER THAN IN THE TEST.** Measured 2026-10-04
pinning the measured App Passwords wording (4 breaks across `src/lib/turbify/locators.ts` and
`resolve.ts`). Both produced a verdict table that was entirely wrong while looking orderly:

- **A harness that re-imports is measuring its own ESM module cache.** The first version ran all
  four breaks in one process and cache-busted the TEST module's url with `?v=`, which does nothing
  for its transitive imports. `locators.ts` stayed loaded from break A, so breaks B, C and D all
  fired on A's message — scored `WRONG REASON` — and the final restore check "failed" against a
  file that was byte-correct on disk. **One child process per break.** The tell is every later
  break reporting the FIRST break's message, and a restore that fails while `git status` is clean.
- **A short break anchor patches a SIBLING line.** `String.replace` takes the first match, and
  `.trim() === value;` appeared on the `aria`, `name` and `placeholder` cases three lines above the
  `text` case the assertion reads. So the break edited a sibling, the real line was untouched, and
  it scored `NOT CAUGHT` against an assertion that was correct all along. Anchor on something
  unique to the line (`" ").trim() === value;`), and read a `NOT CAUGHT` as possibly the
  harness's aim rather than the test's weakness — **confirm the anchor appears exactly once first.**

Write the rebuilt breaks into the account doc rather than quietly fixing them: "the test passed after
I broke it" is the exact shape that ships a defect.
