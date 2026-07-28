---
name: add-test
description: Scaffold a new tests/*.test.ts file in this repo's exact hand-rolled style and wire it into tests/run-tests.ts. Use when asked to "add a test", "write a test for X", "create a test file", or after implementing a domain change that needs coverage — this exists because a test file that isn't wired into run-tests.ts silently never executes (no error, no per-test filter flag, no auto-discovery).
argument-hint: '[domain/area being tested, e.g. "outstation email status tokens"]'
---

# Add Test

Create `tests/<kebab-name>.test.ts` and wire it into `tests/run-tests.ts`. `run-tests.ts` is the
only thing that executes any test file — an unwired file is silently never run by `pnpm run test`.

## 1. Derive names from the description

- `<kebab-name>`: lowercase words, hyphen-separated — e.g. `outstation-email-status-tokens`
- `<PascalName>`: same words, capitalized and joined — e.g. `OutstationEmailStatusTokens`
- Exported function: `run<PascalName>Tests`

This is a mechanical, non-acronym-aware capitalization (`au` → `Au`, `crm` → `Crm`, `csrf` →
`Csrf` — matches `runAuHireIntoSeatWiringTests`, `runCrmIdentityTests`, `runCsrfRouteCoverageTests`
in the current suite). One real exception: HR_ID is spelled `HrId` everywhere in this codebase
(`runHrIdAliasNormalizationTests`, `normalizeHrId`, `hrIdsMatch`) — use that spelling if the test
concerns HR_ID, not the mechanical `Hrid`.

Confirm `tests/<kebab-name>.test.ts` doesn't already exist and that no existing test already
covers this behavior before creating a new file.

## 2. Read the real target before writing assertions

Find the actual function(s) under `src/lib/<domain>/` that the description refers to and read
them — do not invent behavior or assert against an imagined API.

## 3. Create `tests/<kebab-name>.test.ts`

Every test file in this suite follows the same shape: `node:assert/strict`, one exported
`run<PascalName>Tests` function, no test framework (no describe/it/jest/vitest — this repo
hand-rolls it). Use `async function` only if the body needs to `await` something; the runner
awaits either form. Default to relative imports with an explicit `.ts` extension — that's what
CLAUDE.md documents and ~96% of test files use (e.g. `../src/lib/i18n/config.ts`). A minority
(~19 files, e.g. [tests/report-it-access.test.ts](../../../tests/report-it-access.test.ts)) import
via the `@/lib/...` alias with **no** `.ts` extension instead — both resolve correctly under
`tests/alias-loader.mjs`, so either is acceptable, but prefer the relative `.ts` form unless the
surrounding/related test files for this domain already lean on `@/`.

Real example ([tests/i18n-config.test.ts](../../../tests/i18n-config.test.ts)):

```ts
import assert from "node:assert/strict";
import { defaultIntlLocale, localeDirection, resolveLocale } from "../src/lib/i18n/config.ts";

export function runI18nConfigTests() {
  assert.equal(resolveLocale("ar"), "ar");
  assert.equal(resolveLocale(null), "en");
}
```

Assertions favor a trailing message explaining *why* the invariant holds, not what the line does
([tests/territory-root-scope.test.ts](../../../tests/territory-root-scope.test.ts)):

```ts
assert.equal(deriveOfficialLine(null), null, "null allowedLineNames fails closed to null, never 'all lines'");
```

## 4. Wire into `tests/run-tests.ts`

Two additive edits. Never touch the `runTest()` helper function or the summary block at the very
end of the file.

1. Add the import as the last line of the big import block, immediately above the
   `const testDurationsMs: { name: string; durationMs: number }[] = [];` line:

   ```ts
   import { run<PascalName>Tests } from "./<kebab-name>.test.ts";
   ```

2. Add the invocation as the last line of the `await runTest(...)` sequence, immediately above the
   `const totalMs = testDurationsMs.reduce((sum, t) => sum + t.durationMs, 0);` line:

   ```ts
   await runTest("<short human description>", run<PascalName>Tests);
   ```

   The description is free text printed by `pnpm run test` (e.g. `"birthday eligibility (on_leave
   included, terminal excluded, birth_date required)"`) — summarize the invariant being pinned,
   not the filename.

Appending at the very end matches how the most recent entries landed (e.g. the current last pair,
`sales-ims-ratio.test.ts` / `runSalesImsRatioTests`). If the new test clearly extends an existing
group instead (e.g. another `payroll-copilot-*` test), place it next to that group — but the end
is always a safe, correct default.

## 5. Report, don't run

List exactly what was created and the exact two lines added to `run-tests.ts` (with the anchor
line each was placed above), so the change can be reviewed. Do not run `pnpm run test` or commit —
the suite is large and some phases are staging-touching smoke tests; leave that decision to
whoever invoked this skill.
