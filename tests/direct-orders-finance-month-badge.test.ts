import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// From types.ts, not the .tsx component: the harness runs `node --experimental-strip-types`, which
// cannot load a .tsx file at all. A rule kept in the component could only be checked by matching
// its source text — which proves a string is present, not that the rule behaves.
import { showsAwaitingFinanceMonth } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "Approved" must never be shown without saying whether the sale is booked (spec C2), and the
// registry gate must be given the row rather than a constant (audit F6).
//
// THE GOLDEN RULE: CEO approval never injects sales. Injection happens only when the Finance
// Manager books the order into a month. So an order can sit `approved` for days with its value in
// nobody's numbers — and until 2026-08-05 four surfaces rendered that as a plain green "Approved".
// The detail page had carried the full sentence since C2 was written; the four LIST surfaces never
// did, because each owned a copy-pasted StatusPill and the fix would have had to land four times.
//
// It was not hypothetical: DOP-000010 and DOP-000012 were both approved with a null sales_month and
// nothing injected. Every screen said "Approved".
// ─────────────────────────────────────────────────────────────────────────────

const PILL = "../src/components/direct-orders/direct-order-status-pill.tsx";
const TYPES = "../src/lib/direct-orders/types.ts";
const SERVICE = "../src/lib/direct-orders/service.ts";

/**
 * Every surface that renders an approval list item.
 *
 * Was FOUR (two approvals queues + two submit forms) until 2026-08-10, when the module was
 * consolidated: both approvals queues were retired into the workspace's Needs Action tab, and the
 * portal submit form was replaced by the shared one. Two copies became one, which is the whole
 * point — but the sweep must follow the surfaces that exist NOW rather than shrink, or the rule
 * quietly stops covering the screen that replaced them.
 */
