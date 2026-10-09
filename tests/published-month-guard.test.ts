import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PUBLISHED_MONTH_RULE,
  assertNoPublishedMonthWritten,
  findPublishedMonthsAtRisk,
  livePublishedPeriods,
  publishedMonthGuardMessage,
  publishedMonthRiskIsClear,
} from "../src/lib/sales/published-month-guard.ts";

// NEVER CHANGE A PUBLISHED MONTH — owner, 2026-10-09: "never cange a publkished month",
// restating 2026-09-07: "no donot fix any already published an announced month implement this to
// be considered in the upcomings".
//
// This test is the lock, and it pins BOTH halves:
//   1. the decision itself, including the hole that made the guard necessary — a repair keyed on
//      (distributor, customer) reaches months nobody asked about, so clearing the TARGET period
//      proves nothing; and
//   2. that scripts/reconcile-month-customer-map.ts actually calls it, before it writes.
//
// Half 2 matters most. Before this guard the bulk repair honoured the rule only through a
// DIFFERENT mechanism — the RPC skips files held by a closing LOCK — and nothing in the system
// pairs a lock with a publication. A published month with no lock was rewritten silently.
//
// The source assertions below read the script with its comments STRIPPED, because a comment that
// explains a call satisfies an assertion that looks for the call (docs/agents-session-traps.md).

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/reconcile-month-customer-map.ts", import.meta.url),
);

