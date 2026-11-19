import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDirectOrderCollectionHistory,
  canRecordDirectOrderCollection,
  deriveDirectOrderCollection,
  DIRECT_ORDER_FINANCE_HR_ID,
  resolveAddedDirectOrderPayment,
} from "../src/lib/direct-orders/collection-rules.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Recording money collected against a direct order.
 *
 * Two properties this file exists to hold:
 *   1. It is an IDENTITY gate, not a role gate — a second Finance Manager must not inherit it.
 *   2. Collecting the cash NEVER moves the sales month. Approval, booking a month and taking the
 *      payment are three separate events, and collapsing the last two would silently drag one
 *      month's sales into another.
 */
function ctx(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: DIRECT_ORDER_FINANCE_HR_ID,
    role: "Finance Manager",
    scope: "company",
    source: "session",
    ...overrides,
  };
}

export async function runDirectOrderCollectionTests() {
  // ── Who may record a collection ────────────────────────────────────────────
  assert.equal(canRecordDirectOrderCollection(ctx({})), true, "Ahmed (B-185) may record a collection");
  assert.equal(
    canRecordDirectOrderCollection(ctx({ hrId: "b-185" })),
    true,
    "HR_ID matching is case-insensitive — a lower-cased session must not lose the duty",
  );
  assert.equal(
    canRecordDirectOrderCollection(ctx({ hrId: "S-1", role: "Super Admin", scope: "system" })),
    true,
    "Super Admin may record a collection",
  );

  // The sharpest guard in this file: the duty follows the PERSON, not the job title. If this ever
  // returns true, someone has rewritten the check as `role === "Finance Manager"` and a future
  // hire silently inherited the ability to move real receivables.
  assert.equal(
    canRecordDirectOrderCollection(ctx({ hrId: "B-999", role: "Finance Manager", scope: "company" })),
    false,
    "a DIFFERENT Finance Manager must NOT inherit the collection duty",
  );

  // The CEO approves the order but never touches the money against it.
  assert.equal(canRecordDirectOrderCollection(ctx({ hrId: "C-1", role: "CEO", scope: "company" })), false);
  assert.equal(canRecordDirectOrderCollection(ctx({ hrId: "A-8", role: "SFE Manager", scope: "line" })), false);
  assert.equal(
    canRecordDirectOrderCollection(ctx({ hrId: "B-155", role: "Medical Rep", scope: "self" })),
    false,
    "the requesting rep must not be able to declare their own order paid",
  );
  assert.equal(canRecordDirectOrderCollection(ctx({ hrId: null })), false, "a session with no identity is denied");

  // ── What is a valid collection ─────────────────────────────────────────────
  const TODAY = "2026-08-10";
  const base = { status: "approved", salesValue: 1000, todayCairo: TODAY };

  const partial = deriveDirectOrderCollection({ ...base, paidAmount: 400, paymentDate: "2026-08-09" });
  assert.equal(partial.ok, true);
  if (partial.ok) {
    assert.equal(partial.paidAmount, 400);
    assert.equal(partial.remainingAmount, 600, "the remainder is DERIVED from the order value");
    assert.equal(partial.paymentDate, "2026-08-09");
  }

  const full = deriveDirectOrderCollection({ ...base, paidAmount: 1000, paymentDate: TODAY });
  assert.equal(full.ok, true);
  if (full.ok) assert.equal(full.remainingAmount, 0, "paying the whole value leaves zero outstanding");

  // Today is not the future. An off-by-one here would refuse every same-day collection, which is
  // the normal case — Finance records the cash on the day it arrives.
  assert.equal(
    deriveDirectOrderCollection({ ...base, paidAmount: 100, paymentDate: TODAY }).ok,
    true,
    "a collection dated TODAY must be accepted",
  );

  // Fractions: two decimals survive, and the remainder still adds back to the order value.
  const cents = deriveDirectOrderCollection({
    status: "approved",
    salesValue: 1309.5,
    todayCairo: TODAY,
    paidAmount: 1000.55,
    paymentDate: TODAY,
  });
  assert.equal(cents.ok, true);
  if (cents.ok) {
    // Each carries its own message: a piastre-level rounding change fails here first, and an
    // assertion that goes red without saying why sends the next person hunting the wrong guard.
    assert.equal(cents.paidAmount, 1000.55, "the amount collected must survive to the piastre");
    assert.equal(cents.remainingAmount, 308.95, "the remainder must be exact to the piastre");
    assert.equal(
      Math.round((cents.paidAmount + cents.remainingAmount) * 100) / 100,
      1309.5,
      "paid + remaining must reconstruct the order value exactly",
    );
  }

  // ── What is refused ────────────────────────────────────────────────────────
  const refused = (
    input: Partial<Parameters<typeof deriveDirectOrderCollection>[0]>,
    why: string,
  ) => {
    const outcome = deriveDirectOrderCollection({
      ...base,
      paidAmount: 100,
      paymentDate: TODAY,
      ...input,
    });
    assert.equal(outcome.ok, false, why);
    if (!outcome.ok) assert.ok(outcome.message.length > 0, "a refusal must say why");
  };

  refused({ paidAmount: 1000.01 }, "collecting more than the order value is refused");
  // Redundant with the line above under today's rules — 1000.005 rounds up to 1000.01 and is
  // refused by the same branch — but kept as a boundary marker. Coarser rounding is caught by the
  // piastre assertions above, not here; verified by break-proof, not assumed.
  refused({ paidAmount: 1000.005 }, "an overage too small to see is still refused");
  refused({ paidAmount: 0 }, "zero is not a collection — use Clear instead");
  refused({ paidAmount: -50 }, "a negative collection is refused");
  refused({ paidAmount: Number.NaN }, "a non-numeric amount is refused");
  refused({ paidAmount: null }, "a missing amount is refused");
  refused({ paymentDate: "2026-08-11" }, "a collection dated tomorrow is refused");
  refused({ paymentDate: "10/08/2026" }, "a non-ISO date is refused");
  refused({ paymentDate: "" }, "a missing date is refused");
  refused({ salesValue: 0 }, "an order with no value has nothing to collect against");

  // Only an APPROVED order carries a debt. Anything else would record a receivable for stock the
  // company never agreed to supply.
  for (const status of ["draft", "pending_approval", "returned", "rejected", "held", "reversed"]) {
    refused({ status }, `a ${status} order cannot have a collection recorded against it`);
  }

  // ── The separation that must never be collapsed ────────────────────────────
  // Source-level, because it is a property of what the function does NOT do, and no unit test of
  // its return value can catch a stray write.
  const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const start = serviceSource.indexOf("export async function recordDirectOrderCollection");
  assert.ok(start > 0, "recordDirectOrderCollection must exist in the direct-orders service");
  // End at the function's own closing brace — the first `}` in column 0 — not at the next export.
  // A wider window would sweep in whatever helper happens to sit below and could fail spuriously.
  const after = serviceSource.slice(start);
  const end = after.indexOf("\n}\n");
  assert.ok(end > 0, "could not find the end of recordDirectOrderCollection");
  const body = after.slice(0, end);

  assert.ok(
    !body.includes("sales_month"),
    "recording a collection must NEVER write sales_month — the month is a separate, explicit decision",
  );
  assert.ok(
    !body.includes("phx_rebuild_direct_order_sos_batch"),
    "recording a collection must NEVER rebuild a Source-of-Sales period — cash is not a sales event",
  );
  // Clearing has to reset the date too. A payment_date left behind with no amount makes the
  // phantom-pharmacy sweep (pharmacy-probation.ts) treat an unpaid order as proof the pharmacy
  // is real, which is exactly the false positive that check exists to avoid.
  assert.ok(
    body.includes("payment_date: null") && body.includes("paid_amount: null"),
    "clearing a collection must reset the payment date and the amount together",
  );

  // ── The field is a RUNNING TOTAL, and every label must say so ─────────────
  //
  // The arithmetic here has always been right and an earlier review was wrong to call it a bug:
  // the control pre-fills with the stored figure and a save REPLACES it, so editing 200 to 500
  // stores 500. Accumulating instead — the "fix" that was proposed and withdrawn — would have
  // stored 700 the moment Finance corrected a typo.
  //
  // What was actually wrong was the WORDS. "Amount collected" reads just as easily as "the amount
  // collected this time", and a Finance user entering a second instalment of 300 against 200
  // already collected would have stored 300 and silently lost 100. These assertions pin the
  // wording, because the wording is the whole safeguard.
  const control = readFileSync(
    new URL("../src/components/direct-orders/direct-order-collection-control.tsx", import.meta.url),
    "utf8",
  );
  const controlCode = stripComments(control);

  assert.match(
    controlCode,
    /Total collected \(Finance\)/,
    "the control's heading must say TOTAL — it is the first thing read and the last thing doubted",
  );
  assert.match(
    controlCode,
    /aria-label="Total collected to date, in EGP[^"]*replaces any amount already recorded"/,
    "the input's accessible name must say total AND that saving replaces — a screen-reader user gets " +
      "no help from the visible hint below it",
  );
  assert.match(controlCode, /placeholder="Total collected \(EGP\)"/, "the placeholder must say total");
  assert.match(
    controlCode,
    /RUNNING TOTAL, not a new payment/,
    "the control must warn, in words, that saving replaces the stored figure",
  );
  assert.match(
    controlCode,
    /saving replaces the \{money\(paidAmount\)\} already/,
    "and must NAME the figure being replaced — telling someone a field is a total is weaker than " +
      "telling them which number they are about to overwrite",
  );

  // The pre-fill is what makes the replace semantics safe: arriving at an empty box and typing the
  // new instalment is exactly the mistake the wording now prevents.
  assert.match(
    controlCode,
    /useState\(paidAmount == null \? "" : String\(paidAmount\)\)/,
    "the amount field must pre-fill with the stored total, so an edit starts from what is recorded",
  );

  // ── The limitations are written down where they will be found ────────────
  const spec = readFileSync(new URL("../docs/specs/direct-orders.md", import.meta.url), "utf8");
  for (const limitation of [
    "instalment ledger",
    "most recent recorded total",
    "Refunds",
    "pharmacy-probation.ts",
    "RUNNING TOTAL",
  ]) {
    assert.ok(
      spec.includes(limitation),
      `the spec must document "${limitation}" — the brief was to document this model, not expand it, ` +
        "and an undocumented limit is one somebody designs against by accident",
    );
  }
  assert.ok(
    // The spec wraps this sentence across lines inside a blockquote, so the newline and the "> "
    // prefix are matched rather than assumed away.
    /withdrawn\s*>?\s*and must stay withdrawn/.test(spec),
    "the spec must record that accumulating was proposed, withdrawn, and must stay withdrawn",
  );

  // ── "Add a payment" (owner, 19 Nov 2026: "understand what he wants and tailor it in the system") ──
  // Ahmed El Maraghy was adding instalments up by hand (25,000 → 74,246 → 109,246 on one order). The add mode
  // takes ONE payment and adds it to the total the screen showed; correcting a typo stays the other mode.
  assert.deepEqual(
    resolveAddedDirectOrderPayment({ alreadyPaid: 74246, addAmount: 35000, salesValue: 120000 }),
    { ok: true, addAmount: 35000, paidAmount: 109246 },
    "74,246 already collected plus a 35,000 payment is 109,246 — the sum he used to do by hand",
  );
  assert.deepEqual(
    resolveAddedDirectOrderPayment({ alreadyPaid: null, addAmount: 1155.004, salesValue: 6693 }),
    { ok: true, addAmount: 1155, paidAmount: 1155 },
    "the first payment on an order with nothing recorded is the total, rounded to the piastre",
  );
  assert.deepEqual(
    resolveAddedDirectOrderPayment({ alreadyPaid: 0.1, addAmount: 0.2, salesValue: 10 }),
    { ok: true, addAmount: 0.2, paidAmount: 0.3 },
    "money is added to the piastre, never 0.30000000000000004",
  );
  const over = resolveAddedDirectOrderPayment({ alreadyPaid: 600, addAmount: 500, salesValue: 1000 });
  assert.equal(over.ok, false, "a payment above what is still owed is refused");
  assert.match(over.ok ? "" : over.message, /more than the 400\.00 EGP still outstanding \(600\.00 EGP is already recorded\)/);
  const overNet = resolveAddedDirectOrderPayment({ alreadyPaid: 600, addAmount: 350, salesValue: 1000, offsetTotal: 100 });
  assert.equal(overNet.ok, false, "marketing settlements count against what is still owed");
  assert.deepEqual(
    resolveAddedDirectOrderPayment({ alreadyPaid: 600, addAmount: 400, salesValue: 1000 }),
    { ok: true, addAmount: 400, paidAmount: 1000 },
    "the exact remainder settles the order in full",
  );
  for (const bad of [0, -5, Number.NaN, null, undefined]) {
    assert.equal(
      resolveAddedDirectOrderPayment({ alreadyPaid: 100, addAmount: bad, salesValue: 1000 }).ok,
      false,
      `a payment of ${String(bad)} is refused`,
    );
  }

  // ── The payment history: each instalment is the difference the event itself recorded ──────────
  const history = buildDirectOrderCollectionHistory([
    {
      event_type: "collection_recorded",
      created_at: "2026-11-03T10:00:00Z",
      actor_hr_id: "B-185",
      metadata: { previousPaidAmount: 25000, paidAmount: 74246, paymentDate: "2026-11-03", remainingAmount: 45754 },
    },
    {
      event_type: "collection_recorded",
      created_at: "2026-11-01T10:00:00Z",
      actor_hr_id: "B-185",
      metadata: { previousPaidAmount: null, paidAmount: 25000, paymentDate: "2026-11-01", remainingAmount: 95000 },
    },
    {
      event_type: "collection_recorded",
      created_at: "2026-11-04T10:00:00Z",
      actor_hr_id: "B-185",
      metadata: { previousPaidAmount: 74246, paidAmount: 74246, paymentDate: "2026-11-04", remainingAmount: 45754 },
    },
    {
      event_type: "collection_cleared",
      created_at: "2026-11-05T10:00:00Z",
      actor_hr_id: "S-1",
      metadata: { previousPaidAmount: 74246, paidAmount: null },
    },
    { event_type: "approved", created_at: "2026-10-30T10:00:00Z", actor_hr_id: "C-1", metadata: {} },
  ]);
  assert.deepEqual(
    history.map((entry) => [entry.kind, entry.amount, entry.total, entry.paymentDate]),
    [
      ["payment", 25000, 25000, "2026-11-01"],
      ["payment", 49246, 74246, "2026-11-03"],
      ["correction", 0, 74246, "2026-11-04"],
      ["cleared", null, null, null],
    ],
    "oldest first, each payment its own difference, a same-total save a correction, a clear named, other events left out",
  );

  // The screen offers both modes in words, and the add mode says it adds.
  assert.match(controlCode, />\s*Add a payment\s*</, "the add mode is named on the screen");
  assert.match(controlCode, />\s*Correct the total\s*</, "and the replace mode is named apart from it");
  assert.match(
    controlCode,
    /aria-label="This payment, in EGP — added to the total already recorded"/,
    "the payment field's accessible name says it ADDS, so it can never be mistaken for the total",
  );

  console.log("  direct-orders collection: labelled as a total, pre-filled, and its limits documented");
}
