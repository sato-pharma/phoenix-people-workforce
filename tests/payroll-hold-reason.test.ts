import assert from "node:assert/strict";

import {
  assertHoldReasonsPresent,
  formatCarriedForwardReason,
  HELD_NO_REASON_COMMENT,
  isCarriedForwardReason,
  normalizeHoldReason,
  previousPeriod,
  resolveHoldReason,
  stripCarriedForwardPrefix,
} from "../src/lib/automated-payroll/hold-reason.ts";
import type { PriorHold } from "../src/lib/automated-payroll/types.ts";

/**
 * The hold reason is the only durable record of why somebody was not paid:
 * `publishToPayslips` filters `!onHold`, so a held row writes no salary_record
 * and no payslip, and nothing else in the system records the out-of-system
 * payment. On 2026-09-05 the OPEN August run carried 13 held rows and 13 blank
 * reasons, while July's were dated, attributed and — for B-112 — a complete
 * arithmetic working showing that paying full net would double-pay part one.
 *
 * These pin the two rules that close that gap: a hold cannot be SAVED without a
 * reason, and a reason inherited from last month says so in its own text.
 */

function priorHold(reason: string | null, month = 7, year = 2026): PriorHold {
  return { hrId: "B-156", reason, month, year };
}

export function runPayrollHoldReasonTests() {
  // ---- normalizeHoldReason: blank and whitespace are one case -------------
  assert.equal(normalizeHoldReason(null), null);
  assert.equal(normalizeHoldReason(undefined), null);
  assert.equal(
    normalizeHoldReason("   "),
    null,
    "whitespace is not a reason — a space bar would otherwise satisfy the requirement",
  );
  assert.equal(normalizeHoldReason("  settled 2026-08-30  "), "settled 2026-08-30");

  // ---- assertHoldReasonsPresent: the write-boundary rule ------------------
  assert.throws(
    () => assertHoldReasonsPresent([{ hrId: "B-144", onHold: true, reason: null }]),
    /Validation:/,
    "a held row with no reason is refused, and with the prefix jsonError maps to HTTP 400",
  );
  assert.throws(
    () => assertHoldReasonsPresent([{ hrId: "B-144", onHold: true, reason: "   " }]),
    /Validation:/,
    "a whitespace-only reason is refused too, or the rule is one keystroke wide",
  );

  assert.doesNotThrow(
    () => assertHoldReasonsPresent([{ hrId: "B-144", onHold: true, reason: "Paid by cheque, owner ruling" }]),
    "a held row WITH a reason saves normally",
  );
  assert.doesNotThrow(
    () => assertHoldReasonsPresent([{ hrId: "B-144", onHold: false, reason: null }]),
    "a row nobody is holding needs no reason — the rule is about holds, not about every row",
  );
  assert.doesNotThrow(() => assertHoldReasonsPresent([]), "an empty save is not an error");

  // The message has to be actionable: HR must type a reason per person, and a
  // count does not say for whom. Names every offender, not just the first.
  let message = "";
  try {
    assertHoldReasonsPresent([
      { hrId: "B-144", fullName: "Ahmed Fathy", onHold: true, reason: null },
      { hrId: "B-23", fullName: "Mona Salah", onHold: true, reason: "" },
      { hrId: "B-3", fullName: "Sara Samir", onHold: true, reason: "owner ruling 2026-08-28" },
    ]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /B-144 \(Ahmed Fathy\)/, "the first offender is named with their real name");
  assert.match(message, /B-23 \(Mona Salah\)/, "the SECOND offender is named too — not just the first");
  assert.equal(
    message.includes("B-3"),
    false,
    "somebody who DID give a reason is not dragged into the error",
  );

  // ---- formatCarriedForwardReason: provenance lives in the text -----------
  assert.equal(
    formatCarriedForwardReason("July 2026", "Not paid through this system at all"),
    "Carried forward from July 2026 — Not paid through this system at all",
    "the month is inside the stored string, so the label survives the save that persists it",
  );
  assert.equal(
    formatCarriedForwardReason("July 2026", "   "),
    null,
    "a blank reason carries nothing — a bare prefix would assert a provenance for no content",
  );
  assert.equal(formatCarriedForwardReason("July 2026", null), null);

  assert.equal(
    formatCarriedForwardReason("July 2026", "Carried forward from June 2026 — owner ruling"),
    "Carried forward from July 2026 — owner ruling",
    "re-labelled to the run it was actually read from, never nested two prefixes deep",
  );
  assert.equal(
    stripCarriedForwardPrefix("Carried forward from June 2026 — owner ruling"),
    "owner ruling",
  );
  assert.equal(
    stripCarriedForwardPrefix("owner ruling"),
    "owner ruling",
    "a reason that was never carried is returned untouched",
  );
  assert.equal(isCarriedForwardReason("Carried forward from July 2026 — x"), true);
  assert.equal(isCarriedForwardReason("Paid by cheque"), false);
  assert.equal(isCarriedForwardReason(null), false);

  // ---- resolveHoldReason: precedence -------------------------------------
  // The headline: a freshly typed reason is never overwritten by an inherited one.
  const typed = resolveHoldReason({
    onHold: true,
    storedReason: "Resigned; settled in cash on 2026-08-31",
    prior: priorHold("Not paid through this system at all"),
    priorMonthLabel: "July 2026",
  });
  assert.equal(
    typed.reason,
    "Resigned; settled in cash on 2026-08-31",
    "this month's own reason WINS — carry-forward fills a gap, it never replaces a current assertion",
  );
  assert.equal(typed.carriedForward, false, "and it is not mislabelled as inherited");

  const inherited = resolveHoldReason({
    onHold: true,
    storedReason: null,
    prior: priorHold("Not paid through this system at all"),
    priorMonthLabel: "July 2026",
  });
  assert.equal(
    inherited.reason,
    "Carried forward from July 2026 — Not paid through this system at all",
    "a held row with no reason of its own inherits last month's, labelled",
  );
  assert.equal(inherited.carriedForward, true, "and is flagged so the UI can mark the field");

  assert.equal(
    resolveHoldReason({
      onHold: false,
      storedReason: null,
      prior: priorHold("Not paid through this system at all"),
      priorMonthLabel: "July 2026",
    }).reason,
    null,
    "a row nobody is holding inherits nothing — an explanation must not attach to someone being paid",
  );

  const neverExplained = resolveHoldReason({
    onHold: true,
    storedReason: null,
    prior: priorHold(null),
    priorMonthLabel: "July 2026",
  });
  assert.equal(
    neverExplained.reason,
    null,
    "a prior month that held them and recorded nothing carries nothing — no invented reason",
  );
  assert.equal(neverExplained.carriedForward, false);

  assert.equal(
    resolveHoldReason({ onHold: true, storedReason: null, prior: null, priorMonthLabel: "" }).reason,
    null,
    "a genuinely new hold has nothing to inherit and stays blank, so the save is refused",
  );

  // A carried reason, once stored, must still be accepted by the write rule —
  // otherwise a continuing hold could never be saved without retyping it.
  assert.doesNotThrow(
    () => assertHoldReasonsPresent([{ hrId: "B-156", onHold: true, reason: inherited.reason }]),
    "a carried-forward reason satisfies the requirement — a continuation needs no retyping",
  );

  // ---- previousPeriod: the January rollover -------------------------------
  assert.deepEqual(previousPeriod({ month: 8, year: 2026 }), { month: 7, year: 2026 });
  assert.deepEqual(
    previousPeriod({ month: 1, year: 2026 }),
    { month: 12, year: 2025 },
    "January inherits from December of the PREVIOUS year, not from month 0 of this one",
  );

  // ---- the sheet placeholder ---------------------------------------------
  assert.notEqual(
    HELD_NO_REASON_COMMENT,
    "HOLD",
    "the old placeholder read as a status label, so a blank reason looked answered",
  );
  assert.match(
    HELD_NO_REASON_COMMENT,
    /NO REASON RECORDED/,
    "what prints where a reason belongs must name the gap, not fill it with a word",
  );
}
