import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { outstationClaimedTotal } from "../src/lib/outstation/claimed-total.ts";

// The defect this pins, in the owner's words: "a big zero appear for every expense to Cairo ...
// I'm talking just about the allowance."
//
// He was right about the symptom and, understandably, wrong about the cause. The Cairo
// no-allowance rule was working: on both production rows where it fired (76 and 97) the allowance
// went to 0 and the travel cost was paid in full. The zero he saw was request 72 — a Menoufia →
// Cairo trip the Cairo rule never touched (it still carried its 125 allowance, and it predated
// the rule by three days). Its stored `claimed_total_amount` was a hard 0 against an
// `expected_total_amount` of 448.14, with 323.14 of real fuel behind it.
//
// Cause: request 72 was submitted OFFLINE, and it is the only offline submission in the table —
// 1 of 74 rows, and the only row that got a zero. The offline draft replay posts a hardcoded
// `claimedTotalAmount: 0` (mobile-outstation-wizard.tsx), because a phone with no signal cannot
// price a trip: the route distance, the policy rates, the duplicate-day guard and the Cairo
// no-allowance rule are all server-side. `syncOfflineOutstationRequest` delegates to
// `submitOutstationRequest`, which recalculated everything correctly — and then stored the
// client's 0 instead of its own figure. So an offline submission was written claiming nothing.
//
// Worth stating plainly, because it decides where the fix belongs: the offline path can NEVER
// send a meaningful number. The server is the only place this could ever have been resolved,
// which is why the fix is there and not in the wizard.
//
// Two halves are pinned here, because fixing either alone leaves the bug reachable:
//   1. The READER never returns a bare zero over a real expected total (rows already written).
//   2. The WRITER stores the resolved figure, and the read mapper resolves too (rows to come).

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

export function runOutstationClaimedTotalTests() {
  // ── The reader ───────────────────────────────────────────────────────────────

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: 0, expectedTotalAmount: 448.14 }),
    448.14,
    "request 72's exact shape: a stored zero over a real expected total must read as the expected total, never as EGP 0 — that zero is the ABSENCE of a claim, not a claim of nothing",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: 341.68, expectedTotalAmount: 341.68 }),
    341.68,
    "a healthy row is returned untouched",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: 500, expectedTotalAmount: 448.14 }),
    500,
    "a real claim that differs from the system's estimate must survive — the employee's own figure outranks the estimate, which is the entire point of storing both",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: 219.82, expectedTotalAmount: 219.82 }),
    219.82,
    "request 97: a Cairo trip whose allowance the rule correctly zeroed still claims its full travel cost — the rule must never read as a zeroed TRIP",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: 0, expectedTotalAmount: 0 }),
    0,
    "a genuinely zero request stays zero — the fallback fills an absent number, it does not invent one",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: null, expectedTotalAmount: 237.6 }),
    237.6,
    "a null claim behaves as a missing one",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: -12, expectedTotalAmount: 237.6 }),
    237.6,
    "a negative claim is not a claim — it must not render as a negative total on an employee's card",
  );

  assert.equal(
    outstationClaimedTotal({ claimedTotalAmount: Number.NaN, expectedTotalAmount: 237.6 }),
    237.6,
    "NaN must fall through rather than propagate: `money(NaN)` renders as a broken figure on the portal card",
  );

  // ── The writer: the insert must store the RESOLVED figure ────────────────────

  const service = readFileSync(SERVICE, "utf8");

  assert.ok(
    !/claimed_total_amount:\s*input\.claimedTotalAmount/.test(service),
    "the submit insert must NOT store the raw posted amount — the wizard posts 0 when its estimate has not resolved, and storing that verbatim is what wrote request 72's zero",
  );

  assert.ok(
    /claimed_total_amount:\s*calculation\.claimedTotalAmount/.test(service),
    "the submit insert must store calculation.claimedTotalAmount, which already carries the `posted > 0 ? posted : expected` fallback computed a few lines above it",
  );

  // ── The read mapper: one place, so no surface has to remember ────────────────

  // Deliberately a POSITIVE assertion only. The obvious negative — "the mapper must not contain
  // `numberValue(row.claimed_total_amount)`" — matches the fix itself, because the resolved form
  // passes exactly that expression INTO the helper. A negative that the correct code trips is
  // worse than no negative: it gets "fixed" by weakening the code it was written to protect.
  assert.ok(
    /claimedTotalAmount:\s*outstationClaimedTotal\(/.test(service),
    "the row mapper must resolve through outstationClaimedTotal — that single call is what fixes the portal card, the manager review, the admin table and the XLSX export at once",
  );
}
