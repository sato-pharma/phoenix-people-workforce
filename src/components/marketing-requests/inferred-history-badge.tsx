/**
 * Shown on a customer whose validation came from the 2026-07-02 history backfill, not from a rep.
 *
 * Both marketing screens that show a validation status read it off the customer↔pharmacy LINK, not
 * off the customer. That backfill wrote `system_validated` onto 154 links across 82 `ROI-C-…`
 * customers so the imported historical marketing requests had something to attach to. Those
 * customers are still `pending`, `evidence_status = 'missing'`, with no photo and no GPS fix —
 * nobody has ever stood in front of them — yet they read exactly like a customer a rep photographed
 * this morning. On the Customer Database the effect is starkest: the status column says
 * "system validated" while the evidence-photo column beside it is empty.
 *
 * The script was honest in its own `validation_notes` ("not GPS field-validated") and the Customer
 * Pharmacy Mapping page has always shown that; this is the same admission, in the same words, on
 * the screens where the claim is actually made.
 *
 * ONE component, imported by every screen that needs it — the whole point is that these cannot
 * disagree. Deliberately neutral rather than a warning colour: nothing is broken and nothing is
 * blocked, the label simply must not be read as field evidence.
 */
export function InferredHistoryBadge() {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-sm border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600"
      title="Inferred from historical marketing requests — no rep captured this customer on site"
    >
      Inferred — not GPS field-validated
    </span>
  );
}
