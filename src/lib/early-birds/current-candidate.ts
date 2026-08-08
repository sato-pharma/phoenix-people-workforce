// Which candidate is the District Manager currently being asked about?
//
// There is deliberately NO "current candidate" column anywhere in the schema. The answer is DERIVED
// from the decision ledger: the eligible candidate with the lowest rank that carries no decision
// row. That is what makes the reject-and-fall-through mechanic incapable of desyncing, and what
// makes a rejected candidate impossible to resurrect — his decision row is permanent, so he is
// skipped forever without anything having to remember that he was skipped.
//
// This rule exists twice: here (for display) and inside phx_decide_early_birds_candidate (which is
// authoritative). This repo cannot test SQL, so the duplication is real and bounded by the RPC
// returning `stale_candidate` whenever the two disagree — drift surfaces as a visible error rather
// than a wrong write.

export type EarlyBirdsCandidateRow = {
  id: string;
  /** 1..M over eligible candidates only; null for an ineligible rep, who is never offered. */
  candidateRank: number | null;
  eligible: boolean;
};

export type EarlyBirdsDecisionRow = {
  candidateId: string;
  decisionStatus: "approved" | "rejected";
};

export type EarlyBirdsCurrentCandidate = {
  candidate: { id: string; candidateRank: number } | null;
  rejectedCount: number;
  /** True only when every eligible candidate was REJECTED. An approval is not exhaustion. */
  exhausted: boolean;
  approvedCandidateId: string | null;
};

export function resolveCurrentEarlyBirdsCandidate(
  candidates: readonly EarlyBirdsCandidateRow[],
  decisions: readonly EarlyBirdsDecisionRow[],
): EarlyBirdsCurrentCandidate {
  const decisionByCandidate = new Map<string, EarlyBirdsDecisionRow["decisionStatus"]>();
  for (const decision of decisions) decisionByCandidate.set(decision.candidateId, decision.decisionStatus);

  const approved = decisions.find((decision) => decision.decisionStatus === "approved") ?? null;
  const rejectedCount = decisions.filter((decision) => decision.decisionStatus === "rejected").length;

  // Once someone is approved the period is settled — there is no next candidate to offer.
  if (approved) {
    return { candidate: null, rejectedCount, exhausted: false, approvedCandidateId: approved.candidateId };
  }

  const offerable = candidates
    .filter((candidate) => candidate.eligible && candidate.candidateRank !== null)
    .sort((a, b) => (a.candidateRank as number) - (b.candidateRank as number));

  // By RANK, not by decision arrival order: a decision written out of order (only reachable via a
  // bad manual write) must not make the module skip an undecided higher-ranked rep.
  const next = offerable.find((candidate) => !decisionByCandidate.has(candidate.id)) ?? null;

  return {
    candidate: next ? { id: next.id, candidateRank: next.candidateRank as number } : null,
    rejectedCount,
    exhausted: next === null && offerable.length > 0,
    approvedCandidateId: null,
  };
}
