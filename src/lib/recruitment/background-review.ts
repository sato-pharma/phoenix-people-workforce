// Recruitment / ATS — the admin's queue for CVs the eligibility rule will not decide by itself.
//
// The owner, 2026-08-31: *"you will start backfilling from the historicals. For example, the two
// hundred eligible, you will backfill them. But anyone non eligible, you will make the admin be able
// to check first their CV and confirm."*
//
// That sentence splits the work in two, and this file is the second half. The first half is
// automatic: candidate-background.ts reads a faculty or a declared answer and, when it recognises
// one of the five disciplines, district-manager-folders.ts routes the CV to the managers covering
// its region. The second half is not automatic ON PURPOSE, and the asymmetry is the whole design:
//
//   ELIGIBLE is reversible. A CV that reaches a district manager who did not want it costs him
//   thirty seconds. He closes it.
//
//   PARAMEDICAL is not. Filing somebody as paramedical takes them off the screen the recruiters
//   work from and nothing ever brings them back — nobody re-reads a folder named for people who
//   were filtered out. So no CV reaches that shelf without a person having opened the document.
//
// ── THREE THINGS THAT SOUND ALIKE AND ARE NOT ───────────────────────────────────────────────────
//
//   faculty              what the CV EXTRACTOR read off the document. A guess about a string.
//   declaredBackground   what the APPLICANT answered when the apply flow asked. Their own words.
//   confirmation         what an ADMIN decided after opening the CV. A person's judgement.
//
// They are three columns because they are three claims, and any of them can contradict the others.
// The confirmation outranks both of the others in BOTH directions: a CV whose faculty parses as
// "Faculty of Pharmacy" and whose owner an admin has marked paramedical stays paramedical, because
// somebody read the document and the parser read a string.
//
// PURE — no database, no React. The routing rule imports it, and that rule is reached from a
// "use client" screen, so a database import anywhere in this chain would drag the service-role
// client into the browser bundle. The service half lives in candidates.ts.

import {
  judgeBackground,
  type BackgroundOutcome,
  type BackgroundVerdict,
} from "@/lib/recruitment/candidate-background";
import type { Candidate } from "@/lib/recruitment/types";

/** The two answers an admin can give. `unknown` is a verdict, never a confirmation — see below. */
export const backgroundConfirmationOutcomes = ["eligible", "paramedical"] as const;

export type BackgroundConfirmationOutcome = (typeof backgroundConfirmationOutcomes)[number];

export function isBackgroundConfirmationOutcome(
  value: unknown,
): value is BackgroundConfirmationOutcome {
  return (
    typeof value === "string" &&
    (backgroundConfirmationOutcomes as readonly string[]).includes(value)
  );
}

/** Everything this module reads off a candidate — structural, so a fixture need not be whole. */
export type BackgroundReviewCandidate = Pick<
  Candidate,
  | "id"
  | "fullName"
  | "status"
  | "folder"
  | "faculty"
  | "declaredBackground"
  | "backgroundConfirmedOutcome"
  | "backgroundConfirmedAt"
  | "backgroundConfirmedByHrId"
>;

/**
 * Where a candidate actually stands, and on whose authority.
 *
 * `source: "confirmed"` means a person answered. `"judged"` means nobody has, and this is what the
 * rule made of the evidence. Every screen and every gate reads THIS rather than calling the judge
 * directly — that is what makes an admin's answer stick.
 */
export type BackgroundStanding = {
  outcome: BackgroundOutcome;
  source: "confirmed" | "judged";
  /** The verdict the evidence supports, kept even when a person has overruled it. */
  verdict: BackgroundVerdict;
  confirmedAt: string | null;
  confirmedByHrId: string | null;
};

export function resolveBackgroundStanding(
  candidate: BackgroundReviewCandidate | null | undefined,
): BackgroundStanding {
  const verdict = judgeBackground({
    declaredBackground: candidate?.declaredBackground,
    faculty: candidate?.faculty,
  });

  const confirmed = candidate?.backgroundConfirmedOutcome;
  if (isBackgroundConfirmationOutcome(confirmed)) {
    return {
      confirmedAt: candidate?.backgroundConfirmedAt ?? null,
      confirmedByHrId: candidate?.backgroundConfirmedByHrId ?? null,
      outcome: confirmed,
      source: "confirmed",
      verdict,
    };
  }

  return {
    confirmedAt: null,
    confirmedByHrId: null,
    outcome: verdict.outcome,
    source: "judged",
    verdict,
  };
}

