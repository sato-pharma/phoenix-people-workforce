import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The per-rep counters must survive the module being cleaned up (spec E1, extended 2026-08-05).
//
// The counters queried `.in("status", ["held", "expired"])`. On 2026-08-05 the owner ruled twelve
// pharmacies false; their fourteen orders were refused, and every counter went to zero. The page
// reported "No direct order has been held or expired yet — nothing to count" about five District
// Managers who had between them claimed 522,283 EGP on pharmacies that do not exist.
//
// The best possible outcome — the fraud found, refused and closed — erased the record of it. That
// is the same defect the whole module has been correcting all week: the data no longer saying what
// happened, in the direction that hides it.
//
// THE DISTINCTION THAT MATTERS: only orders whose PHARMACY was ruled false may count here. An
// ordinary rejected order is an approver declining a deal on a perfectly real pharmacy. Counting
// those would put every requester who has ever been turned down into a table about phantoms.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "../src/lib/direct-orders/rep-counters.ts";
const TABLE = "../src/components/direct-orders/rep-counters-table.tsx";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderCountersRefusedTests() {
  const service = read(SERVICE);
  const table = read(TABLE);

  // ── Refused orders must be fetched at all ────────────────────────────────────────────────
  assert.match(
    service,
    /\.in\("status", \["held", "expired", "rejected"\]\)/,
    "THE COUNTERS CANNOT SEE A REFUSAL: querying only held and expired means the page goes blank the moment false pharmacies are cleaned up — which is exactly when it is most worth reading",
  );

  // ── But ONLY when the pharmacy itself was ruled false ────────────────────────────────────
  assert.match(
    service,
    /if \(status === "rejected" && !falsePharmacyIds\.has\(pharmacyId\)\) continue;/,
    "AN ORDINARY REJECTED ORDER MUST NOT COUNT: an approver declining a deal on a real pharmacy says nothing about the requester, and counting it would accuse every rep who has ever had an order turned down",
  );
  assert.match(
    service,
    /\.from\("direct_order_pharmacies"\)\.select\("id"\)\.eq\("verification_status", "rejected"\)/,
    "the false-pharmacy set must come from the pharmacies' own verification status, not be inferred from the order",
  );
  // The skip has to happen BEFORE ensure(), or a rep with only ordinary rejections still gets a row.
  assert.ok(
    service.indexOf('if (status === "rejected" && !falsePharmacyIds.has(pharmacyId)) continue;') <
      service.indexOf('const rep = ensure(hrId, String(row.requester_role ?? ""));'),
    "THE SKIP MUST PRECEDE ensure(): otherwise a requester whose only refusal was an ordinary one appears in this table with a row of zeros, which reads as an accusation",
  );

  // ── Distinct pharmacies, not order count ─────────────────────────────────────────────────
  assert.match(
    service,
    /falsePharmaciesByRep/,
    "false pharmacies must be counted as a SET — two orders on one false pharmacy is one pharmacy, and the difference between four small fakes and one large one is the whole character of the finding",
  );

  // ── The sort must not collapse once everything is cleaned up ─────────────────────────────
  assert.match(
    service,
    /const atRisk = \(r: DirectOrderRepCounters\) => r\.heldValue \+ r\.refusedAsFalseValue;/,
    "SORTING ON heldValue ALONE PUTS EVERY REP AT ZERO once the false pharmacies are rejected, which sorts this table alphabetically at exactly the moment it matters most",
  );

  // ── The empty state must mean what it says ───────────────────────────────────────────────
  assert.match(
    service,
    /No direct order has been held, expired, or refused on a false pharmacy/,
    "the empty message must cover refusals too, or it keeps claiming nothing happened after everything did",
  );

  // ── It has to be visible, on both screens ────────────────────────────────────────────────
  assert.match(table, /Refused as false/, "the desktop table must show the column");
  assert.match(table, /False pharmacies/, "the desktop table must show distinct false pharmacies");
  assert.match(
    table,
    /\{row\.refusedAsFalse\} refused as false/,
    "the MOBILE card must show it too — the owner's rule is that mobile gets cards, not a truncated table, and this is the number the card exists to carry once nothing is held",
  );
  assert.match(
    table,
    /refusedAsFalseValue: acc\.refusedAsFalseValue \+ r\.refusedAsFalseValue/,
    "the footer total must include it, or the table's own sum contradicts its rows",
  );

  // ── Scope is still borrowed, never re-implemented ────────────────────────────────────────
  assert.match(
    service,
    /resolveVisibleRequesterHrIds\(access\)/,
    "the counters must keep borrowing the report's scope rule — a second copy of who-can-see-whom is how the two drift apart",
  );
  assert.match(
    service,
    /if \(!inScope\(hrId\)\) continue;/,
    "every row must pass the scope filter before it is counted",
  );
}
