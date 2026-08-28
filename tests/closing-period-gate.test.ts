import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLOSING_GOLDEN_RULE,
  assertClosingPeriodComplete,
  closingPeriodGateMessage,
  closingPeriodOpensOn,
  isClosingPeriodComplete,
  parseClosingPeriod,
} from "../src/lib/sales/closing-period-gate.ts";

// THE CLOSING GOLDEN RULE (owner, 2026-08-28): "no closing is ever done or sent during the
// month. Closing after the month closes."
//
// This test is the lock. It pins BOTH halves:
//   1. the gate's own arithmetic, including the Cairo month boundary in each season, and
//   2. that publishClosing actually calls it, before it writes anything.
//
// Half 2 matters most. The rule was violable for as long as it existed as prose only: nothing in
// the publish path checked a date, so releasing a partial month to every manager — and to the
// CEO's Source-of-Sales report — was one button press.

const PUBLICATION_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/monthly-closing-publication.ts", import.meta.url)),
  "utf8",
);

const REPORT_DELIVERY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/sos-report-delivery.ts", import.meta.url)),
  "utf8",
);

// Cairo is UTC+3 (EEST) roughly late April-late October, UTC+2 (EET) otherwise — the same
// live-verified seasonal offsets tests/i18n-cairo-date-boundary.test.ts relies on.
const AUG_31_2359_CAIRO = new Date("2026-08-31T20:59:00Z"); // EEST: still August in Cairo
const SEP_01_0000_CAIRO = new Date("2026-08-31T21:00:00Z"); // EEST: already September in Cairo
const DEC_31_2359_CAIRO = new Date("2026-12-31T21:59:00Z"); // EET: still December in Cairo
const JAN_01_0000_CAIRO = new Date("2026-12-31T22:00:00Z"); // EET: already January in Cairo

