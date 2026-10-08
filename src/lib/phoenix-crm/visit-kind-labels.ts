import { VISIT_ASK_KIND_LABELS } from "@/lib/phoenix-crm/visit-ask-rules";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

/**
 * What each visit kind is CALLED, in one place.
 *
 * It lived inside `server/visits.ts` as a private constant until 2026-10-07, when the old CRM's admin
 * reports began printing a Phoenix visit's kind as well (owner: the reports get "everything"). Two
 * copies of this map would let the same visit read "Chain visit" on one report and "chain" on another,
 * so the server module imports it from here rather than keeping its own.
 *
 * `product_manager` deliberately borrows the ASK's wording, so the request a rep sent and the visit it
 * became read alike.
 */
export const PHOENIX_VISIT_KIND_LABELS: Record<PhoenixCrmVisitKind, string> = {
  single: "Single visit",
  double: "Double visit",
  product_manager: VISIT_ASK_KIND_LABELS.product_manager,
  chain: "Chain visit",
};

export function isPhoenixCrmVisitKind(value: unknown): value is PhoenixCrmVisitKind {
  return value === "single" || value === "double" || value === "product_manager" || value === "chain";
}

/** The kind's name, or null for a row that carries no kind at all — a vendor row, or a day activity. */
export function phoenixVisitKindLabel(value: unknown): string | null {
  return isPhoenixCrmVisitKind(value) ? PHOENIX_VISIT_KIND_LABELS[value] : null;
}
