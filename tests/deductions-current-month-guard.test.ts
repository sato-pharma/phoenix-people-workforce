import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { collectOneConnectorForMonth, isCollectableMonth } from "../src/lib/deductions/collect.ts";

/**
 * Collecting a month that has not finished charged real people three times in a
 * single day (2026-08-03): 72 candidates for 1-3 August at 39,225.73 EGP, 69 of
 * them CRM — which publishes with no approval step — plus 28 more from two
 * earlier accidental runs. Every one was withdrawn, but only because somebody
 * noticed. This is the guard that makes it impossible.
 */
export async function runDeductionsCurrentMonthGuardTests(): Promise<void> {
  const now = new Date();
  // The guard reads Cairo, so derive the expectation the same way rather than
  // from the machine's local clock.
  const cairo = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  const [thisYear, thisMonth] = cairo as [number, number];

  // ── The current month is never collectable ───────────────────────────────
  {
    assert.equal(
      isCollectableMonth({ month: thisMonth, year: thisYear }),
      false,
      "the CURRENT Cairo month must never be collectable — its days have not finished",
    );
  }

  // ── Neither is any future month ──────────────────────────────────────────
  {
    const next = thisMonth === 12 ? { month: 1, year: thisYear + 1 } : { month: thisMonth + 1, year: thisYear };
    assert.equal(isCollectableMonth(next), false, "a future month has nothing to detect and must be refused");
    assert.equal(
      isCollectableMonth({ month: thisMonth, year: thisYear + 1 }),
      false,
      "a future YEAR must be refused even when the month number is smaller",
    );
  }

  // ── A completed month still collects ─────────────────────────────────────
  // The guard must not break the normal case; every real collection targets a
  // month that has ended.
  {
    const prior = thisMonth === 1 ? { month: 12, year: thisYear - 1 } : { month: thisMonth - 1, year: thisYear };
    assert.equal(isCollectableMonth(prior), true, "last month must remain collectable");
    assert.equal(
      isCollectableMonth({ month: 12, year: thisYear - 1 }),
      true,
      "a month in a prior year must remain collectable",
    );
  }

  // ── The entry point REFUSES, loudly, before touching source data ─────────
  // Every connector goes through collectOneConnectorForMonth, including the
  // admin UI's per-connector stepping, so one check covers all of them.
  {
    await assert.rejects(
      () => collectOneConnectorForMonth({ connector: "crm", month: thisMonth, year: thisYear, createdBy: "test" }),
      /has not finished/,
      "collecting the current month must THROW — returning created:0 reads as 'nobody qualified' and hides the refusal",
    );
  }

  // ── Wired at the entry point, and Cairo-based ────────────────────────────
  {
    const source = readFileSync("src/lib/deductions/collect.ts", "utf8");
    assert.match(
      source,
      /currentCairoDateParts/,
      "the boundary must be CAIRO — in the first hours of a Cairo month a UTC clock still reads the previous month, waving through the exact window this guards",
    );
    assert.match(
      source,
      /if \(!isCollectableMonth\(input\)\)/,
      "the check must sit in collectOneConnectorForMonth, the single door every connector passes through",
    );
  }

  // ── The ADMIN UI must not offer a run the server will refuse ─────────────
  // The server guard was correct and still produced a scary, misleading screen: the month selector
  // is seeded to the CURRENT Cairo month on purpose, so for the whole of an unfinished month the
  // Run button fired one request per connector, all six were refused, and the summary rendered
  // "6 connector(s) failed" in red. A working safety guard presented as six failures is what gets a
  // guard "fixed" at 4am. The button must be disabled and the reason stated in plain words instead.
  {
    const workspace = readFileSync("src/components/admin/deductions-workspace.tsx", "utf8");
    const page = () => readFileSync("app/(admin)/admin/deductions/page.tsx", "utf8");

    assert.match(
      workspace,
      /const monthHasFinished = monthKey < currentCairoMonthKey;/,
      "the workspace must derive whether the selected month has finished, from a boundary passed by the server page",
    );
    // From October 2026 the control runs one of two cycles (cycle.ts). The gate is the selected
    // cycle's own window: the Head Office window (22nd → 21st) ends on the 21st, the calendar month on
    // its last day — and for the calendar cycle it is still exactly `monthHasFinished`.
    assert.match(
      workspace,
      /const windowHasFinished = officeWindow \? isCycleWindowCollectable\(officeWindow, currentCairoDateIso\) : monthHasFinished;/,
      "the gate must be the SELECTED cycle's window — the Head Office window by Cairo date, the calendar month exactly as before",
    );
    assert.match(
      workspace,
      /disabled=\{collecting \|\| !windowHasFinished\}/,
      "the Run collection button must be DISABLED for a window that has not finished — otherwise it fires six requests the server refuses and reports them as failures",
    );
    assert.match(
      workspace,
      /if \(!windowHasFinished\) return;/,
      "runCollection must also refuse directly, so a stray call cannot fan out into six refusals",
    );
    assert.match(
      workspace,
      /and has not\s+finished — it can be collected from the day after/,
      "the page must SAY why the button is disabled for an unfinished Head Office window, too",
    );
    assert.match(
      page(),
      /currentCairoDateIso=\{currentCairoDateIso\}/,
      "the server page must pass today's Cairo DATE — the Head Office window ends mid-month, so a month key cannot gate it",
    );
    assert.match(
      workspace,
      /has not finished — collection runs once the month is over/,
      "the page must SAY why the button is disabled; a silently dead button reads as a broken page",
    );

    // The client compares strings rather than importing the collector module. That module reaches
    // the database, so importing it here would drag server-only code into the browser bundle.
    assert.ok(
      !/from "@\/lib\/deductions\/collect/.test(workspace),
      "the client workspace must NOT import the server-side collector module — compare the month keys as strings instead",
    );

    assert.match(
      page(),
      /currentCairoMonthKey=\{initialMonthKey\}/,
      "the server page must pass the Cairo month boundary to the workspace — the client has no trustworthy clock for this",
    );
  }
}