export function runClosingPeriodGateTests() {
  // ── The rule as the owner stated it ────────────────────────────────────────
  assert.equal(CLOSING_GOLDEN_RULE.statedOn, "2026-08-28", "the rule records when it was set");
  assert.ok(
    CLOSING_GOLDEN_RULE.summary.includes("never")
    && CLOSING_GOLDEN_RULE.summary.includes("during the month it covers"),
    "the summary must still say a closing is never sent during the month it covers",
  );

  // ── Period parsing ─────────────────────────────────────────────────────────
  assert.deepEqual(parseClosingPeriod("2026-08"), { year: 2026, month: 8 }, "parses YYYY-MM");
  assert.equal(parseClosingPeriod("2026-13"), null, "month 13 is not a month");
  assert.equal(parseClosingPeriod("2026-00"), null, "month 00 is not a month");
  assert.equal(parseClosingPeriod("2026-8"), null, "a one-digit month is not the wire format");
  assert.equal(parseClosingPeriod(""), null, "empty is not a period");
  assert.equal(parseClosingPeriod(null), null, "null is not a period");

  // ── THE RULE ITSELF: the running month is refused ──────────────────────────
  // 2026-08-28 is the day the owner set the rule; the August closing must be refused on it.
  const onTheDayHeSetIt = new Date("2026-08-28T06:00:00Z");
  assert.equal(
    isClosingPeriodComplete("2026-08", onTheDayHeSetIt),
    false,
    "GOLDEN RULE: the August closing cannot be published on 28 August",
  );
  assert.throws(
    () => assertClosingPeriodComplete("2026-08", onTheDayHeSetIt),
    /still running/,
    "publishing the running month must throw, not warn",
  );

  // A future month has no closing at all.
  assert.equal(
    isClosingPeriodComplete("2026-12", onTheDayHeSetIt),
    false,
    "a month that has not started cannot be closed",
  );
  assert.throws(
    () => assertClosingPeriodComplete("2026-12", onTheDayHeSetIt),
    /has not started yet/,
    "a future period is refused with its own reason",
  );

  // A month that has ended is allowed — the rule permits, it does not merely forbid.
  assert.equal(
    isClosingPeriodComplete("2026-07", onTheDayHeSetIt),
    true,
    "July's closing is publishable in August — this is the normal path",
  );
  assert.doesNotThrow(() => assertClosingPeriodComplete("2026-07", onTheDayHeSetIt));

  // An unparseable period is refused rather than silently treated as complete.
  assert.equal(isClosingPeriodComplete("not-a-period", onTheDayHeSetIt), false);
  assert.throws(() => assertClosingPeriodComplete("", onTheDayHeSetIt), /not a valid closing period/);

  // ── The Cairo boundary, in BOTH seasons ────────────────────────────────────
  // The server is UTC. On 31 August between 21:00 and 23:59 UTC the server already believes it
  // is September while Cairo is still in August. A UTC check would open the gate 3h early on the
  // one night of the month it matters.
  assert.equal(
    isClosingPeriodComplete("2026-08", AUG_31_2359_CAIRO),
    false,
    "23:59 Cairo on 31 August is still August — the gate stays shut",
  );
  assert.equal(
    isClosingPeriodComplete("2026-08", SEP_01_0000_CAIRO),
    true,
    "00:00 Cairo on 1 September opens the August closing, to the minute",
  );

  // Winter (EET, UTC+2) and the year rollover in one case.
  assert.equal(
    isClosingPeriodComplete("2026-12", DEC_31_2359_CAIRO),
    false,
    "23:59 Cairo on 31 December is still December",
  );
  assert.equal(
    isClosingPeriodComplete("2026-12", JAN_01_0000_CAIRO),
    true,
    "00:00 Cairo on 1 January opens the December closing",
  );

  // ── The refusal message has to be actionable ───────────────────────────────
  const augustMessage = closingPeriodGateMessage("2026-08", onTheDayHeSetIt);
  assert.match(augustMessage, /2026-09-01/, "names the date the period actually opens");
  assert.match(augustMessage, /2026-08-28/, "names today, so the reader can see the gap");
  // December must roll the year, not produce a 13th month.
  assert.match(
    closingPeriodGateMessage("2026-12", onTheDayHeSetIt),
    /2027-01-01/,
    "December's closing opens on 1 January of the NEXT year",
  );

  // ── The date the gate opens, which the screen states beside the disabled button ──
  assert.equal(closingPeriodOpensOn("2026-08"), "2026-09-01", "August's closing opens on 1 September");
  assert.equal(closingPeriodOpensOn("2026-12"), "2027-01-01", "December rolls the year, not a 13th month");
  assert.equal(closingPeriodOpensOn("nonsense"), null, "an unparseable period has no opening date");

  // ── publishClosing must actually CALL the gate, before it writes ───────────
  // Without this, every assertion above passes while the product stays wide open.
  assert.ok(
    PUBLICATION_SOURCE.includes('from "@/lib/sales/closing-period-gate"'),
    "monthly-closing-publication.ts must import the closing period gate",
  );
  const gateCallIndex = PUBLICATION_SOURCE.indexOf("assertClosingPeriodComplete(period)");
  assert.ok(
    gateCallIndex > 0,
    "publishClosing must call assertClosingPeriodComplete(period) — the golden rule is enforced here or nowhere",
  );
  const upsertIndex = PUBLICATION_SOURCE.indexOf('.from("monthly_closing_publications")\n    .upsert(');
  assert.ok(upsertIndex > 0, "expected the publish upsert to still be recognisable");
  assert.ok(
    gateCallIndex < upsertIndex,
    "the gate must run BEFORE the row is written, not after",
  );

  // ── "or SENT": the CEO's BI workbook is the other way a closing leaves the building ──
  // publishClosing covers the cron path (it only fires on fully-published periods), but the
  // manual POST /api/sales/sos-dashboard/email-report takes whatever period the caller types.
  assert.ok(
    REPORT_DELIVERY_SOURCE.includes('from "@/lib/sales/closing-period-gate"'),
    "sos-report-delivery.ts must import the closing period gate",
  );
  const reportGateIndex = REPORT_DELIVERY_SOURCE.indexOf("if (!isClosingPeriodComplete(period))");
  assert.ok(
    reportGateIndex > 0,
    "buildAndEmailSosBiReport must refuse a period that is not a closed month — a report IS a closing being sent",
  );
  const dashboardCallIndex = REPORT_DELIVERY_SOURCE.indexOf("const data = await getSosDashboard(");
  assert.ok(dashboardCallIndex > 0, "expected the report build to still start from getSosDashboard");
  assert.ok(
    reportGateIndex < dashboardCallIndex,
    "the gate must run BEFORE the workbook is built, not after",
  );

  // unpublish is the recovery path and must stay ungated: hiding a wrongly-published month
  // cannot be blocked by the same rule that should have stopped it being published.
  const unpublishSource = PUBLICATION_SOURCE.slice(PUBLICATION_SOURCE.indexOf("export async function unpublishClosing"));
  assert.ok(
    !unpublishSource.includes("assertClosingPeriodComplete"),
    "unpublishClosing must never be date-gated — it is the recovery path",
  );
}
