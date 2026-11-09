import {
  customerFieldEvidenceGap,
  type FieldEvidenceGap,
  type FieldEvidenceGapInput,
} from "@/lib/marketing-requests/validation-report";

/** Deliberately short: the badge sits beside a status pill in a wide table and must never wrap. */
const LABELS: Record<FieldEvidenceGap, string> = {
  desk: "Desk entry — not GPS field-validated",
  inferred: "Inferred — not GPS field-validated",
  mixed: "Not GPS field-validated",
  second_code: "Backfilled — not GPS field-validated",
};

/**
 * Wider than the labels because a tooltip has no width budget, and precise about WHAT is missing:
 * the badge only renders once neither the customer nor its shop holds a complete capture, so
 * "nobody captured this customer" would now understate what the row is actually short of.
 */
const TITLES: Record<FieldEvidenceGap, string> = {
  desk: "Entered at a desk from a map search — no complete field capture on this customer or on its shop",
  inferred: "Inferred from historical marketing requests — no complete field capture on this customer or on its shop",
  mixed: "Part inferred from history, part desk-entered — no complete field capture on this customer or on its shop",
  second_code:
    "A second distributor code added on 2026-09-08, its status copied from this customer's other link to the same shop — no complete field capture on this customer or on its shop",
};

/**
 * Shown on a customer whose "validated" status was never earned by a rep standing in front of it.
 *
 * Both marketing screens that show a validation status read it off the customer↔pharmacy LINK, not
 * off the customer — and that table carries no location, photo, or evidence column at all. Two
 * different things land there with no field evidence behind them, and until 2026-08-23 only the
 * first of them was labelled:
 *
 *   - `inferred` — the 2026-07-02 backfill wrote `system_validated` onto 154 links across 82
 *     `ROI-C-…` customers so the imported historical marketing requests had something to attach to.
 *     Those customers are still `pending`, `evidence_status = 'missing'`, no photo and no GPS fix.
 *   - `desk` — an admin validated on someone's behalf and picked the location from a map search.
 *     In production this is 11 links across 6 customers, which is EVERY `sfe_validated` link there
 *     is. Five of those customers hold a coordinate and no photo, so on the Customer Database they
 *     read as field-proven while the coordinate came off a map, not off a phone in the street.
 *   - `second_code` — added 2026-09-17. The 2026-09-08 hand backfill wrote 81 links adding a
 *     second distributor code onto pairings that already existed, copying each pairing's status.
 *     Its note never said "no field evidence", so every one read as a live capture and cleared the
 *     badge for 39 customers. It names its own reason only when no inferred or desk link is in view,
 *     because otherwise that link's origin IS its origin.
 *
 * The first two writers were honest in their own `validation_notes`; this is the same admission, in
 * the same words, on the screens where the claim is actually made.
 *
 * What those notes CANNOT say is what happened afterwards. They are written once and never
 * rewritten, while a capture can arrive later on either half — a customer has always been
 * completable on a second visit, and since #2352 so has a venue. So the badge is decided from the
 * live evidence columns as well as the notes, and one complete capture on either half retires it.
 * See `linkHasFieldEvidence` for why either half is enough and why `pending` is not.
 *
 * ONE component, imported by every screen that needs it — the whole point is that these cannot
 * disagree. Deliberately neutral rather than a warning colour: nothing is broken and nothing is
 * blocked, the label simply must not be read as field evidence.
 */
export function NotFieldValidatedBadge({ reason }: { reason: FieldEvidenceGap }) {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-sm border border-slate-300 bg-slate-100 px-2 py-0.5 text-phx-sm font-bold uppercase tracking-wide text-slate-600"
      title={TITLES[reason]}
    >
      {LABELS[reason]}
    </span>
  );
}

/**
 * The same badge for a screen whose row IS a single link, so the gap is decided over that one link.
 * Renders nothing when the link does carry field evidence, which lets a caller drop it in unguarded
 * where an extra `null` child costs nothing.
 */
export function LinkFieldEvidenceBadge({ link }: { link: FieldEvidenceGapInput }) {
  const gap = customerFieldEvidenceGap([link]);
  return gap ? <NotFieldValidatedBadge reason={gap} /> : null;
}
