// The lines a correction of a RETURNED direct order carries beyond its first one. Pure — no
// database, no access context — so the rule is tested on its own and `reviseDirectOrder` only feeds it
// the stored lines and the caller's request.

import type { DirectOrderDealType, DirectOrderRequestItem } from "@/lib/direct-orders/types";

/** One extra line a caller asked for. Mirrors `DirectOrderItemInput` in service.ts. */
export type CorrectionExtraLineInput = {
  productCode: string;
  qty: number;
  dealType?: DirectOrderDealType;
  bonus?: number;
  discountPct?: number | null;
};

export type CorrectionExtraLines =
  | { ok: true; items: CorrectionExtraLineInput[] }
  | { ok: false; message: string };

/**
 * 🔴 A CORRECTION KEEPS EVERY PRODUCT ALREADY ON THE ORDER (code review, 19 Oct 2026).
 *
 * The correction form sent the first line's fields and nothing else, the revise route forwarded no
 * lines, and `reviseDirectOrder` rebuilt the basket as `[line 1, ...(input.items ?? [])]` — so a
 * returned Lacto Advanced 1 + Lacto Advanced 2 order (86,625 EGP) would have gone back to its approver
 * as Lacto Advanced 1 alone (49,500 EGP), the second line deleted with no warning and no trace.
 *
 * The products are the order's identity, exactly as the first line's product is: a correction edits
 * each line's quantity and deal, never which products the order holds.
 *   - `sent` absent (an older screen, any caller that never knew about lines): every stored extra line
 *     is kept as it is, so nothing is ever dropped by omission.
 *   - `sent` present: it must name each stored extra product exactly once. A product not on the order,
 *     the first line's product again, a repeat, or a stored product left out is refused in words —
 *     adding or removing a product is a different order.
 * The answer is in the stored line order, so line numbers do not move under a correction.
 */
export function resolveCorrectionExtraLines(input: {
  headProductCode: string;
  storedExtras: readonly Pick<
    DirectOrderRequestItem,
    "productCode" | "productName" | "qty" | "dealType" | "bonus" | "discountPct"
  >[];
  sent: readonly CorrectionExtraLineInput[] | undefined;
}): CorrectionExtraLines {
  const { headProductCode, storedExtras, sent } = input;

  if (sent === undefined) {
    return {
      ok: true,
      items: storedExtras.map((line) => ({
        productCode: line.productCode,
        qty: line.qty,
        dealType: line.dealType,
        bonus: line.bonus,
        discountPct: line.discountPct,
      })),
    };
  }

  const stored = new Map(storedExtras.map((line) => [line.productCode, line]));
  const byCode = new Map<string, CorrectionExtraLineInput>();
  for (const item of sent) {
    const code = String(item.productCode ?? "").trim();
    if (code === headProductCode || byCode.has(code)) {
      const name = stored.get(code)?.productName ?? "A product";
      return { ok: false, message: `${name} appears twice in this correction. Each product on the order is corrected once.` };
    }
    if (!stored.has(code)) {
      return {
        ok: false,
        message: "A correction cannot add a product to this order. To order another product, raise a new order.",
      };
    }
    byCode.set(code, { ...item, productCode: code });
  }

  const missing = storedExtras.filter((line) => !byCode.has(line.productCode));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${missing.map((line) => line.productName).join(" and ")} ${
        missing.length === 1 ? "is" : "are"
      } missing from this correction. A correction keeps every product already on the order — reload the page and try again.`,
    };
  }

  return { ok: true, items: storedExtras.map((line) => byCode.get(line.productCode) as CorrectionExtraLineInput) };
}
