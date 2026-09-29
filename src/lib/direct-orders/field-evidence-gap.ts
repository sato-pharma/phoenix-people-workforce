/**
 * "Not GPS field-validated" for a DIRECT-ORDER venue.
 *
 * WHY IT EXISTS. Owner, 2026-09-29, looking at a held order for حضانة د. عبدالكريم السبكى
 * (`DOP-000135`, 86,625 EGP): *"this dop have a photo with no timestamp and loc how come and no
 * option to upload validation is live capture?"* The photo he was looking at was the DISTRIBUTOR
 * INVOICE, which carries no location and no capture time by design — it is a document, taken from
 * the camera OR the gallery (`invoice-evidence.ts` says so in its own header). The venue underneath
 * it had never been captured at all: no photo, no pin, no validation row. Nothing on the order said
 * so, and the invoice sat full width at the top of the screen, exactly where venue evidence would
 * be. That is what made it read as a validation photo with its stamps missing.
 *
 * So this is the direct-order half of `not-field-validated-badge.tsx`, which marketing has had since
 * 2026-08-23, and it makes the same admission in the same words: the line is not a warning and
 * nothing is blocked — the evidence on screen simply must not be read as a field capture.
 *
 * WHAT COUNTS AS FIELD EVIDENCE. One thing only: a claim on the FIELD route that actually carries a
 * live photo AND a GPS fix. Not a decision, not a status — the capture itself. Measured on
 * production the same day, by the very gap this function returns: 130 venues, of which 7 hold a
 * field capture and 123 carry a line — 91 `catalogue`, 31 `hand_entered`, 1 `invoice`. 104 of those
 * 123 read `verified` while nobody had ever stood in front of them, which is the whole reason the
 * line is not gated on the validation stamp.
 *
 * `pending` counts, `rejected` does not. A marketing transfer arrives with a pending field row
 * already holding the rep's photo and pin (`validated-customer-transfer.ts`) — the desk has simply
 * not decided it yet, and calling that venue uncaptured would be false. A rejected claim is the desk
 * saying the capture did not stand, so it is not evidence of anything.
 *
 * Pure, so the three cases are testable without a database.
 */

/** Which kind of gap, so the line can say WHAT is missing rather than only that something is. */
export type DirectOrderFieldEvidenceGap = "catalogue" | "hand_entered" | "invoice";

export type DirectOrderFieldEvidenceGapInput = {
  /**
   * The RAW `direct_order_pharmacies.entry_source`, never the detail screen's two-value mapping —
   * that one folds `marketing_transfer` into `catalogue`, which would tell an approver a
   * hand-captured transfer came off a distributor list.
   */
  entrySource: string | null | undefined;
  /** Does ANY non-rejected claim on this venue carry both a live photo and a GPS fix? */
  hasFieldCapture: boolean;
  /** Is the venue standing on a distributor-invoice claim the desk decided real? */
  validatedByInvoice: boolean;
};

export function directOrderFieldEvidenceGap(
  input: DirectOrderFieldEvidenceGapInput,
): DirectOrderFieldEvidenceGap | null {
  // Somebody stood in front of it with a phone. Whatever else is true of this venue, the line would
  // be a lie — and a false "nobody captured this" is worse than no line at all.
  if (input.hasFieldCapture) return null;
  // Said BEFORE the entry source, because it is the more specific fact: an invoice-validated venue
  // is usually hand-entered too, and "validated by invoice" is what the approver needs to know.
  if (input.validatedByInvoice) return "invoice";
  return String(input.entrySource ?? "") === "catalogue" ? "catalogue" : "hand_entered";
}

/** Short enough to sit on one line beside a status pill on a phone, and never to wrap mid-word. */
export const DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS: Record<DirectOrderFieldEvidenceGap, string> = {
  catalogue: "From the distributor catalogue — not GPS field-validated",
  hand_entered: "Entered by hand — not GPS field-validated",
  invoice: "Validated by invoice — not GPS field-validated",
};

/**
 * The sentence under the label. Precise about what is absent, and it never tells the approver to
 * refuse: the system flags and never blocks, and a venue off the distributor's own catalogue is
 * ordinary business, not a suspicion.
 */
export const DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES: Record<DirectOrderFieldEvidenceGap, string> = {
  catalogue:
    "This venue came from the distributor catalogue — no live photo and no GPS fix was ever taken in front of it. Flagged for your attention, not blocked.",
  hand_entered:
    "This venue was typed in by hand — no live photo and no GPS fix was ever taken in front of it. Flagged for your attention, not blocked.",
  invoice:
    "This venue stands on a distributor invoice. An invoice is a document, so it carries no location and no capture time — no live photo and no GPS fix was ever taken in front of the venue itself. Flagged for your attention, not blocked.",
};
