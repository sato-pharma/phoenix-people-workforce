import assert from "node:assert/strict";

import { buildEarlyBirdsCandidateKey } from "../src/lib/early-birds/candidate-key.ts";
import {
  resolveCurrentEarlyBirdsCandidate,
  type EarlyBirdsCandidateRow,
  type EarlyBirdsDecisionRow,
} from "../src/lib/early-birds/current-candidate.ts";
import {
  EARLY_BIRDS_AUTO_APPROVE_AFTER_DAYS,
  EARLY_BIRDS_BACKFILL_PERIODS,
  EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES,
  earlyBirdsAutoApproveDueAtIso,
  isEarlyBirdsAutoApproveDue,
  isEarlyBirdsNationalCrownDue,
  resolveDueEarlyBirdsPeriods,
} from "../src/lib/early-birds/schedule.ts";

// The reject-and-fall-through mechanic, and the scheduler that fires it.
//
// The design property under test: there is NO "current candidate" column. The answer is derived
// from the decision ledger every time, which is what makes it impossible for the offer to desync
// from the decisions and impossible for a rejected rep to be offered again.

const candidates: EarlyBirdsCandidateRow[] = [
  { id: "c1", candidateRank: 1, eligible: true },
  { id: "c2", candidateRank: 2, eligible: true },
  { id: "c3", candidateRank: 3, eligible: true },
  { id: "x1", candidateRank: null, eligible: false },
];

const reject = (candidateId: string): EarlyBirdsDecisionRow => ({ candidateId, decisionStatus: "rejected" });
const approve = (candidateId: string): EarlyBirdsDecisionRow => ({ candidateId, decisionStatus: "approved" });

