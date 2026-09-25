---
name: an-exhaustive-record-does-not-gate-the-build-here
description: "next.config sets ignoreBuildErrors true, so a Record missing a key ships to production — exhaustiveness is NOT a guard in this repo."
metadata:
  type: reference
---

`next.config` carries `typescript: { ignoreBuildErrors: true }`. A `Record<SomeUnion, X>` that is
missing a key is a **compile error that never blocks a build and never blocks a deploy.** Only the
PR's `typecheck` job sees it — and `strict: false` on branch protection means a PR can merge on a
check taken before the union grew.

**That combination shipped a live defect on 2026-08-24.** #2395 added a ninth candidate role family
(`sales`); #2396 had added `bandByFamily`, a `Record<CandidateRoleFamily, ScreeningBand>`, an hour
earlier. They merged 4 minutes apart, neither CI run saw the other, and the result reached
production:

```
screeningBandForFamily("sales") -> undefined
screeningSortKey(...)           -> [NaN, 0, ...]
countByBand(...)                -> every real band 0, plus an "undefined" key
```

**A NaN comparator does not throw.** `Array.sort` with a NaN result silently scatters those rows —
63 real candidates landed at random positions in the screening queue and the header counted zero in
every band. `main` was red for 15 minutes and production served the bug the whole time. Fixed by
#2404.

**So do not rely on exhaustiveness for anything that matters.** Back a `Record` over a union with a
RUNTIME assertion in a registered test — iterate the union and assert the looked-up value is real:

```ts
for (const family of candidateRoleFamilies) {
  const key = screeningSortKey(row("x", { family }));
  assert.ok(Number.isFinite(key[0]), `${family} is unmapped`);
}
```

Also assert the counter did not grow a key outside the union — that is what exposed it here.

Related: [[a-green-test-run-carries-no-type-signal-at-all]] ·
[[two-sessions-fixed-one-bug-main-was-never-ci-validated]]
