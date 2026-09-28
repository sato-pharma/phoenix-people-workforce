import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { payrollMonthLabel } from "../src/lib/automated-payroll/awaiting-publish.ts";
// The repo's own stripper, not a hand-rolled one. A line-by-line filter judges a line by how it
// STARTS, so nothing tracks whether a block comment is already open: a `//` written after code
// survives, and a multi-line block's continuation lines are scanned as code. A negative assertion
// then fails on comment text, and — far worse here — a positive one PASSES on a file that no longer
// contains the thing it pins. `tests/comment-strip-safety.test.ts` fails CI over exactly that, and
// it caught this file.
import { stripComments } from "./support/comment-strip.ts";

/**
 * Which payroll months are waiting to be published — asked across ALL months, which nothing in this
 * domain could answer before.
 *
 * WHY THE BULK OF THIS IS A SOURCE SCAN. Calling `getPayrollAwaitingPublish` needs Supabase, and
 * this suite runs with PRODUCTION credentials (`--env-file-if-exists=.env.local`). A test that
 * reached the real database to exercise an error path would be reading live payroll data to check a
 * `catch` block. The four traps below are properties of the code, and the code is what is scanned.
 *
 * Each assertion is a trap this domain has actually sprung, recorded in the files it belongs to:
 * re-assembling an old month produces today's figures for a payment decision taken weeks ago;
 * deriving publish state from `salary_batches` reads a month as published the moment
 * `finalizeApproved` runs and can strand it permanently unpublishable; and a missing table returning
 * `[]` is the under-report that the needs-you board exists to prevent, because on that board `[]`
 * renders as "nothing needs you".
 */
export function runPayrollAwaitingPublishTests() {
  const FILE = "src/lib/automated-payroll/awaiting-publish.ts";
  const source = readFileSync(FILE, "utf8");
  // Comments explain the traps by naming them, so scanning raw source would match the prose rather
  // than the code. Strip line comments and block comments before asserting on what it DOES.
  const code = stripComments(source);

  // ── 1. The read is a read, and it is the widest gate that is still correct ──
  assert.match(
    code,
    /assertAutomatedPayrollFinanceActor\(access\)/,
    `${FILE} must gate on assertAutomatedPayrollFinanceActor. It is a READ, and the finance seats ` +
      "already download the locked sheet.",
  );
  assert.doesNotMatch(
    code,
    /assertAutomatedPayrollPublisher/,
    "gating a read on the PUBLISHER gate locks the CEO and the Finance Manager out of something they " +
      "can already see, and it gates an act rather than a read.",
  );

  // ── 2. The new capability IS the absence of a month filter ─────────────────
  const queryStart = code.indexOf(`.from(RUNS)`);
  assert.ok(queryStart > 0, "the open-runs query was not found");
  const query = code.slice(queryStart, code.indexOf(";", queryStart));
  assert.match(query, /\.in\("phase", \[\.\.\.OPEN_PHASES\]\)/, "open runs are selected by phase");
  assert.doesNotMatch(
    query,
    /\.eq\("month"|\.eq\("year"/,
    "the runs query filters by month or year. Every existing reader already knows its period — " +
      "findActiveRun takes a month and a year and ends in .maybeSingle(). Asking across ALL months is " +
      "the only thing this query adds, so a period filter deletes its whole reason to exist.",
  );

  // ── 3. The two derivations that silently produce a wrong answer ────────────
  assert.doesNotMatch(
    code,
    /salary_batches/,
    "publish state is being derived from salary_batches. The batch is written BY publish, so a month " +
      "reads as published the moment finalizeApproved runs — before the run is marked — which is the " +
      "window that can strand a month permanently unpublishable.",
  );
  assert.doesNotMatch(
    code,
    /assembleForRun/,
    "assembleForRun recomputes TODAY's figures. A published month's holds were a payment decision " +
      "taken weeks ago against that day's numbers; re-assembling silently restates them.",
  );
  assert.match(
    code,
    /loadHeldBalances/,
    "outstanding holds must reuse loadHeldBalances — it already reads the published audit row, applies " +
      "newest-row-wins and refuses to re-assemble.",
  );

  // ── 4. A missing table is never "nothing is held" ──────────────────────────
  // This is the assertion that matters most. loadHeldBalances returns [] for a missing table, which
  // is right for ITS callers and exactly wrong here.
  const missingTableBranch = code.slice(code.indexOf("isMissingTableError(runError)"));
  assert.match(
    missingTableBranch.slice(0, 400),
    /throw new Error/,
    "a missing payroll runs table must THROW so the board renders the source as amber. Returning an " +
      "empty result renders it as \"no months are open\", which is the under-report this whole module " +
      "exists to prevent.",
  );
  assert.doesNotMatch(
    code,
    /isMissingTableError\([^)]*\)\s*\)?\s*\{?\s*return\s*(\[\]|\{)/,
    "a missing table is being swallowed into an empty result.",
  );

  // ── 5. The .in() is chunked ────────────────────────────────────────────────
  assert.match(
    code,
    /IN_CHUNK/,
    "a PostgREST .in() carrying several hundred ids returns zero rows and NO error — which would read " +
      "as \"no month is holding anybody\". Chunk it.",
  );

  // ── 6. An uncountable hold is null, never zero ─────────────────────────────
  assert.match(
    code,
    /Promise<Map<string, number> \| null>/,
    "countHeldDraftRows must be able to return null. A hold count of 0 and \"I could not count the " +
      "holds\" must not render as the same thing.",
  );
  assert.match(code, /heldCount:\s*heldByRun\s*\?/, "heldCount carries the null through to the caller");

  // ── 7. Names, never codes ──────────────────────────────────────────────────
  assert.equal(payrollMonthLabel(9, 2026), "September 2026");
  assert.equal(payrollMonthLabel(1, 2026), "January 2026");
  assert.equal(payrollMonthLabel(12, 2025), "December 2025");
  assert.doesNotMatch(
    payrollMonthLabel(8, 2026),
    /^\d|-/,
    "the owner reads month NAMES. `2026-08` is a period key, not a month, and this string is printed " +
      "on the board verbatim.",
  );
  // Out of range must still say something a person can read, never crash the board or print "undefined".
  assert.doesNotMatch(payrollMonthLabel(0, 2026), /undefined/);
  assert.doesNotMatch(payrollMonthLabel(13, 2026), /undefined/);

  // The outstanding-hold row carries a NAME and no hr id — structural, not a convention.
  const holdType = code.slice(code.indexOf("export type PayrollOutstandingHold"), code.indexOf("export type PayrollAwaitingPublish"));
  assert.match(holdType, /name:\s*string/);
  assert.doesNotMatch(
    holdType,
    /hrId|hr_id/,
    "PayrollOutstandingHold carries an HR id. The board prints these rows, and the owner's rule is " +
      "human-readable names never raw codes — the safest way to keep that is to have nowhere to put one.",
  );
}
