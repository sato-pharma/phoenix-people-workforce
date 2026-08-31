import assert from "node:assert/strict";

import { RESTRICTED_PRODUCT_CODES, isHeadOfficeLine } from "../src/lib/sales/access-scope.ts";
import {
  familyKey,
  selectableFamilyMembers,
  validateDirectOrderBasket,
  type FamilyProduct,
} from "../src/lib/direct-orders/product-family.ts";

// OWNER RULE (2026-08-27) — "Lacto Advanced and Lacto Basic share family_code; only the LINE
// separates them. Never group on family_code alone — key on (line, family)."
//
// The trap: all four LA00x SKUs carry family_code 'LA'. Grouping sales by family_code alone merges
// Lacto Advanced (Pedia — a TRACKED line) with Lacto Basic (Head Office — NOT tracked, and
// confidential). That is not a rounding error: it drags ~Head-Office-sized value onto a Pedia
// family and crosses the tracked/untracked boundary. The safe key is (line, family).
//
// Production shape, verified live 2026-08-31 against source_of_sales_products:
//   LA001 Lacto Advanced 1 — family "Lacto Advanced" — family_code LA — line Pedia
//   LA002 Lacto Advanced 2 — family "Lacto Advanced" — family_code LA — line Pedia
//   LA003 Lacto Basic 1    — family "Lacto Basic"    — family_code LA — line Head Office
//   LA004 Lacto Basic 2    — family "Lacto Basic"    — family_code LA — line Head Office
//
// NB: the family NAME now differs (Advanced vs Basic); the older note that "all four read
// family='Lacto'" is stale. Only family_code is still shared — which is exactly why family_code is
// the unsafe key and (line, family) is the rule.

type LactoRow = FamilyProduct & { family: string };

const LACTO: readonly LactoRow[] = [
  { productCode: "LA001", productName: "Lacto Advanced 1", family: "Lacto Advanced", familyCode: "LA", line: "Pedia" },
  { productCode: "LA002", productName: "Lacto Advanced 2", family: "Lacto Advanced", familyCode: "LA", line: "Pedia" },
  { productCode: "LA003", productName: "Lacto Basic 1", family: "Lacto Basic", familyCode: "LA", line: "Head Office" },
  { productCode: "LA004", productName: "Lacto Basic 2", family: "Lacto Basic", familyCode: "LA", line: "Head Office" },
];

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export function runLactoLineFamilyGroupingTests() {
  // ── The trap: family_code is shared across all four ─────────────────────────
  assert.equal(
    new Set(LACTO.map((p) => familyKey(p.familyCode))).size,
    1,
    "all four Lacto SKUs share family_code 'LA' — this is the shared key that makes grouping on it alone unsafe",
  );

  // ── Grouping on family_code ALONE is the bug: one bucket, mixing two lines ───
  const byFamilyCode = groupBy(LACTO, (p) => familyKey(p.familyCode));
  assert.equal(byFamilyCode.size, 1, "family_code alone collapses all four SKUs into a single bucket");
  const linesInFamilyCodeBucket = new Set([...byFamilyCode.values()][0].map((p) => p.line));
  assert.ok(
    linesInFamilyCodeBucket.has("Pedia") && linesInFamilyCodeBucket.has("Head Office"),
    "that single family_code bucket wrongly mixes Pedia (tracked) with Head Office (untracked) — the exact merge the rule forbids",
  );

  // ── Keying on (line, family) is the rule: two single-line buckets ───────────
  const byLineFamily = groupBy(LACTO, (p) => `${p.line}::${p.family}`);
  assert.equal(byLineFamily.size, 2, "keying on (line, family) separates Lacto Advanced from Lacto Basic");
  for (const [key, rows] of byLineFamily) {
    assert.equal(new Set(rows.map((r) => r.line)).size, 1, `bucket ${key} must contain exactly one line`);
  }
  assert.deepEqual(
    [...byLineFamily.keys()].sort(),
    ["Head Office::Lacto Basic", "Pedia::Lacto Advanced"],
    "the two safe buckets are (Pedia, Lacto Advanced) and (Head Office, Lacto Basic)",
  );

  // ── Real shipped code: the ONE path that keys on family_code is line-safe ────
  // selectableFamilyMembers is the single place a family_code drives selection. It stays line-safe
  // by filtering the Head Office line and the restricted codes, so the Lacto family it offers is
  // exactly the two Pedia concentrations — never the Head Office pair.
  assert.ok(
    RESTRICTED_PRODUCT_CODES.includes("LA003") && RESTRICTED_PRODUCT_CODES.includes("LA004"),
    "LA003/LA004 must be in the restricted set (one of the two mechanisms that keep the Lacto picker line-safe)",
  );
  assert.ok(isHeadOfficeLine("Head Office"), "the Head Office line must be recognised (the other mechanism)");
  const offered = selectableFamilyMembers(LACTO, "LA").map((p) => p.productCode);
  assert.deepEqual(
    offered,
    ["LA001", "LA002"],
    "selectableFamilyMembers('LA') must offer only the Pedia pair — never the Head Office / Lacto Basic pair",
  );

  // ── Why the picker gate is load-bearing: family_code alone accepts a cross-line basket ──
  // validateDirectOrderBasket checks family_code SAMENESS only. LA002 (Pedia) and LA004 (Head Office)
  // share family_code 'LA', so it would accept them as one basket. The ONLY thing that prevents that
  // pairing in practice is selectableFamilyMembers never offering LA004 — proof that family_code is
  // not, by itself, a line-safe key.
  const crossLineSameFamilyCode = validateDirectOrderBasket([
    { productCode: "LA002", familyCode: "LA" },
    { productCode: "LA004", familyCode: "LA" },
  ]);
  assert.equal(
    crossLineSameFamilyCode.ok,
    true,
    "family_code alone accepts LA002 (Pedia) + LA004 (Head Office) — the line filter in the picker, not family_code, is what keeps Lacto line-safe",
  );
}
