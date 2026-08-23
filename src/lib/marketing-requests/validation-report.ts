// Marketing validation report — pure presentation rules for the Validated / Pending tabs.
//
// Deliberately free of any server import (no Supabase client, no `service.ts`) so the client
// component that renders those tabs can import it directly. Anything here must stay a pure
// function of rows that were already loaded.

import type { MarketingValidationReportRow } from "@/lib/marketing-requests/types";

/** The narrow slice of a report row this module actually reasons about. */
export type FieldEvidenceGapInput = Pick<
  MarketingValidationReportRow,
  "deskValidated" | "inferredFromHistory"
>;

/**
 * Why a customer's validated status is not field evidence. `null` from the function below means it
 * IS — somebody stood in front of this customer.
 *
 * `mixed` exists because one customer really is both: `ROI-C-7986552D8DC1` carries a 2026-07-02
 * backfill link and two desk links after an owner merge on 2026-08-21. Calling that "inferred"
 * would be half wrong, and calling it "desk entry" wrong in the other half.
 */
export type FieldEvidenceGap = "desk" | "inferred" | "mixed";

/**
 * Should a customer on the validation report be labelled "not GPS field-validated", and why?
 *
 * The report shows one row per LINK, not per customer, so the badge has to be decided across all
 * of a customer's links at once. The rule is **every**, never **some**.
 *
 * Why it matters in both directions. On 2026-07-02 a backfill script stamped `system_validated`
 * onto 154 links belonging to 82 `ROI-C-…` customers, so the imported historical marketing
 * requests had something to attach to. It was honest about it in its own `validation_notes` — "not
 * GPS field-validated" — but the report labels a row with its link's status, so those 82 read here
 * exactly like a customer a rep photographed this morning, while the customer row behind them is
 * still `pending`, `evidence_status = 'missing'`, with no photo at all. A DESK validation is the
 * same lie by a different route: an admin picks the location from a map search, the note says "no
 * field GPS or live photo", and in production that covers all 11 `sfe_validated` links — five of
 * whose customers hold a coordinate and no photo, which reads as field-proven and is not.
 *
 * Reading it as **some** would create the opposite lie, and a worse one: a customer that carries a
 * real capture alongside an old inferred link would be told nobody ever visited it — calling a rep
 * who actually made the trip a liar. So one genuine capture clears the badge.
 *
 * Zero links is `null`: there is no validation claim on screen for the badge to qualify.
 */
export function customerFieldEvidenceGap(
  rows: readonly FieldEvidenceGapInput[],
): FieldEvidenceGap | null {
  if (rows.length === 0) return null;
  if (!rows.every((row) => row.inferredFromHistory || row.deskValidated)) return null;
  const anyInferred = rows.some((row) => row.inferredFromHistory);
  const anyDesk = rows.some((row) => row.deskValidated);
  if (anyInferred && anyDesk) return "mixed";
  return anyInferred ? "inferred" : "desk";
}
