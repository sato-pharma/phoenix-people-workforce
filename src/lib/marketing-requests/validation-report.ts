// Marketing validation report — pure presentation rules for the Validated / Pending tabs.
//
// Deliberately free of any server import (no Supabase client, no `service.ts`) so the client
// component that renders those tabs can import it directly. Anything here must stay a pure
// function of rows that were already loaded.

import type {
  MarketingEvidenceStatus,
  MarketingValidationReportRow,
} from "@/lib/marketing-requests/types";

/**
 * The narrow slice of a report row this module actually reasons about: two notes-derived flags and
 * the two evidence statuses, because they answer different questions and the badge needs both.
 *
 * The flags come from the LINK's `validation_notes`, a sentence written the day the link was
 * created and never rewritten afterwards. The evidence statuses are the CUSTOMER row's and the
 * PHARMACY row's own columns as they stand right now, and both can be filled in long after that
 * sentence was written — a customer has always been completable on a later visit, and since #2352
 * so has a venue. Reading only the flags is therefore reading a claim about the past as though it
 * were a claim about the present.
 */
export type FieldEvidenceGapInput = Pick<
  MarketingValidationReportRow,
  "deskValidated" | "inferredFromHistory"
> & {
  /** The CUSTOMER row's evidence as it stands NOW, not as it stood when the link was written. */
  customerEvidenceStatus: MarketingEvidenceStatus;
  /** The PHARMACY row's evidence as it stands NOW. `complete` means a rep photographed the shop. */
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
};

/**
 * Why a customer's validated status is not field evidence. `null` from the function below means it
 * IS — somebody stood in front of this customer, or in front of the shop it was recorded at.
 *
 * `mixed` exists because one customer really is both: `ROI-C-7986552D8DC1` carries a 2026-07-02
 * backfill link and two desk links after an owner merge on 2026-08-21. Calling that "inferred"
 * would be half wrong, and calling it "desk entry" wrong in the other half.
 */
export type FieldEvidenceGap = "desk" | "inferred" | "mixed";

/**
 * Narrow a report row for the badge. Report rows carry the customer and the pharmacy whole, so
 * both evidence statuses are already on the row and nothing needs loading.
 *
 * This is the one supported way to build the input from a report row, precisely so a screen cannot
 * quietly reintroduce the notes-only reading by hand-assembling the two flags and leaving the
 * evidence out.
 */
export function fieldEvidenceGapInput(row: MarketingValidationReportRow): FieldEvidenceGapInput {
  return {
    customerEvidenceStatus: row.customer.evidenceStatus,
    deskValidated: row.deskValidated,
    inferredFromHistory: row.inferredFromHistory,
    pharmacyEvidenceStatus: row.pharmacy.evidenceStatus,
  };
}

/**
 * Does a real field capture stand behind this ONE link, from EITHER side of it?
 *
 * A link carrying neither marker was written by a live capture and says so in its own notes; that
 * has always counted and still does. The interesting case is a marked link, where the marker
 * records what was true on the day it was written and evidence may have arrived since.
 *
 * **Either half counts, and `complete` is the bar.** Two reasons, and the second is the owner's.
 *
 * First, this badge is a warning that NO field evidence exists, so the thing that cancels it is
 * *some* evidence, not evidence on both halves. The module does hold a stricter both-halves
 * standard — `resolveMarketingSystemValidationStatus`, and the "Waiting for a complete live photo
 * and location on both the customer and the pharmacy" note — but that decides whether a link may be
 * PROMOTED to validated, which is a different question with a different right answer. Borrowing it
 * here would make this function a no-op: in production every marked link is short on one half or
 * the other, so nothing would ever clear.
 *
 * Second, the customer half frequently cannot be redone at all. A doctor is not standing in his
 * pharmacy when the rep calls — the owner's words for it are "they go home" — which is the whole
 * reason #2352 made a venue completable in the first place. Requiring the customer's own capture
 * would leave the badge stuck for ever on rows where every piece of field work that CAN be done has
 * already been done, which is exactly the "unprovable" / "already proven" conflation being fixed.
 *
 * `pending` never counts: it means a coordinate without a live photo, which is precisely the shape
 * a desk validation leaves behind and the reason these rows are badged at all.
 */
function linkHasFieldEvidence(row: FieldEvidenceGapInput): boolean {
  if (!row.inferredFromHistory && !row.deskValidated) return true;
  return row.customerEvidenceStatus === "complete" || row.pharmacyEvidenceStatus === "complete";
}

/**
 * Should a customer on the validation report be labelled "not GPS field-validated", and why?
 *
 * The report shows one row per LINK, not per customer, so the badge has to be decided across all
 * of a customer's links at once. The rule is **every**, never **some**.
 *
 * Why it matters in both directions. On 2026-07-02 a backfill script stamped `system_validated`
 * onto links belonging to `ROI-C-…` customers, so the imported historical marketing requests had
 * something to attach to. It was honest about it in its own `validation_notes` — "not GPS
 * field-validated" — but the report labels a row with its link's status, so those read here exactly
 * like a customer a rep photographed this morning, while the customer row behind them is still
 * `pending`, `evidence_status = 'missing'`, with no photo at all. A DESK validation is the same lie
 * by a different route: an admin picks the location from a map search, the note says "no field GPS
 * or live photo", and in production that covers all 11 `sfe_validated` links.
 *
 * Reading it as **some** would create the opposite lie, and a worse one: a customer that carries a
 * real capture alongside an old inferred link would be told nobody ever visited it — calling a rep
 * who actually made the trip a liar. So one genuine capture clears the badge.
 *
 * That principle is older than this file; what it was missing until 2026-08-23 is that it only ever
 * looked for the genuine capture in the link's NOTE. Evidence that arrived AFTER the note was
 * written was invisible to it, so it went on calling reps liars anyway — see `linkHasFieldEvidence`.
 * Production, the day it was fixed: 15 links across 8 customers carried a complete capture on one
 * half or the other and were badged regardless — 4 desk links on a customer whose two shops were
 * photographed in the field two days after the desk validation, 6 backfilled links whose shops are
 * fully captured, and 5 backfilled links on a customer photographed on site himself. The remaining
 * 299 marked links have nothing complete on either half and stay badged.
 *
 * Zero links is `null`: there is no validation claim on screen for the badge to qualify.
 */
export function customerFieldEvidenceGap(
  rows: readonly FieldEvidenceGapInput[],
): FieldEvidenceGap | null {
  if (rows.length === 0) return null;
  if (rows.some(linkHasFieldEvidence)) return null;
  const anyInferred = rows.some((row) => row.inferredFromHistory);
  const anyDesk = rows.some((row) => row.deskValidated);
  if (anyInferred && anyDesk) return "mixed";
  return anyInferred ? "inferred" : "desk";
}
