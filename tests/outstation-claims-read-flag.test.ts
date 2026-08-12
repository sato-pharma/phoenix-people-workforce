import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { expenseClaimsReadEnabled } from "../src/lib/outstation/claims-read-flag.ts";

/**
 * The phase-2 read switch must cost NOTHING when it is off.
 *
 * THE INCIDENT (2026-08-12). `/api/admin/outstation/expenses` returned 500 in production for
 * roughly two and a half hours, and the hourly synthetic smoke caught it. The read switch shipped
 * with the flag checked AFTER the dynamic import:
 *
 *     const { expenseClaimsReadEnabled, listExpenseClaims } = await import(".../claims-read");
 *     if (expenseClaimsReadEnabled()) { ... }
 *
 * so every call with no reportId loaded `claims-read.ts` whether the flag was on or off. "Default
 * is false, so merging changes nothing" was true of the RESULT and false of the WORK — the
 * default-off path still did something new on every request, and it was the only new runtime work
 * on that path.
 *
 * The rule this pins: ask the cheap question first. A flag that is off must not be able to reach
 * the module it guards.
 */
export async function runOutstationClaimsReadFlagTests() {
  // ── The flag itself ────────────────────────────────────────────────────────
  const original = process.env.PHOENIX_EXPENSE_CLAIMS_READ;
  try {
    delete process.env.PHOENIX_EXPENSE_CLAIMS_READ;
    assert.equal(expenseClaimsReadEnabled(), false, "unset means off — phase 2 is an observation window");

    for (const off of ["", "false", "0", "yes", "TRUE ", " true"]) {
      process.env.PHOENIX_EXPENSE_CLAIMS_READ = off;
      const expected = off.trim().toLowerCase() === "true";
      assert.equal(
        expenseClaimsReadEnabled(),
        expected,
        `"${off}" must read as ${expected} — only an exact "true" (whitespace aside) turns this on`,
      );
    }

    process.env.PHOENIX_EXPENSE_CLAIMS_READ = "true";
    assert.equal(expenseClaimsReadEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.PHOENIX_EXPENSE_CLAIMS_READ;
    else process.env.PHOENIX_EXPENSE_CLAIMS_READ = original;
  }

  // ── The flag module must import NOTHING ────────────────────────────────────
  //
  // This is the property that makes the ordering possible at all: expenses.ts can ask the question
  // without loading claims-read.ts, which imports back from expenses.ts.
  const flagModule = readFileSync(new URL("../src/lib/outstation/claims-read-flag.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    flagModule.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n"),
    /\bimport\b/,
    "claims-read-flag.ts must import nothing — the moment it imports, it can be dragged into the cycle it exists to avoid",
  );

  // ── The guard order in expenses.ts ─────────────────────────────────────────
  const expenses = readFileSync(new URL("../src/lib/outstation/expenses.ts", import.meta.url), "utf8");
  const code = expenses
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  assert.match(
    code,
    /if \(!reportId && expenseClaimsReadEnabled\(\)\) \{\s*const \{ listExpenseClaims \} = await import\(/,
    "the flag must be tested BEFORE claims-read is imported — that ordering is the whole defect",
  );

  // And the import must not appear anywhere the flag has not already gated it.
  const dynamicImports = [...code.matchAll(/await import\(\s*"@\/lib\/outstation\/claims-read"/g)];
  assert.equal(
    dynamicImports.length,
    1,
    "exactly one dynamic import of claims-read, so there is one place for this ordering to be wrong",
  );

  // The flag helper must come from the leaf module, never from claims-read, or importing it would
  // pull in the very module the flag is supposed to keep out.
  assert.match(
    code,
    /import \{ expenseClaimsReadEnabled \} from "@\/lib\/outstation\/claims-read-flag"/,
    "expenses.ts must read the flag from the leaf module",
  );
  assert.doesNotMatch(
    code,
    /import \{[^}]*expenseClaimsReadEnabled[^}]*\} from "@\/lib\/outstation\/claims-read"/,
    "importing the flag from claims-read would defeat the point entirely",
  );

  console.log("  outstation claims-read flag: off by default, leaf module imports nothing");
  console.log("  outstation claims-read flag: flag gates the import, not the other way round");
}
