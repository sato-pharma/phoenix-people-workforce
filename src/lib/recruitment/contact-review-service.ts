// Recruitment / ATS — the DB half of the attended contact-details path (rules: contact-review.ts).
//
// Builds the review queue ("these candidates are unreachable, and their own CV says how to reach
// them") and applies an accepted proposal. Kept apart from contact-review.ts so the decision rules
// stay unit testable without a Supabase client, the same split as cv-auto-apply / cv-intake-service.

import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { listCandidates, updateCandidate } from "@/lib/recruitment/candidates";
import {
  bulkAcceptableProposal,
  isEmptyContactProposal,
  proposeContactDetails,
  type ContactProposal,
} from "@/lib/recruitment/contact-review";
import {
  normalizeStoredExtractionFields,
  type ExtractedCandidateFields,
} from "@/lib/recruitment/cv-extraction-fields";
import { recruitmentDb } from "@/lib/recruitment/db";
import { fetchRowsInBatches } from "@/lib/recruitment/db-batch";

export type ContactReviewRow = {
  candidateId: string;
  name: string;
  source: string | null;
  createdAt: string | null;
  currentEmail: string | null;
  currentPhone: string | null;
  proposal: ContactProposal;
};

type ExtractionRow = {
  candidate_id: unknown;
  extracted_fields?: unknown;
  is_cv?: unknown;
  created_at?: unknown;
};

/**
 * The latest extraction per candidate, for many candidates at once.
 *
 * One `.in()` per 100 ids (see db-batch.ts) and the newest row kept in JS, rather than a
 * per-candidate query — [[every-db-round-trip-crosses-the-atlantic]] and this list is the whole
 * unreachable pool, not one row.
 */
async function latestExtractionByCandidate(
  candidateIds: readonly string[],
): Promise<Map<string, { fields: ExtractedCandidateFields; isCv: boolean | null }>> {
  const result = new Map<
    string,
    { fields: ExtractedCandidateFields; isCv: boolean | null; createdAt: string }
  >();
  if (candidateIds.length === 0) return new Map();

  const supabase = recruitmentDb();
  const rows = await fetchRowsInBatches<ExtractionRow>(candidateIds, (batch) =>
    supabase
      .from("ats_candidate_cv_extractions")
      .select("candidate_id,extracted_fields,is_cv,created_at")
      .in("candidate_id", batch),
  );

  for (const row of rows) {
    const candidateId = String(row.candidate_id ?? "");
    if (!candidateId) continue;
    const createdAt = row.created_at ? String(row.created_at) : "";
    const existing = result.get(candidateId);
    if (existing && existing.createdAt >= createdAt) continue;
    result.set(candidateId, {
      createdAt,
      fields: normalizeStoredExtractionFields(row.extracted_fields),
      // Anything that is not literally a boolean stays null — "nobody judged it", never a verdict.
      isCv: typeof row.is_cv === "boolean" ? row.is_cv : null,
    });
  }

  return new Map(Array.from(result, ([id, value]) => [id, { fields: value.fields, isCv: value.isCv }]));
}

/**
 * Candidates whose record is missing an email or a phone that their own CV extraction can supply.
 *
 * Derived from the candidate columns on every read rather than stored as a queue: once a value is
 * accepted the column is no longer blank, so the row leaves the list by itself. Nothing to keep in
 * sync and nothing that can go stale.
 *
 * Deliberately does NOT write ats_candidate_cv_extractions.applied_fields. That column means "a
 * reviewer saved the whole extraction through the review board" and is what StoredCvExtraction
 * .reviewed reports; stamping it here from a two-field accept would tell the review board a full
 * review had happened when it had not.
 */
export async function listContactReviewQueue(): Promise<ContactReviewRow[]> {
  const candidates = await listCandidates();
  const missing = candidates.filter(
    (candidate) =>
      !String(candidate.email ?? "").trim() || !String(candidate.phone ?? "").trim(),
  );
  if (missing.length === 0) return [];

  const extractions = await latestExtractionByCandidate(missing.map((candidate) => candidate.id));

  const rows: ContactReviewRow[] = [];
  for (const candidate of missing) {
    const extraction = extractions.get(candidate.id);
    if (!extraction) continue;
    const proposal = proposeContactDetails({
      candidate,
      fields: extraction.fields,
      isCv: extraction.isCv,
    });
    if (isEmptyContactProposal(proposal)) continue;
    rows.push({
      candidateId: candidate.id,
      createdAt: candidate.createdAt ?? null,
      currentEmail: candidate.email ?? null,
      currentPhone: candidate.phone ?? null,
      // full_name is not reliably a name — 40% of rows hold the forwarder's whole email envelope,
      // up to 185 characters. candidateDisplayName pulls the sender back out for display.
      name: candidateDisplayName(candidate.fullName),
      proposal,
      source: candidate.source ?? null,
    });
  }
  return rows;
}

export type ContactApplyOutcome = {
  applied: Array<{ candidateId: string; email: string | null; phone: string | null }>;
  skipped: Array<{ candidateId: string; reason: string }>;
  failed: Array<{ candidateId: string; reason: string }>;
};

/**
 * Accept the proposed contact details for the named candidates.
 *
 * The client sends only WHICH candidates to accept — never the values. Every value is re-derived
 * here from the stored extraction, so this route cannot be used to write an arbitrary email or
 * phone onto a candidate, and cannot be replayed against a record whose columns have since been
 * filled (the blank-column gate in proposeContactDetails re-runs on live data).
 *
 * `highConfidenceOnly` is what "accept all" passes: a low-confidence read still deserves a human
 * who opens the CV, so bulk leaves it behind rather than writing it. Anything left behind is
 * REPORTED in `skipped`, never silently dropped — a count that quietly shrinks is how a partial
 * run gets read as a complete one.
 */
export async function applyContactProposals(input: {
  candidateIds: readonly string[];
  highConfidenceOnly: boolean;
}): Promise<ContactApplyOutcome> {
  const outcome: ContactApplyOutcome = { applied: [], failed: [], skipped: [] };
  const wanted = Array.from(new Set(input.candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (wanted.length === 0) return outcome;

  const queue = await listContactReviewQueue();
  const byId = new Map(queue.map((row) => [row.candidateId, row]));

  for (const candidateId of wanted) {
    const row = byId.get(candidateId);
    if (!row) {
      outcome.skipped.push({ candidateId, reason: "No contact details left to accept for this candidate." });
      continue;
    }

    const proposal = input.highConfidenceOnly ? bulkAcceptableProposal(row.proposal) : row.proposal;
    if (isEmptyContactProposal(proposal)) {
      outcome.skipped.push({
        candidateId,
        reason: "Only a low-confidence reading is available — open the CV and accept it individually.",
      });
      continue;
    }

    try {
      // Only the keys actually proposed are sent: `undefined` means "leave this column alone" to
      // updateCandidate, whereas an explicit null would clear it.
      await updateCandidate(candidateId, {
        ...(proposal.email ? { email: proposal.email.value } : {}),
        ...(proposal.phone ? { phone: proposal.phone.value } : {}),
      });
      outcome.applied.push({
        candidateId,
        email: proposal.email?.value ?? null,
        phone: proposal.phone?.value ?? null,
      });
    } catch (error) {
      // A 23505 here is the dedupe index doing its job: this address or number already belongs to
      // another candidate, which is a duplicate to merge, not a value to force in.
      outcome.failed.push({
        candidateId,
        reason: error instanceof Error ? error.message : "Could not save these contact details.",
      });
    }
  }

  return outcome;
}