const SURFACES = [
  ["the admin submit form's own-orders list", "../src/components/direct-orders/direct-order-submit-form.tsx"],
  ["the consolidated workspace", "../src/components/direct-orders/workspace/direct-orders-workspace.tsx"],
] as const;

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderFinanceMonthBadgeTests() {
  const pill = read(PILL);
  const types = read(TYPES);
  const service = read(SERVICE);

  // ── The month has to reach the list at all ───────────────────────────────────────────────
  const listItem = types.slice(
    types.indexOf("export type DirectOrderApprovalListItem = {"),
    types.indexOf("export type DirectOrderReportRow"),
  );
  assert.match(
    listItem,
    /salesMonth: string \| null;/,
    "DirectOrderApprovalListItem MUST CARRY salesMonth: without it the four surfaces that render this type can only say \"Approved\", which reads as \"the money is counted\" about an order in nobody's numbers",
  );
  assert.match(
    service,
    /salesMonth: request\.salesMonth,/,
    "the list mapper must populate salesMonth — a declared field nothing fills is null everywhere, which would show the awaiting-Finance badge on orders that WERE booked",
  );

  // ── One pill, not five ───────────────────────────────────────────────────────────────────
  for (const [label, rel] of SURFACES) {
    const source = read(rel);
    assert.match(
      source,
      /import \{ DirectOrderStatusPill \} from "@\/components\/direct-orders\/direct-order-status-pill";/,
      `${label} must use the SHARED pill — four private copies is why "Approved" could not be corrected in one edit`,
    );
    assert.doesNotMatch(
      source,
      /function StatusPill\(/,
      `A PRIVATE StatusPill IS BACK IN ${label}: the next status or wording change will then land in one file and silently miss three`,
    );
    assert.match(
      source,
      /salesMonth=\{(row|r)\.salesMonth\}/,
      `${label} must pass salesMonth to the pill, or it renders the plain "Approved" this whole change exists to remove`,
    );
  }

  // ── The pill's rule, EXECUTED rather than read ───────────────────────────────────────────
  //
  // Production cannot check this. Every direct order was rejected on 2026-08-05, so there are zero
  // approved rows and zero rows carrying a sales_month — neither the case where the badge must show
  // nor the case where it must stay hidden exists in the data. Both branches are therefore run here
  // for real, because a source match proves the string is present, not that the rule is right.
  assert.equal(
    showsAwaitingFinanceMonth("approved", null),
    true,
    "AN APPROVED ORDER WITH NO MONTH MUST SHOW THE BADGE: its value is in nobody's numbers, and a plain \"Approved\" says the opposite",
  );
  assert.equal(
    showsAwaitingFinanceMonth("approved", "2026-08"),
    false,
    "A BOOKED ORDER MUST NOT SHOW THE BADGE: this is the inverse error and the more damaging one — it would tell Finance an order they already booked is still waiting on them",
  );
  for (const other of ["pending_approval", "held", "rejected", "expired", "cancelled", "returned", "reversed", "draft"]) {
    assert.equal(
      showsAwaitingFinanceMonth(other, null),
      false,
      `"${other}" must never show the Finance badge — only an APPROVED order is waiting on a month; on anything else it is noise that trains people to ignore it`,
    );
  }
  assert.match(
    pill,
    /salesMonth: string \| null;/,
    "salesMonth must be REQUIRED on the pill, never optional: an optional prop lets a caller omit it and silently get the plain Approved back, and the omission would look deliberate",
  );
  // The pill must DELEGATE to the domain rule, not re-implement it. A second copy of the condition
  // is how the tested rule and the rendered one drift apart while both look correct.
  assert.match(
    pill,
    /showsAwaitingFinanceMonth\(key, salesMonth\)/,
    "the pill must call the shared predicate — a local copy of `status === approved && !salesMonth` would be untestable here and free to diverge",
  );
  assert.match(
    pill,
    /awaiting finance month/i,
    "the pill must say it in words — the owner's rule is human-readable, and a colour alone is not a sentence",
  );
  // Emerald says "done". This order's value is in no month's numbers.
  assert.doesNotMatch(
    pill,
    /const AWAITING_FINANCE_SOLID = "bg-emerald/,
    "the awaiting-Finance pill must not be emerald — green reads as settled, which is the exact wrong impression",
  );
  // Both look families survive: the owner's rule is that a module's pages match their siblings.
  assert.match(pill, /variant === "ring"/, "the portal's rounded ring look must survive the merge into one component");
  assert.match(pill, /SOLID_TONE: Record<DirectOrderStatus, string>/, "the tone maps must be exhaustive over the status union");
  assert.match(pill, /RING_TONE: Record<DirectOrderStatus, string>/, "both variants must be exhaustive, or a new status renders unstyled in one of them");

  // ── F6: the gate gets the row, except where a literal is the honest answer ───────────────
  const gates = [...service.matchAll(/assertDirectOrderWorkflowTransition\(\{[\s\S]{0,320}?\}\);/g)].map((m) => m[0]);
  const gateFor = (key: string) => gates.find((g) => g.includes(`actionKey: "${key}"`));

  // `revive_held` moved behind a shared helper on 2026-08-08: BOTH doors out of the held lane
  // (revive after validation, and release once the distributor code proves the pharmacy) run the
  // same moveHeldDirectOrdersIntoChain, which is handed its action key. So the literal
  // `actionKey: "revive_held"` now lives at the wrapper's call site, and the GATE reads
  // `actionKey: opts.actionKey`. Both facts are still required, and both are asserted — what must
  // never happen is the gate disappearing or being told a constant status.
  const parameterisedHeldGate = gates.find((gate) => gate.includes("actionKey: opts.actionKey"));
  assert.ok(
    parameterisedHeldGate,
    "the held-lane exit must STILL be registry-gated — both doors run one helper, and that helper gates every request it moves",
  );
  assert.match(
    parameterisedHeldGate!,
    /status: request\.status,/,
    "THE HELD-LANE GATE IS BEING TOLD A CONSTANT (audit F6): its query filters on held and then iterates, so a literal only re-states what the filter guaranteed — the gate can never catch a row whose status moved in between",
  );
  // …and the only action keys that helper may ever be given are the two declared doors.
  for (const key of ["revive_held", "release_held"]) {
    assert.match(
      service,
      new RegExp(`actionKey: "${key}"`),
      `${key} must still be passed to the shared held-lane helper — a door that stops naming its registry action is an ungated door`,
    );
  }
  {
    const block = gateFor("expire_held");
    assert.ok(block, "expire_held must still be gated");
    assert.match(
      block!,
      /status: request\.status,/,
      "expire_held IS BEING TOLD A CONSTANT (audit F6): its query filters on held and then iterates, so a literal only re-states what the filter guaranteed",
    );
  }
  const decision = gates.find((g) => g.includes("actionKey: action.actionKey"));
  assert.ok(decision, "the decision path must still be gated");
  assert.match(
    decision!,
    /status: request\.status,/,
    "THE DECISION GATE IS BEING TOLD A CONSTANT (audit F6): decideDirectOrder checks the status itself just above, so a literal made the registry a copy of that check rather than an independent one",
  );

  // ── The two deliberate literals must STAY literal ────────────────────────────────────────
  const submit = gates.find((g) => g.includes('actionKey: submitAsHeld ? "submit_held" : "submit"'));
  assert.match(
    submit!,
    /status: "draft",/,
    "submit must keep its literal — no row exists yet, so there is no real status to read and inventing one would be worse",
  );
  const validation = read("../src/lib/direct-orders/pharmacy-validation.ts");
  assert.match(
    validation,
    /actionKey: "decide_pharmacy_validation",[\s\S]{0,120}?status: "held",/,
    "decide_pharmacy_validation must KEEP its literal: approving one validation revives every held order of that pharmacy, so coupling this to the linked order makes a second pending validation permanently undecidable",
  );
}