export function runEarlyBirdsDecisionTests() {
  // ── The fall-through chain ──────────────────────────────────────────────────────
  {
    assert.equal(resolveCurrentEarlyBirdsCandidate(candidates, []).candidate?.id, "c1", "rank 1 is offered first");

    const afterOne = resolveCurrentEarlyBirdsCandidate(candidates, [reject("c1")]);
    assert.equal(afterOne.candidate?.id, "c2", "rejecting #1 offers #2");
    assert.equal(afterOne.rejectedCount, 1);

    assert.equal(
      resolveCurrentEarlyBirdsCandidate(candidates, [reject("c1"), reject("c2")]).candidate?.id,
      "c3",
      "and so on down the ranking",
    );
  }

  // ── A rejected candidate can never come back ────────────────────────────────────
  {
    const decisions = [reject("c1"), reject("c2"), reject("c3")];
    const result = resolveCurrentEarlyBirdsCandidate(candidates, decisions);
    assert.equal(result.candidate, null, "every eligible rep has been decided");
    assert.equal(result.exhausted, true);
    assert.equal(result.rejectedCount, 3);
    // Re-deriving from the same permanent ledger can never resurrect anyone.
    assert.equal(resolveCurrentEarlyBirdsCandidate(candidates, decisions).candidate, null);
  }

  // ── Approved is NOT exhausted ───────────────────────────────────────────────────
  {
    const result = resolveCurrentEarlyBirdsCandidate(candidates, [reject("c1"), approve("c2")]);
    assert.equal(result.candidate, null, "there is nothing left to ask once someone is crowned");
    assert.equal(
      result.exhausted,
      false,
      "conflating approved with exhausted makes the UI say 'nobody qualified' directly beside a crowned winner",
    );
    assert.equal(result.approvedCandidateId, "c2");
  }

  // ── Ineligible reps are never offered ───────────────────────────────────────────
  {
    const result = resolveCurrentEarlyBirdsCandidate(candidates, [reject("c1"), reject("c2"), reject("c3")]);
    assert.equal(result.candidate, null, "the ineligible rep must not be offered as a last resort");
  }

  // ── Derivation is by RANK, not by decision arrival order ────────────────────────
  {
    const result = resolveCurrentEarlyBirdsCandidate(candidates, [reject("c3")]);
    assert.equal(
      result.candidate?.id,
      "c1",
      "a decision written out of order must not make the module skip an undecided higher-ranked rep",
    );
  }

  // ── Scheduler: what is due to close ─────────────────────────────────────────────
  {
    const open = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-10",
      minutesSinceMidnight: 600,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(
      open.some((period) => period.periodKey === "2026-08-H1"),
      false,
      "the period you are standing in is not closed and must never be snapshotted",
    );

    const due = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-16",
      minutesSinceMidnight: 600,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(due[0]?.periodKey, "2026-08-H1", "the fortnight that just ended is due the next day");

    const alreadyDone = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-16",
      minutesSinceMidnight: 600,
      snapshottedPeriodKeys: new Set(["2026-08-H1"]),
    });
    assert.equal(
      alreadyDone.some((period) => period.periodKey === "2026-08-H1"),
      false,
      "a period with a live snapshot is never due again — the database is the marker, so a restart cannot double-close",
    );
  }

  // ── The 03:00 gate, and why it only applies on the first day after close ────────
  {
    const tooEarly = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-16",
      minutesSinceMidnight: EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES - 1,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(
      tooEarly.some((period) => period.periodKey === "2026-08-H1"),
      false,
      "before 03:00 Cairo the final day's late saves may still be arriving",
    );

    const atGate = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-16",
      minutesSinceMidnight: EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(atGate[0]?.periodKey, "2026-08-H1", "at 03:00 it is due");

    const backfill = resolveDueEarlyBirdsPeriods({
      todayIso: "2026-08-25",
      minutesSinceMidnight: 0,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(
      backfill.some((period) => period.periodKey === "2026-08-H1"),
      true,
      "a period that closed nine days ago is settled — making a backfill wait for 03:00 delays recovery for no benefit",
    );
  }

  // ── Backfill is bounded, and the due-check is idempotent ────────────────────────
  {
    const due = resolveDueEarlyBirdsPeriods({
      todayIso: "2027-01-05",
      minutesSinceMidnight: 600,
      snapshottedPeriodKeys: new Set(),
    });
    assert.equal(
      due.length,
      EARLY_BIRDS_BACKFILL_PERIODS,
      "a cold start heals a bounded window — silently minting a five-month-old winner nobody was asked about is worse than leaving a hole",
    );

    const settled = new Set(due.map((period) => period.periodKey));
    assert.deepEqual(
      resolveDueEarlyBirdsPeriods({ todayIso: "2027-01-05", minutesSinceMidnight: 600, snapshottedPeriodKeys: settled }),
      [],
      "feeding the results back in makes the next call a no-op",
    );
  }

  // ── Auto-approve five days after the MANAGER WAS ASKED ──────────────────────────
  {
    assert.equal(EARLY_BIRDS_AUTO_APPROVE_AFTER_DAYS, 5);
    assert.equal(earlyBirdsAutoApproveDueAtIso("2026-08-16T03:00:00Z"), "2026-08-21");
    assert.equal(
      isEarlyBirdsAutoApproveDue({ computedAtIso: "2026-08-16T03:00:00Z", todayIso: "2026-08-20" }),
      false,
      "the manager still has time",
    );
    assert.equal(
      isEarlyBirdsAutoApproveDue({ computedAtIso: "2026-08-16T03:00:00Z", todayIso: "2026-08-21" }),
      true,
      "on day five rank #1 is crowned regardless — a rep must never lose his award to his manager's inaction",
    );
  }

  // ── A BACKFILLED fortnight must not self-crown the instant it is created ────────
  {
    // The real incident: on 2026-08-09 the first sweep closed 2026-07-H2, whose period-end deadline
    // (2026-08-05) had already passed — so four districts auto-crowned in the same tick that created
    // them and no manager was ever asked. Irreversible by design, because a recompute is refused
    // once a winner exists.
    assert.equal(
      isEarlyBirdsAutoApproveDue({ computedAtIso: "2026-08-09T00:32:39Z", todayIso: "2026-08-09" }),
      false,
      "a fortnight backfilled today gives its manager five days from TODAY — measuring from the period end crowns it before he was ever asked",
    );
    assert.equal(
      isEarlyBirdsAutoApproveDue({ computedAtIso: "2026-08-09T00:32:39Z", todayIso: "2026-08-14" }),
      true,
      "and it does auto-approve once he has genuinely had the window",
    );
  }

  // ── The national crown waits for the districts, but not forever ─────────────────
  {
    assert.equal(
      isEarlyBirdsNationalCrownDue({ todayIso: "2026-08-17", openDistrictCount: 0, latestComputedAtIso: "2026-08-16T03:00:00Z" }),
      true,
      "once every district has settled there is nothing to wait for",
    );
    assert.equal(
      isEarlyBirdsNationalCrownDue({ todayIso: "2026-08-17", openDistrictCount: 3, latestComputedAtIso: "2026-08-16T03:00:00Z" }),
      false,
      "with districts still deciding, crowning early could pick the wrong national winner",
    );
    assert.equal(
      isEarlyBirdsNationalCrownDue({ todayIso: "2026-08-21", openDistrictCount: 3, latestComputedAtIso: "2026-08-16T03:00:00Z" }),
      true,
      "but one stalled district must not hold the national award hostage forever",
    );
    assert.equal(
      isEarlyBirdsNationalCrownDue({ todayIso: "2026-08-09", openDistrictCount: 14, latestComputedAtIso: "2026-08-09T00:32:39Z" }),
      false,
      "a backfill mid-sweep must not crown the first district to approve as the national winner",
    );
  }

  // ── The candidate key is a stable identity, not a fingerprint of the data ───────
  {
    const a = buildEarlyBirdsCandidateKey({ periodKey: "2026-08-H1", managerHrId: "B-50", employeeHrId: "B-100" });
    const b = buildEarlyBirdsCandidateKey({ periodKey: "2026-08-H1", managerHrId: "b50", employeeHrId: "b-100" });
    assert.equal(a, b, "hyphen and case must not mint a second identity for the same person");
    assert.equal(
      a,
      buildEarlyBirdsCandidateKey({ periodKey: "2026-08-H1", managerHrId: "B-50", employeeHrId: "B-100" }),
      "recomputing the same rep in the same fortnight must be recognised as the SAME candidate, not a new one",
    );
    assert.notEqual(
      a,
      buildEarlyBirdsCandidateKey({ periodKey: "2026-08-H2", managerHrId: "B-50", employeeHrId: "B-100" }),
      "but a different fortnight is a different candidate",
    );
  }
}
