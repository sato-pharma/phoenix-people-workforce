import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The pharmacy-validation flow must pass through the workflow registry (audit F2).
//
// The registry DECLARED `request_pharmacy_validation` and `decide_pharmacy_validation` from the
// day the module was created, and neither was ever invoked. The mechanical reason was a type:
// `DirectOrderWorkflowActionKey` did not list them, so the gate could not be called for them
// without changing the union — and nobody did.
//
// The effect was not an open door (each service enforces its own check) but a false claim: the
// registry is the module's governance layer, and the entire door out of the held lane sat outside
// it while the registry's own rows said otherwise. Governance that does not run is documentation.
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION = "../src/lib/direct-orders/pharmacy-validation.ts";
const WORKFLOW = "../src/lib/direct-orders/workflow.ts";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/** The body of one exported function, bounded at the next export so assertions cannot leak. */
function functionBlock(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next > 0 ? next : undefined);
}

export function runDirectOrderValidationRegistryGateTests() {
  const workflow = read(WORKFLOW);
  const validation = read(VALIDATION);

  // ── The union is what made the gate uncallable ───────────────────────────────────────────
  for (const key of ["request_pharmacy_validation", "decide_pharmacy_validation"]) {
    assert.match(
      workflow,
      new RegExp(`\\|\\s*"${key}"`),
      `DirectOrderWorkflowActionKey OMITS "${key}": the registry declares this action, and a key missing from this union is the exact mechanism by which the gate could never be called for it (audit F2)`,
    );
  }

  // ── Both services must actually call the gate ────────────────────────────────────────────
  const requestBlock = functionBlock(validation, "requestDirectOrderPharmacyValidation");
  const decideBlock = functionBlock(validation, "decideDirectOrderPharmacyValidation");

  assert.match(
    requestBlock,
    /assertDirectOrderWorkflowTransition\(\{[\s\S]{0,300}?actionKey: "request_pharmacy_validation"/,
    "FILING VALIDATION EVIDENCE BYPASSES THE REGISTRY: direct_orders:create admits Medical Rep and Financial Advisor, neither of whom the registry lists for this action, and neither of whom can ever be a direct-order requester",
  );
  assert.match(
    decideBlock,
    /assertDirectOrderWorkflowTransition\(\{[\s\S]{0,300}?actionKey: "decide_pharmacy_validation"/,
    "DECIDING A VALIDATION BYPASSES THE REGISTRY: this is the action that mints or rewires a pharmacy, and it is the one the registry restricts most tightly",
  );

  // ── The request side passes the ROW's status, not a literal (audit F6) ───────────────────
  assert.match(
    requestBlock,
    /status: linkedRequestStatus \?\? "held",/,
    "the request gate must be given the linked order's REAL status — a constant validates what the code assumed rather than what the database holds",
  );
  assert.match(
    requestBlock,
    /\.select\("id, requester_hr_id, status"\)/,
    "the status must ride along on the ownership query that was already being made: every round trip here crosses the Atlantic, and a second one would double the latency of filing evidence",
  );

  // ── The server refuses evidence for an order that is no longer held ──────────────────────
  assert.match(
    requestBlock,
    /if \(linkedRequestStatus !== "held"\) \{[\s\S]{0,400}?badRequest\(/,
    "THE SERVER ACCEPTS EVIDENCE FOR A REVIVED OR EXPIRED ORDER: the client hides the capture unless the order is held, but a hidden button is UX, not access control — and it must say so in words rather than leave the registry to refuse it with a sentence nobody can act on",
  );

  // ── The decide side must NOT couple to the order's status ────────────────────────────────
  // Approving one validation revives every held order of that pharmacy, so a SECOND pending
  // validation for the same pharmacy would find its linked order already `pending_approval`.
  // Gating on that status blocks a decision the admin still has to make — including rejecting it.
  assert.doesNotMatch(
    decideBlock,
    /status: linked[A-Za-z]*Status/,
    "DECIDING MUST NOT BE GATED ON THE LINKED ORDER'S STATUS: approving one validation revives the pharmacy's held orders, so a second pending validation would be permanently undecidable — the real precondition is the VALIDATION being pending, which is checked separately",
  );
  assert.match(
    decideBlock,
    /if \(String\(\(row as \{ status\?: string \}\)\.status \?\? ""\) !== "pending"\)/,
    "the validation's own pending status is the precondition that must survive any refactor",
  );

  // ── The finer, older guards must survive — the registry is a second belt, not a swap ──────
  assert.match(
    requestBlock,
    /You can only submit evidence for your own direct order\./,
    "the requester-ownership check must remain: the registry gate is coarse role/status only and would happily let one rep file evidence for another rep's order",
  );
  assert.match(
    decideBlock,
    /assertValidationDeskAccess\(access\)/,
    "the validation-desk check must remain — it is the rule that actually names who may decide",
  );
}