/** The script's code with comments removed, so prose can never satisfy a source assertion. */
function scriptCode(): string {
  return readFileSync(SCRIPT_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

type GuardClient = NonNullable<Parameters<typeof livePublishedPeriods>[0]>;
type PagedRead = { data: unknown; error: { message: string } | null };
// Annotated, not inferred: a self-referencing object literal has no inferable type.
type ReadChain = {
  select: () => ReadChain;
  is: () => ReadChain;
  order: () => ReadChain;
  range: () => Promise<PagedRead>;
};

/** A Supabase stand-in whose paged read returns exactly what a test hands it. */
function stubClient(result: PagedRead): GuardClient {
  const chain: ReadChain = {
    select: () => chain,
    is: () => chain,
    order: () => chain,
    range: async () => result,
  };
  return { from: () => chain } as unknown as GuardClient;
}

export async function runPublishedMonthGuardTests() {
  // ── His rule, recorded beside the code that enforces it ────────────────────
  assert.equal(PUBLISHED_MONTH_RULE.statedOn, "2026-10-09", "the rule records when he said it");
  assert.equal(PUBLISHED_MONTH_RULE.restates, "2026-09-07", "and the ruling it restates");
  assert.equal(
    PUBLISHED_MONTH_RULE.words,
    "never cange a publkished month",
    "his words are kept verbatim, typo included — paraphrasing a rule loses it",
  );

  // ── A run that touches no published month passes ───────────────────────────
  const clear = findPublishedMonthsAtRisk({
    targetPeriod: "2026-09",
    publishedPeriods: ["2026-07", "2026-08"],
    rowPeriods: ["2026-09", "2026-09", null, "", undefined],
  });
  assert.equal(clear.targetPeriod, null, "September is not published, so the target is clear");
  assert.deepEqual(clear.rowPeriods, [], "and no row sits in July or August");
  assert.ok(publishedMonthRiskIsClear(clear), "so the run is clear");
  assert.doesNotThrow(
    () =>
      assertNoPublishedMonthWritten({
        targetPeriod: "2026-09",
        publishedPeriods: ["2026-07", "2026-08"],
        rowPeriods: ["2026-09"],
      }),
    "an unpublished month is repairable — the guard is not a freeze on everything",
  );

  // ── The period asked for is published ──────────────────────────────────────
  const target = findPublishedMonthsAtRisk({
    targetPeriod: "2026-07",
    publishedPeriods: ["2026-07", "2026-08"],
    rowPeriods: [],
  });
  assert.equal(target.targetPeriod, "2026-07", "the published target is named");
  assert.equal(publishedMonthRiskIsClear(target), false, "and the run is refused");
  assert.throws(
    () =>
      assertNoPublishedMonthWritten({
        targetPeriod: "2026-08",
        publishedPeriods: ["2026-08"],
        rowPeriods: [],
      }),
    /2026-08/,
    "the refusal names the month, not just the rule",
  );

  // ── THE HOLE THE GUARD EXISTS FOR: the target is clear, the ROWS are not ───
  // The repair RPC is keyed on (distributor, customer) and ignores the period, so a run seeded
  // from an unpublished September legitimately rewrites that customer's July and August rows.
  // Checking only the target period would wave this through.
  const spill = findPublishedMonthsAtRisk({
    targetPeriod: "2026-09",
    publishedPeriods: ["2026-07", "2026-08"],
    rowPeriods: ["2026-09", "2026-07", "2026-08", "2026-08", "2026-07", "2026-07"],
  });
  assert.equal(spill.targetPeriod, null, "the target month really is unpublished");
  assert.deepEqual(
    spill.rowPeriods,
    [
      { period: "2026-07", rows: 3 },
      { period: "2026-08", rows: 2 },
    ],
    "and every published month the rows would reach is counted, oldest first",
  );
  assert.equal(
    publishedMonthRiskIsClear(spill),
    false,
    "so the run is refused even though the period asked for is open",
  );

  // ── The refusal has to be actionable ───────────────────────────────────────
  const message = publishedMonthGuardMessage(spill);
  assert.ok(message.includes("2026-07 (3 rows)"), "it gives the month and how many rows");
  assert.ok(message.includes("2026-08 (2 rows)"), "for each published month reached");
  assert.ok(
    message.includes("never cange a publkished month"),
    "it quotes the owner's own words so the reader knows whose rule it is",
  );
  assert.ok(
    /[Uu]npublish/.test(message) && message.includes("publication screen"),
    "and it names the way past it: he unpublishes the month himself",
  );
  assert.ok(
    publishedMonthGuardMessage(
      findPublishedMonthsAtRisk({
        targetPeriod: "2026-08",
        publishedPeriods: ["2026-08"],
        rowPeriods: ["2026-08"],
      }),
    ).includes("1 row)"),
    "one row is singular — a refusal that cannot count is not read",
  );

  // ── It FAILS CLOSED on an unreadable publication table ─────────────────────
  // The portal-facing readers in monthly-closing-publication.ts deliberately return [] on error.
  // A bulk write must do the opposite: an unanswered question stops the run.
  await assert.rejects(
    () => livePublishedPeriods(stubClient({ data: null, error: { message: "connection reset" } })),
    /connection reset/,
    "a failed read throws instead of reporting that nothing is published",
  );

  const read = await livePublishedPeriods(
    stubClient({
      data: [{ period: "2026-07" }, { period: "2026-08" }, { period: "2026-07" }, { period: "" }],
      error: null,
    }),
  );
  assert.deepEqual([...read].sort(), ["2026-07", "2026-08"], "a good read de-duplicates and drops blanks");

  // ── Half 2: the bulk repair really calls it, before it writes ──────────────
  const code = scriptCode();
  assert.ok(
    code.includes("import {") && code.includes("published-month-guard"),
    "the script imports the guard as code, not as a comment",
  );
  assert.ok(
    code.includes("await livePublishedPeriods(supabase)"),
    "it reads the live publications itself rather than trusting the lock check",
  );
  assert.ok(
    code.includes("rowPeriods: rows.map((row) => row.invoice_period)"),
    "and feeds it every row it would rewrite, which is the half a period check cannot see",
  );
  assert.ok(
    /if \(apply\) throw new Error\(message\)/.test(code),
    "an --apply run is refused outright",
  );
  assert.ok(
    code.includes("enforcePublishedMonthRule("),
    "through the one helper, so both call sites behave the same way",
  );

  const applyIndex = code.indexOf("sos_reconcile_import_rows_from_customer_map");
  const guardIndex = code.indexOf("rowPeriods: rows.map((row) => row.invoice_period)");
  assert.ok(applyIndex > 0, "the repair RPC call is still there to be guarded");
  assert.ok(
    guardIndex > 0 && guardIndex < applyIndex,
    "and the row-level check runs BEFORE the first write, not after it",
  );
}
