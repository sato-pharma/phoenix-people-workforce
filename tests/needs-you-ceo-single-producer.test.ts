import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { adaptersFor, needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import { needsYouSourceIds, type NeedsYouSourceId } from "../src/lib/needs-you/types.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 ONE PRODUCER PER RULE. THIS FILE EXISTS BECAUSE TWO COPIES HAD ALREADY DISAGREED.
 *
 * `getCeoAdminSignals` (`src/lib/ceo/command-center.ts`) and `src/lib/needs-you/sources.ts` both
 * answered three of the same questions — contracts expiring, probation decisions due, coaching
 * red-zone reps — from the same upstream services, each with its own copy of the rule. They had
 * already drifted by the time anyone looked:
 *
 *  - The CEO's probation count filters to people still EMPLOYED (`isActiveLifecycleStatus`) and
 *    reads the window from `lifecycleRiskWindows.probationCriticalDays`. The board's adapter did
 *    neither, so it counted leavers and hard-coded 30. Two screens, one question, two answers.
 *  - The contract window was written twice with two different date helpers (`daysFromNow` there,
 *    `daysUntil` here) — the same arithmetic in two places is the same defect waiting.
 *
 * The collapse makes the ADAPTERS the single producer and has the CEO read them through
 * `adaptersFor` + `loadNeedsYouSources`. What this file pins is that it STAYS collapsed, because
 * the re-implementation is always a two-line convenience at the call site.
 *
 * 🔴 AND WHY NOT `getNeedsYouBoard` OVER THERE. That runs all sixteen sources. The CEO command
 * centre needs three, on the owner's heaviest landing page — so a future "simplification" to the
 * whole board is a thirteen-source latency regression, and assertion 5 refuses it.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. A shared rule written a second time in `command-center.ts` — the drift, returning.
 *  2. The CEO no longer reading the adapters at all (the collapse silently reverted).
 *  3. The probation rule losing the employment filter or the shared window constant again.
 *  4. The contracts tile falling back to a number from a different query when its read FAILED —
 *     the under-report rule, which this screen now obeys too.
 *  5. `getNeedsYouBoard` called from the command centre (all sixteen sources to use three).
 *  6. `adaptersFor` silently returning a SHORT list for an id with no adapter — a caller that asked
 *     for three signals and rendered two, which is the under-report arriving through this door.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => stripComments(readFileSync(path.join(repoRoot, relative), "utf8"));

const COMMAND_CENTER = "src/lib/ceo/command-center.ts";
const SOURCES = "src/lib/needs-you/sources.ts";

/** The three signals both files answered, and the item key each adapter emits for it. */
const SHARED: ReadonlyArray<{ id: NeedsYouSourceId; itemKey: string }> = [
  { id: "contract-renewals", itemKey: "contract-renewals:expiring" },
  { id: "probation-decisions", itemKey: "probation-decisions:due" },
  { id: "coaching-red-zone", itemKey: "coaching-red-zone:reps" },
];

export function runNeedsYouCeoSingleProducerTests() {
  const ceo = read(COMMAND_CENTER);
  const sources = read(SOURCES);

  // 1 — the rules are gone from the command centre, not merely unused there.
  for (const token of [
    "contract_renewal_date", // the contract window, re-derived
    "isProbationDecisionOutstanding", // the probation predicate, re-derived
    "redZoneRepCount", // the coaching figure, re-derived
    "getContractRenewalDashboardData",
    "getCoachingReports",
    "getProbationRows",
  ]) {
    assert.ok(
      !ceo.includes(token),
      `${COMMAND_CENTER} re-implements a rule ${SOURCES} already owns (${token}). ` +
        "Read it from the adapter through adaptersFor + loadNeedsYouSources instead — two copies of " +
        "the probation rule is exactly how the two screens came to give different answers.",
    );
  }

  // 2 — and it reads the adapters, naming all three.
  assert.ok(ceo.includes("loadNeedsYouSources("), `${COMMAND_CENTER} no longer calls loadNeedsYouSources.`);
  assert.ok(ceo.includes("adaptersFor("), `${COMMAND_CENTER} no longer calls adaptersFor.`);
  for (const { id, itemKey } of SHARED) {
    assert.ok(ceo.includes(`"${id}"`), `${COMMAND_CENTER} stopped asking for the "${id}" source.`);
    assert.ok(
      ceo.includes(`"${itemKey}"`),
      `${COMMAND_CENTER} stopped reading "${itemKey}". A count read by the wrong key silently ` +
        "becomes 0, which is the under-report with no failure anywhere to show it.",
    );
  }

  // 3 — the probation rule keeps both filters and the SHARED window constant.
  const probation = sources.slice(
    sources.indexOf("const probationDecisions:"),
    sources.indexOf("const coachingRedZone:"),
  );
  assert.ok(probation.length > 0, `${SOURCES}: the probation adapter could not be located.`);
  assert.ok(
    probation.includes("isActiveLifecycleStatus"),
    `${SOURCES}: the probation adapter dropped isActiveLifecycleStatus. A probationer who has LEFT ` +
      "still carries an unresolved workflow row, so without it the board bills leavers as decisions " +
      "the owner owes — production defect PD-0003.",
  );
  assert.ok(
    probation.includes("lifecycleRiskWindows.probationCriticalDays"),
    `${SOURCES}: the probation window is hard-coded again. That constant is the product's one ` +
      'definition of "due soon"; a second copy is how the two screens disagree the day it moves.',
  );
  assert.ok(
    !/days_remaining\s*<=\s*\d/.test(probation),
    `${SOURCES}: the probation adapter compares days_remaining to a literal.`,
  );

  // 4 — a FAILED contracts read must not borrow a number from platform metrics.
  assert.ok(
    !ceo.includes("lifecycleRisk.expiringContracts"),
    `${COMMAND_CENTER} fell back to platform metrics for the contracts tile. That is a figure a ` +
      "FAILURE is allowed to write, which is the precise defect this module exists to remove: the " +
      "tile must disappear and name itself in dataUnavailable instead.",
  );

  // 5 — three adapters, never the whole board.
  assert.ok(
    !ceo.includes("getNeedsYouBoard"),
    `${COMMAND_CENTER} calls getNeedsYouBoard. That runs all ${needsYouSourceIds.length} sources to ` +
      "use three of them, on the owner's heaviest landing page. Use adaptersFor.",
  );

  // 6 — adaptersFor resolves exactly what it was asked for, in order, and THROWS otherwise.
  const ids = SHARED.map((entry) => entry.id);
  const picked = adaptersFor(ids);
  assert.deepEqual(
    picked.map((adapter) => adapter.id),
    ids,
    "adaptersFor returned a different set, or a different order, from the one it was asked for.",
  );
  for (const adapter of picked) {
    assert.ok(needsYouAdapters.includes(adapter), "adaptersFor returned an adapter outside the registry.");
  }
  assert.throws(
    () => adaptersFor(["not-a-source" as NeedsYouSourceId]),
    /no adapter is registered/,
    "adaptersFor must THROW for an id with no adapter. Skipping it hands the caller a shorter list " +
      "than it asked for, and a caller that asked for three signals and got two renders two.",
  );
}
