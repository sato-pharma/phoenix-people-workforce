// ─────────────────────────────────────────────────────────────────────────────
// Overlap detection — the double-count guard.
//
// Attribution matches on exact distributor + pharmacy code + product + period. Nothing in that
// rule is exclusive, so when two requests target the same pharmacy and the same product over
// overlapping ROI windows, the SAME invoice lines are credited to BOTH. Each shows a healthy
// return; the company counts one sale twice.
//
// This is not hypothetical. Measured on production 2026-07-29: 89 overlapping pairs across 37
// requests, 42 pharmacies and 9 products — EGP 185,000 of spend in the six worst alone.
//
// Detection is deliberately separate from any decision about what to DO. Whether an overlap
// blocks, warns, or splits the credit is a business rule the owner sets; this module only answers
// "does this request contest invoice lines with another one, and which".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statuses whose money is not committed, so they cannot contest anything.
 *
 * Exported because it is also the right exclusion set for any "what have we already spent on this
 * customer" figure: an abandoned draft and a refused request are not spend, and counting them
 * inflates the number an approver weighs the next request against.
 */
export const INERT_MARKETING_REQUEST_STATUSES: ReadonlySet<string> = new Set(["draft", "rejected"]);

export type OverlapCandidate = {
  requestId: string;
  requestCode: string;
  status: string;
  payDate: string | null;
  roiDurationMonths: number;
  pharmacyIds: string[];
  productIds: number[];
};

export type RequestOverlap = {
  requestId: string;
  requestCode: string;
  status: string;
  /** Pharmacy ids claimed by both requests. */
  sharedPharmacyIds: string[];
  /** Product ids claimed by both requests. */
  sharedProductIds: number[];
  /** The months both measurement windows cover — where the double count actually happens. */
  overlappingMonths: string[];
};

/** Inclusive month list for a window, or [] when the request has no pay date yet. */
export function windowMonths(payDate: string | null, durationMonths: number): string[] {
  if (!payDate) return [];
  const start = payDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start)) return [];
  const months: string[] = [];
  const [yearRaw, monthRaw] = start.split("-");
  let year = Number(yearRaw);
  let month = Number(monthRaw);
  for (let i = 0; i < Math.max(1, durationMonths); i += 1) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Which existing requests contest invoice lines with `subject`.
 *
 * An overlap needs ALL THREE to intersect — pharmacy, product and month. Any two alone are
 * harmless: the same pharmacy for different products, or the same product in a different month,
 * attribute different rows and double-count nothing. Requiring all three is what keeps this from
 * crying wolf on every request that happens to share a customer.
 */
export function findRequestOverlaps(subject: OverlapCandidate, others: OverlapCandidate[]): RequestOverlap[] {
  const subjectMonths = new Set(windowMonths(subject.payDate, subject.roiDurationMonths));
  if (subjectMonths.size === 0 || subject.pharmacyIds.length === 0 || subject.productIds.length === 0) return [];

  const subjectPharmacies = new Set(subject.pharmacyIds);
  const subjectProducts = new Set(subject.productIds);

  const overlaps: RequestOverlap[] = [];
  for (const other of others) {
    if (other.requestId === subject.requestId) continue;
    if (INERT_MARKETING_REQUEST_STATUSES.has(other.status)) continue;

    const sharedPharmacyIds = other.pharmacyIds.filter((id) => subjectPharmacies.has(id));
    if (sharedPharmacyIds.length === 0) continue;

    const sharedProductIds = other.productIds.filter((id) => subjectProducts.has(id));
    if (sharedProductIds.length === 0) continue;

    const overlappingMonths = windowMonths(other.payDate, other.roiDurationMonths).filter((month) =>
      subjectMonths.has(month),
    );
    if (overlappingMonths.length === 0) continue;

    overlaps.push({
      overlappingMonths,
      requestCode: other.requestCode,
      requestId: other.requestId,
      sharedPharmacyIds,
      sharedProductIds,
      status: other.status,
    });
  }
  return overlaps;
}

/** One human sentence per overlap — the UI must never print raw ids at a requester. */
export function describeOverlap(overlap: RequestOverlap): string {
  const months =
    overlap.overlappingMonths.length === 1
      ? overlap.overlappingMonths[0]
      : `${overlap.overlappingMonths[0]} to ${overlap.overlappingMonths[overlap.overlappingMonths.length - 1]}`;
  return `${overlap.requestCode} already measures ${overlap.sharedPharmacyIds.length} of these pharmacies on ${overlap.sharedProductIds.length} of these products during ${months}. The same sales would be counted for both requests.`;
}
