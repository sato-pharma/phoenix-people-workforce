---
name: crm-visit-type-maps-there-are-three-not-two
description: "SUPERSEDED 2026-09-13 (#3802): the CRM visit-type AV/CP classification now lives in ONE table, src/lib/crm/visit-type-meaning.ts. The body keeps the history of the three-copy era (crm-day-maps.ts was the forgotten copy)"
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-09-15T13:37:19.148Z
---

✅ **SUPERSEDED 2026-09-13 by PR #3802 (live 07:54 Cairo, `f6bc4212`): there is now ONE table,
`src/lib/crm/visit-type-meaning.ts`.** The compliance preview reads it leniently (unknown → CP), the
attendance day map strictly (unknown → no flag). `leaverVisitTypeStatus` also reads it strictly and
still reaches nothing in `src`/`app`. Pinned by `tests/crm-visit-type-meaning.test.ts`. A new code is
classified ONCE, in that file. Everything below is the history of the three-copy era.

Every comment in this area says the visit-type AV/CP mapping lives in **two** lockstep copies. **It
lives in three.** Found 2026-08-21 while independently verifying #2253, which updated only two.

| # | File | Shape | Named in the "keep in sync" comments? |
| --- | --- | --- | --- |
| 1 | `src/lib/field-workforce-compliance/ireports360-source.ts` | `VISIT_TYPE_TO_STATUS` | yes |
| 2 | `src/lib/automated-payroll/recommend.ts` | `LEAVER_VISIT_TYPE_TO_STATUS` | yes |
| 3 | **`src/lib/attendance/crm-day-maps.ts`** | `CRM_LEAVE_VISIT_TYPES` + `CRM_CAMPAIGN_VISIT_TYPES` | **NO** |

#3 is a **set pair** rather than a Map, which is why it does not grep like the other two — searching
`"AV"` or `VISIT_TYPE_TO_STATUS` never finds it. Its own header comment *claims* it mirrors the other
two ("mirrors the CP half of VISIT_TYPE_TO_STATUS / LEAVER_VISIT_TYPE_TO_STATUS"). It does not.

**Two ways it is already out of step:**

- **`-5` and `-6` are in NEITHER set.** Under the 2026-08-21 ruling they are working days, so they
  belong in `CRM_CAMPAIGN_VISIT_TYPES` (the CP half). Being in neither means the day is classified
  as **nothing** — `crm-day-maps.ts:200` falls to `continue`, so the day lands in neither
  `fieldVisitMap` nor `leaveMap`.
- **`-15` (Health Day) is still in `CRM_LEAVE_VISIT_TYPES`**, contradicting the **2026-08-01** owner
  ruling that Health Day is working time — a ruling already honoured in maps #1 and #2. This one is
  **live**: `-15` flows every month (22 May, 33 Jun, 23 Jul, 12 Aug).

**Why it matters:** this module feeds `deductions-governance/connectors/attendance-device.ts`,
`fingerprint-report.ts` and `employee-day-report.ts`. In `digest-reconcile.ts:82-83` **both** flags
cancel a deduction:

```ts
if (input.hasCrmLeave) return { action: "skip", reason: "CRM-recorded leave." };
if (input.hasCrmFieldVisit) return { action: "skip", reason: "Real CRM field visit recorded…" };
```

So the consequences differ by code, and **neither is a live overcharge today**:

- **`-15`: no money impact.** Leave and field-visit both `skip`, so the deduction outcome is
  identical — only the *reason string* and the day-report label are wrong ("crm_leave" instead of
  "crm_field_visit"). Cosmetic, but it misrepresents a worked day in a report HR reads.
