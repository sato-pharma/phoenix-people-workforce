// Type-only restoration after the recruitment re-platform (PR #1302) deleted this module's
// runtime functions along with the `/api/recruitment/offers` backend they served, but left
// recruitment-workspace.tsx's `import type { OfferLetterVersion }` in place. That backend is
// gone — the offer-letter UI in recruitment-workspace.tsx is currently dead code — so this
// file restores only the type needed to unblock `tsc`, not the removed runtime logic (which
// referenced the pre-re-platform `job_offers`/`recruitment_offer_letters` tables).
export type OfferLetterVersion = {
  id: string;
  offerId: string;
  applicationId: string | null;
  version: number;
  kind: string;
  snapshot: Record<string, unknown>;
  generatedBy: string | null;
  generatedAt: string;
};