/**
 * Is this CV waiting for an admin?
 *
 * FOUR REFUSALS BEFORE THE QUESTION IS EVEN ASKED, and each of them is a person who must not appear
 * in a queue somebody has to work through:
 *
 *   already answered — the whole point of storing the confirmation.
 *   already filed    — including onto the Paramedical shelf, which IS the answer.
 *   rejected         — the decision has been made on the whole application, not just the degree.
 *   judged eligible  — routed automatically; the owner asked for a check on the OTHER ones.
 *
 * What is left is exactly two groups: the CVs the rule reads as paramedical, and the ones whose
 * evidence it could not parse at all. Both need a person; they need to be told apart, which is what
 * `backgroundReviewQueue` does.
 */
export function needsBackgroundReview(
  candidate: BackgroundReviewCandidate | null | undefined,
): boolean {
  if (!candidate) return false;
  if (isBackgroundConfirmationOutcome(candidate.backgroundConfirmedOutcome)) return false;
  if (candidate.folder) return false;
  if (String(candidate.status ?? "").trim().toLowerCase() === "rejected") return false;
  return resolveBackgroundStanding(candidate).outcome !== "eligible";
}

/** One row of the queue, carrying the evidence the judge read so an admin can see what it saw. */
export type BackgroundReviewRow<T extends BackgroundReviewCandidate = BackgroundReviewCandidate> = {
  candidate: T;
  standing: BackgroundStanding;
};

/**
 * The queue, split by what the admin is actually being asked.
 *
 * THE TWO GROUPS ARE DIFFERENT QUESTIONS and merging them is how a queue gets select-alled. For a
 * `paramedical` row the rule has read something it recognises as outside the five disciplines, and
 * the admin is checking a conclusion. For an `unreadable` row it read nothing usable — an empty
 * faculty, or a string it could not parse — and the admin is supplying an answer that does not
 * exist yet. The second group is much the larger of the two, and mixing them would present 270-odd
 * rows as if they were all near-misses on the same judgement.
 *
 * `withoutEvidence` is called out inside the unreadable group because those CVs carry no faculty at
 * all: there is nothing on screen for an admin to read but the document itself, so a screen that
 * shows an evidence line for them would show an empty one.
 */
export function backgroundReviewQueue<T extends BackgroundReviewCandidate>(
  candidates: readonly T[],
): {
  paramedical: BackgroundReviewRow<T>[];
  unreadable: BackgroundReviewRow<T>[];
  withoutEvidence: number;
  total: number;
} {
  const paramedical: BackgroundReviewRow<T>[] = [];
  const unreadable: BackgroundReviewRow<T>[] = [];
  let withoutEvidence = 0;

  for (const candidate of candidates) {
    if (!needsBackgroundReview(candidate)) continue;
    const standing = resolveBackgroundStanding(candidate);
    const row = { candidate, standing };
    if (standing.outcome === "paramedical") paramedical.push(row);
    else {
      unreadable.push(row);
      if (!standing.verdict.evidence) withoutEvidence += 1;
    }
  }

  return {
    paramedical,
    total: paramedical.length + unreadable.length,
    unreadable,
    withoutEvidence,
  };
}

/**
 * What pressing each button does, in the words the button should use.
 *
 * Kept here rather than in the component so the screen, the API refusal and the tests all say the
 * same sentence. A confirmation is not undoable from the queue itself — the row leaves it — so the
 * consequence has to be readable BEFORE the click, not discoverable after it.
 */
export function describeBackgroundConfirmation(outcome: BackgroundConfirmationOutcome): string {
  return outcome === "eligible"
    ? "Their CV starts reaching the district managers covering their area. They stay in the pool."
    : "Filed onto the Paramedical shelf. They leave the pool and reach no manager.";
}