- **`-5`/`-6`: would be a real gap, but is currently latent.** Neither flag gets set, so no `skip`
  fires and the day goes to punch-timing judgement — the exact failure the module was built to stop
  ("a post-settlement audit found two employees deducted on days they'd logged a real Campaign/
  Meeting visit"). **Latent because both codes are dormant** — zero rows since 2026-04-25 / 2026-02-08
  — and `deductions_candidates` only covers 2026-07 onward, so there is **no overlap and nothing was
  ever mis-deducted.** It bites only if the codes resume or an old month is reprocessed.

**How to apply:**

- **When you change ANY visit-type classification, grep for the sets too**, not just the two Maps:
  `git grep -n 'CRM_LEAVE_VISIT_TYPES\|CRM_CAMPAIGN_VISIT_TYPES'`. Two of three copies being right is
  how this drifted.
- Note map #2 is effectively dead code — see
  [[public-holiday-and-casual-leave-are-working-days]] for which of the three actually reaches
  salary. **#1 is the money one; #3 is the deduction-cancelling one; #2 reaches nothing.**
- ✅ **ALL OF IT IS NOW ON `main` — the fix shipped across THREE PRs, and the last two were duplicates
  of each other.** #2255 merged 06:08:00Z as `35cd3ef4` (the `-15`/`-5`/`-6` half only). The
  five-undocumented-codes half was orphaned by a mid-merge push (see
  [[a-merge-mid-session-orphans-your-next-push-silently]]) and got re-cut **twice, by two sessions**:
  **#2258** (`codex/crm-day-map-undocumented-cp-codes`, merged 06:20:54Z as `a086665a`) and **#2256**
  (`codex/crm-day-map-undocumented-codes-cp`, merged 06:21:38Z as `f50d5a4a`) — **44 seconds apart,
  byte-identical trees** (`git diff` between the branches was empty). The second merge was harmless:
  `git diff a086665a f50d5a4a` is **empty**, a pure no-op commit. Final state on `main` verified by
  reading the file, not the PRs: **14 CP codes, 0 duplicates, `-4` alone in the leave set.**
- **FIXED 2026-08-21 by PR #2255** (branch `claude/infallible-blackburn-d75f0c`): `-15` moved to
  `CRM_CAMPAIGN_VISIT_TYPES`, `-5`/`-6` added to it, `-4` left as the only member of
  `CRM_LEAVE_VISIT_TYPES`. Header now names all three copies. New
  `tests/crm-day-map-visit-type-status.test.ts` pins all three against each other and is wired into
  `run-tests.ts`; break-verified four ways, each firing its own headline assertion by name. A new
  exported `crmDayVisitTypeStatus()` accessor makes the ruling testable — use it, don't re-read the
  Sets. **Merge to main still needs owner approval and ships to prod immediately.**
- ✅ **#2255 INDEPENDENTLY VERIFIED by a second session, 2026-08-21** — re-run and re-broken from
  scratch at its head `85bb2fad`, not read. Baseline green; three flips each fired that test's own
  named assertion: `-15` back into the leave set → *"Annual Vacation (-4) must be the ONLY…"*;
  `-5` out of the CP set → *"Public Holiday (-5) must classify as CP…"*; and — the important one —
  drifting **a different file** (`-6`→AV in `ireports360-source.ts`) → *"VISIT_TYPE_TO_STATUS must
  still map Casual Leave (-6) to CP — the day map is pinned to it."* **That cross-copy pin is the
  real win**: it is the only thing in the repo that makes copy #3 go red when copy #1 moves, which
  is the exact drift that caused this. The test needs no credentials.
- ⚠️ **TWO SESSIONS FIXED THIS AT THE SAME TIME.** A second session built an equivalent branch
  (`codex/crm-day-maps-visit-type-lockstep`, identical Set literals, per-day `classifyCrmDayRows`
  accessor) before discovering #2255 was already open; it was **deleted unpushed**, no duplicate PR.
  #2255 is the better one — it also fixes a stale `digest-reconcile.ts` comment and pins the three
  copies against each other. See [[two-sessions-fixed-one-bug-main-was-never-ci-validated]]. **Check
  `gh pr list --search <keyword>` before starting a fix that a memory file already describes** — the
  note itself is the signal that another session may be on it.

🔴 **The whitelist-vs-`?? "CP"` divergence — NOT in #2255. It MISSED THAT MERGE BY SECONDS** and
shipped separately (#2258 + the duplicate #2256; both merged, see above).
The note here said "ALSO FIXED in #2255" for about two minutes and that was wrong —
`35cd3ef4` (live on prod 09:09 Cairo) carries only the nine-code Set. The follow-up commit
`6cd7680f` was pushed to `claude/infallible-blackburn-d75f0c` *after* the merge read the head as
`85bb2fad`, so it never reached `main`. **Two sessions racing on one branch is how a green,
approved merge silently ships half the work** — re-read `headRefOid` at the moment of merging, and
treat a memory note written by a live parallel session as a claim to verify, not a fact.
Re-landed by cherry-pick onto post-merge `main` as **PR #2256** (`codex/crm-day-map-undocumented-codes-cp`,
commit `e9cf52a9`, byte-identical content) — the old branch is squash-merged and must never be
reused ([[reusing-a-squash-merged-branch-makes-a-conflicting-pr]]). **Owner re-confirmed the ruling
in the main session before the cherry-pick.** Break-verified four ways, incl. the cross-copy pin.

Copies #1/#2 are Maps read through `?? "CP"`, so any unlisted code still counts as working
time. Copy #3 is a strict **whitelist**: unlisted → no flag → `continue` → no cancel → judged on
punch timing alone. That left **`-7`, `-19`, `-20`, `-21`, `-30`** falling through — and unlike the
`-5`/`-6` gap (which measured 0 overlap) this one was **LIVE**: 88 agent-days across 30 employees
since 2026-07-01 whose ONLY CRM record was one of those, inside the `deductions_candidates` window.
The owner ruled "add them to the CP set too", so all five went into `CRM_CAMPAIGN_VISIT_TYPES` —
✅ **LIVE on production since 2026-08-21 06:23Z / 09:23 Cairo**, `/api/healthz` revision
`f50d5a4a`, confirmed by request, not inferred from the merge. Production has exactly **16 distinct
visit types** (verified 2026-08-21): `0`, and the 15 negatives `-1 -2 -4 -5 -6 -7 -8 -9 -11 -12 -15
-19 -20 -21 -30`. The two Sets now cover **every one** — `-4` leave, fourteen CP, `0` counted
separately — so nothing falls through the whitelist today.

**Two things to carry forward:**

- **`-7` is CP here despite being genuinely ambiguous** (`classifyAmbiguousComment` splits its
  comment text at runtime and some rows read as leave). Correct anyway: it is what copies #1/#2
  already return, and in THIS module leave and field visit are both a universal cancel in
  `reconcileDay` — they differ only in the reason string, never in money.
- **The whitelist is still a whitelist for a code that has never appeared.** A 16th code would be CP
  in copies #1/#2 and a fall-through here — deliberate, because silently cancelling a deduction for
  an unclassified code is the riskier default. **Nothing alerts on this**: `crm/unmapped-alert.ts`
  covers unmapped AGENTS, not unmapped visit types (verified in code 2026-08-21, after I nearly
  wrote the opposite into a comment). A new code must be classified by hand in all three copies.

See [[ireports360-undocumented-visit-type-codes]].
