/**
 * THE OFFICE GOLDEN RULE — declared, pinned, and locked.
 *
 * The owner set this rule on 2026-08-10 and LOCKED it on 2026-08-11: it may not change again
 * unless he supplies his password. This file is the machine-readable statement of the rule plus
 * the two fingerprints that pin it. The formula itself lives between the
 * `GOLDEN RULE · LOCKED · START/END` markers in `office-allocation.ts`.
 *
 * How the lock works (all three parts have to agree, or CI goes red):
 *   1. SOURCE fingerprint — sha256 of the locked region with comments stripped and whitespace
 *      collapsed. Any edit to the math fires it. Reformatting does not.
 *   2. BEHAVIOUR fingerprint — sha256 of the allocation's exact output over a fixed adversarial
 *      dataset. Any change to what the numbers come out as fires it, even via another file.
 *   3. REQUIRED CLAUSES — the two lines that carry the rule but sit outside the locked region
 *      (the per-line partition and the value-is-derived-last step) must be present verbatim.
 *
 * `tests/office-golden-rule-lock.test.ts` asserts all three. It runs inside `pnpm run test`, which
 * is the required CI `validate` check, so a PR that changes the rule cannot merge.
 *
 * TO CHANGE THE RULE: `pnpm run office-rule:unlock`. It asks for the owner's password, checks it
 * against the scrypt verifier in `office-golden-rule.lock.json`, and only then re-pins the
 * fingerprints. The password is not in this repository in any recoverable form and must not be.
 * Hand-editing the constants below is the one thing this whole mechanism exists to stop.
 */

/** Plain-language statement of the rule, clause by clause. Kept in sync with the pinned code. */
export const OFFICE_GOLDEN_RULE = Object.freeze({
  version: "2026-08-11",
  lockedOn: "2026-08-11",
  lockedBy: "owner",
  summary:
    "Office units are spread across areas by each area's share of that line's non-Office VALUE. " +
    "The units are what gets distributed; the value is derived afterwards.",
  clauses: Object.freeze([
    Object.freeze({
      id: "office-last",
      rule: "Office is imported LAST, after every other distributor for that line and period.",
      why: "The shares are computed from non-Office sales, so they are wrong until the rest is in.",
    }),
    Object.freeze({
      id: "per-line",
      rule: "Weights are built PER OFFICIAL LINE. A product is spread only by its own line's geography.",
      why: "One Office file and one share RPC both carry every line at once. Blending them misplaced 76% of CNS July 2026.",
    }),
    Object.freeze({
      id: "contribution-basis-value",
      rule: "An area's contribution = that area's non-Office VALUE ÷ the line's total non-Office VALUE.",
      why: "Owner's ruling, re-confirmed 2026-08-11: by value, not by units. Units are 4x further from his own closing.",
    }),
    Object.freeze({
      id: "value-is-units-times-master-price",
      rule: "That value is units × the MASTER factory price. The value stored on the row is never used.",
      why: "His words: neglect the values, take units and multiply by factory price in the master database.",
    }),
    Object.freeze({
      id: "one-blended-share",
      rule: "ONE blended area share is applied to EVERY product on the line — never a per-product share.",
      why: "Accepted consequence: a product's office units can land in an area that sold none of it.",
    }),
    Object.freeze({
      id: "distribute-units-not-value",
      rule: "What gets distributed is UNITS. Each product's office units × the area share.",
      why: "His 2026-08-11 change of wording: distribute the units, then multiply by factory price.",
    }),
    Object.freeze({
      id: "value-derived-last",
      rule: "Value is derived last, per allocated slice: value = allocated units × that product's factory price.",
      why: "Same result read two ways, and it keeps the exported value consistent with the exported units.",
    }),
    Object.freeze({
      id: "brick-split-by-units",
      rule: "Inside an area, the slice splits across bricks pro-rata on brick units. Area totals never move.",
      why: "The rows and the rollup key on brick_id. His rule stops at the area; this only lands it on real bricks.",
    }),
    Object.freeze({
      id: "national-fallback",
      rule: "A line with no non-Office sales at all cannot be placed and goes to the NATIONAL bucket.",
      why: "Better a visible unplaced bucket than borrowing another line's geography.",
    }),
  ]),
} as const);

/** The markers that delimit the fingerprinted region inside `office-allocation.ts`. */
export const OFFICE_RULE_LOCK_MARKERS = Object.freeze({
  file: "src/lib/sales/office-allocation.ts",
  start: "GOLDEN RULE · LOCKED · START",
  end: "GOLDEN RULE · LOCKED · END",
} as const);

/**
 * Clauses that live OUTSIDE the locked region (inside `computeOfficeAllocation`) and so need their
 * own verbatim check. Compared after whitespace collapsing, so reformatting is tolerated.
 */
export const OFFICE_RULE_REQUIRED_CLAUSES = Object.freeze([
  Object.freeze({
    clauseId: "distribute-units-not-value",
    snippet: "const slices = allocateProduct( product.units,",
    meaning: "the product's UNITS are what gets spread — not its value",
  }),
  Object.freeze({
    clauseId: "value-derived-last",
    snippet: "const value = round6(slice.units * factoryPrice);",
    meaning: "value is derived from the allocated units, after the split",
  }),
  Object.freeze({
    clauseId: "per-line",
    snippet: "const weightsByLine = buildOfficeAreaWeightsByLine(",
    meaning: "weights are partitioned by official line",
  }),
  Object.freeze({
    clauseId: "value-is-units-times-master-price",
    snippet: "(productCode) => productByCode.get(normalizeCodeKey(productCode))?.factoryPrice ?? 0,",
    meaning: "the weight's value basis is the MASTER factory price",
  }),
] as const);

/**
 * sha256 of the locked region, comments stripped and whitespace collapsed.
 * Re-pinned ONLY by `pnpm run office-rule:unlock`.
 */
export const OFFICE_RULE_SOURCE_FINGERPRINT =
  "115069c09233e093a96db995740973d6822919613a01c1d4e6b16b6f729b19c6";

/**
 * sha256 of the allocation's output over the fixed dataset in `scripts/check-office-golden-rule.ts`.
 * Re-pinned ONLY by `pnpm run office-rule:unlock`.
 */
export const OFFICE_RULE_BEHAVIOUR_FINGERPRINT =
  "7603b7a278f5a48239c4038e15525dd97892ab67e6375d2dd1acd8b59c1577ab";
