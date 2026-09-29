import {
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS,
  DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES,
  type DirectOrderFieldEvidenceGap,
} from "@/lib/direct-orders/field-evidence-gap";

/**
 * "Nobody has stood in front of this venue" — the line on a direct-order approval window.
 *
 * Owner, 2026-09-29. He opened a held order and saw a photo carrying no time and no location, and
 * asked how that was possible when validation is a live capture. It was possible because the photo
 * was the DISTRIBUTOR INVOICE, which is a document by design, while the venue under it had never
 * been captured at all — and the screen said neither thing. The invoice sits full width at the top,
 * exactly where venue evidence would be, so its missing stamps read as a broken capture rather than
 * as a different kind of evidence entirely.
 *
 * Sits directly under `ValidatedEvidenceLink`, and the two are deliberately not exclusive: a venue
 * can be validated — by invoice, or off the distributor catalogue — and still hold no field capture.
 * Reading "Validated by the system" with nothing beside it is what let that gap stay invisible.
 *
 * NEUTRAL, not a warning colour, and the same decision `NotFieldValidatedBadge` made for marketing:
 * nothing is broken and nothing is blocked. A venue off the distributor's own catalogue is ordinary
 * business — 91 of the 123 uncaptured venues in production on the day this was written. The line
 * exists so the evidence on screen is not read as something it is not.
 *
 * Square edges and a wrapping sentence: the house rules. No `whitespace-nowrap` and no truncation —
 * the sentences are long on purpose, and on a phone they wrap rather than scroll or ellipsise.
 */
export function NotFieldValidatedLine({ gap }: { gap: DirectOrderFieldEvidenceGap }) {
  return (
    <div className="border border-slate-300 bg-slate-50 px-3 py-2">
      <p className="flex flex-wrap items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-600">
        <span aria-hidden className="inline-block h-1.5 w-1.5 bg-slate-400" />
        {DIRECT_ORDER_FIELD_EVIDENCE_GAP_LABELS[gap]}
      </p>
      <p className="mt-1 text-phx-sm font-semibold text-slate-700">
        {DIRECT_ORDER_FIELD_EVIDENCE_GAP_SENTENCES[gap]}
      </p>
    </div>
  );
}
