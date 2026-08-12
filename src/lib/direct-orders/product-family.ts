import { RESTRICTED_PRODUCT_CODES, isHeadOfficeLine } from "@/lib/sales/access-scope";

// ─────────────────────────────────────────────────────────────────────────────
// One direct order may carry several products — but only from ONE family, and only from a family
// that is explicitly allowed to have more than one line.
//
// THE ASK (owner, 2026-08-12): "make him able to choose lacto adv 1 and lacto adv 2 [in the same
// request] but this only with lacto". So Lacto Advanced 1 + 2 may share a request; everything else
// stays one product per request, INCLUDING other multi-product families — Tebofortin has seven
// concentrations and Conviban four, and neither is allowed to combine until somebody says so.
//
// THE SCHEMA IS GENERAL, THE POLICY IS NARROW, and that split is deliberate. `direct_order_request_
// items` can hold any number of lines; this module is the single place that decides which families
// may use more than one. Adding Tebofortin later is one entry in MULTI_ITEM_FAMILY_CODES — not a
// migration, and not a hunt through the submit form for a hardcoded "LA".
//
// FAMILY COMES FROM THE CATALOGUE, not from a list here. `source_of_sales_products.family_code` is
// NOT NULL and already groups exactly the way the owner described: LA covers Lacto Advanced 1/2 and
// Lacto Basic 1/2. Re-deriving families from product-name prefixes would be a second definition of
// something the master data already owns.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Families whose products may share one request. Everything absent from this set is one-per-request.
 *
 * `LA` (Lacto) only, per the owner's instruction. The two members a requester can actually reach are
 * LA001 Lacto Advanced 1 and LA002 Lacto Advanced 2 — LA003/LA004 (Lacto Basic) are confidential and
 * removed by `selectableFamilyMembers` below, so "the Lacto family" in the picker is exactly the two
 * concentrations that were asked for.
 */
export const MULTI_ITEM_FAMILY_CODES = ["LA"] as const;

const MULTI_ITEM_SET = new Set<string>(MULTI_ITEM_FAMILY_CODES.map((code) => code.toUpperCase()));

/** Normalised family key. Empty string for a missing family — which never matches anything. */
export function familyKey(familyCode: string | null | undefined): string {
  return String(familyCode ?? "").trim().toUpperCase();
}

/** May this family put more than one product on a single request? */
export function familyAllowsMultipleItems(familyCode: string | null | undefined): boolean {
  const key = familyKey(familyCode);
  return key.length > 0 && MULTI_ITEM_SET.has(key);
}

export type FamilyProduct = {
  productCode: string;
  productName: string;
  familyCode: string;
  line: string;
};

/**
 * The members of a family a requester may actually be offered.
 *
 * BOTH CONFIDENTIALITY MECHANISMS, unconditionally. The codebase has two and neither subsumes the
 * other (pinned by tests/sos-import-dashboard-head-office-lock.test.ts):
 *
 *   - RESTRICTED_PRODUCT_CODES — LA003 / LA004 / SS001, by product code.
 *   - the Head Office LINE — hides a whole line, which carries RY001, a product that is NOT in the
 *     restricted list. A restricted code can also sit on a non-Head-Office line.
 *
 * Applied for EVERY role including CEO and Super Admin, matching `resolveHistoryVisibility` and
 * deliberately stricter than `canViewRestrictedProducts`. This function computes "the rest of this
 * family", which is precisely the shape of question that leaked a restricted product onto an SFE
 * Manager's screen before — a new answer to it must not reopen that.
 */
export function selectableFamilyMembers(
  products: readonly FamilyProduct[],
  familyCode: string | null | undefined,
): FamilyProduct[] {
  const key = familyKey(familyCode);
  if (!key) return [];
  const restricted = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));
  return products
    .filter((product) => familyKey(product.familyCode) === key)
    .filter((product) => !restricted.has(String(product.productCode ?? "").trim().toUpperCase()))
    .filter((product) => !isHeadOfficeLine(product.line))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

export type BasketItem = { productCode: string; familyCode: string };

export type BasketVerdict = { ok: true } | { ok: false; message: string };

/**
 * Is this set of items allowed to be one request?
 *
 * THE RULE, in the order a person would ask it:
 *   1. A request must have at least one item.
 *   2. One item is always fine — that is every direct order raised before today.
 *   3. Several items must all be the SAME family.
 *   4. …and that family must be allow-listed for multiple items.
 *   5. No product twice — two lines for Lacto Advanced 1 is one line entered badly, and silently
 *      summing them would hide a mistake in the money.
 *
 * Returns a MESSAGE rather than a boolean because every one of these refusals is something a
 * requester needs to be told in words. This function is the single definition; the service calls it
 * on submit and on correct-and-resubmit, and the database enforces the same shape independently, so
 * a future writer that forgets this call still cannot store a mixed-family basket.
 */
export function validateDirectOrderBasket(items: readonly BasketItem[]): BasketVerdict {
  if (items.length === 0) return { ok: false, message: "A direct order needs at least one product." };

  const codes = items.map((item) => String(item.productCode ?? "").trim().toUpperCase());
  const duplicate = codes.find((code, index) => codes.indexOf(code) !== index);
  if (duplicate) {
    return { ok: false, message: `${duplicate} is listed twice. Put the whole quantity on one line.` };
  }

  if (items.length === 1) return { ok: true };

  const families = new Set(items.map((item) => familyKey(item.familyCode)));
  if (families.size > 1) {
    return {
      ok: false,
      message:
        "One direct order can only carry products from the same family. Raise a separate order for the others.",
    };
  }

  const [family] = [...families];
  if (!familyAllowsMultipleItems(family)) {
    return {
      ok: false,
      message: `Only one product per direct order for this family. Raise a separate order for each.`,
    };
  }

  return { ok: true };
}
