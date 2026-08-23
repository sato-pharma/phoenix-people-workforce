// Marketing validation report — pure presentation rules for the Validated / Pending tabs.
//
// Deliberately free of any server import (no Supabase client, no `service.ts`) so the client
// component that renders those tabs can import it directly. Anything here must stay a pure
// function of rows that were already loaded.

import type { MarketingValidationReportRow } from "@/lib/marketing-requests/types";

/** The narrow slice of a report row this module actually reasons about. */
export type InferredHistoryInput = Pick<MarketingValidationReportRow, "inferredFromHistory">;

/**
 * Should a customer on the validation report be labelled "inferred, not GPS field-validated"?
 *
 * The report shows one row per LINK, not per customer, so the badge has to be decided across all
 * of a customer's links at once. The rule is **every**, never **some**.
 *
 * Why it matters in both directions. On 2026-07-02 a backfill script stamped `system_validated`
 * onto 154 links belonging to 82 `ROI-C-…` customers, so the imported historical marketing
 * requests had something to attach to. It was honest about it in its own `validation_notes` — "not
 * GPS field-validated" — but the report labels a row with its link's status, so those 82 read here
 * exactly like a customer a rep photographed this morning, while the customer row behind them is
 * still `pending`, `evidence_status = 'missing'`, with no photo at all. That is the lie this badge
 * exists to stop.
 *
 * Reading it as **some** would create the opposite lie, and a worse one: a customer that carries a
 * real capture alongside an old inferred link would be told nobody ever visited it — calling a rep
 * who actually made the trip a liar. So one genuine capture clears the badge.
 *
 * Zero links is `false`: there is no validation claim on screen for the badge to qualify.
 */
export function isCustomerInferredFromHistory(rows: readonly InferredHistoryInput[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => row.inferredFromHistory);
}
