/**
 * Phoenix CRM — the system's advice as it stood when a place check was decided, and how often the
 * Super Admin agreed with it.
 *
 * The rebuild, 23 Nov 2026 (`docs/approvals-rebuild-2026-11.md`, Part 2). The page recommended Reject on
 * evidence he mostly approved, and nobody could say so with a number, because nothing kept what the
 * system had said. A decision now keeps two values beside it (`system_advice_at_decision`, the kind of
 * advice in `system_advice_code_at_decision`), and the page reads its own agreement from them.
 *
 * Pure and screen-free. The server reads the rows (`server/stored-advice.ts`); this file is the rule.
 *
 * 🔴 THE ADVICE IS WORKED OUT FROM THE REVIEW'S OWN RECORD, the same record the board's row is built
 * from (`loadValidationReviews`), through the same `adviseOnHeldRow`. A second way to read a record
 * would keep an advice the page never showed.
 *
 * 🔴 "CHECK IT YOURSELF" IS COUNTED AND NEVER SCORED. It is not an answer, so no decision agrees or
 * disagrees with it; scoring it either way would move the share on rows the system said nothing about.
 *
 * 🔴 A PLACE THE SYSTEM APPROVED ITSELF IS NOT HIS AGREEMENT. It is counted apart while it stands, and
 * becomes a disagreement the moment he takes it back.
 */

import {
  adviseOnHeldRow,
  placeCheckAdviceKindLabel,
  type PlaceCheckAdvice,
  type PlaceCheckAdviceKind,
  type SignEvidence,
} from "@/lib/phoenix-crm/place-check-advice";
import { parseScheduleHeldBecause, parseScheduleLegibility, parseScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The kinds of hold the board's row names; any other reason reads as none, as it does on the row. */
const HOLD_REASONS = [
  "no_confident_listing",
  "lookup_failed",
  "listing_far",
  "listing_off",
  "refused_by_admin",
  "sign_other_name",
  "sign_no_name",
  "schedule_other_name",
  "schedule_missing",
] as const;

/**
 * The advice on one held review, from its `google` record, the place's stored reading of its sign and
 * the nearest of Google's listings. `buildingHasNoTimetable` is the building's declaration, for a
 * customer seated in one.
 */
export function adviceOnReviewRecord(input: {
  google: unknown;
  signboard: SignEvidence;
  nearestListingMeters: number | null;
  buildingHasNoTimetable: boolean;
}): PlaceCheckAdvice {
  const record = isRecord(input.google) ? input.google : {};
  const schedule = record.verdict === "schedule";
  const signboardHold = record.verdict === "signboard";
  const reason = (HOLD_REASONS as readonly unknown[]).includes(record.reason) ? String(record.reason) : null;
  return adviseOnHeldRow(
    {
      photoKind: schedule ? "schedule" : "signboard",
      reason,
      signText: signboardHold || schedule ? text(signboardHold ? record.signText : record.scheduleText) : null,
      hoursRead: schedule ? text(record.hoursRead) : null,
      nearestListingMeters: input.nearestListingMeters,
      evidence: {
        checkReason: text(record.reason),
        heldBecause: schedule ? parseScheduleHeldBecause(record.heldBecause) : null,
        legibility: schedule ? parseScheduleLegibility(record.legibility) : null,
        problem: schedule ? parseScheduleProblem(record.problem) : null,
        uploaded: schedule && record.uploaded === true,
        signboard: input.signboard,
      },
    },
    schedule && input.buildingHasNoTimetable,
  );
}

/** The two values a decision keeps. */
export type StoredAdvice = {
  system_advice_at_decision: PlaceCheckAdviceKind;
  system_advice_code_at_decision: string;
};

export function storedAdviceOf(advice: Pick<PlaceCheckAdvice, "kind" | "code">): StoredAdvice {
  return { system_advice_at_decision: advice.kind, system_advice_code_at_decision: advice.code };
}

// ── How often he agreed ─────────────────────────────────────────────────────────────────────────

/** The window the page counts over. */
export const AGREEMENT_WINDOW_DAYS = 30;

/** What "ready" asks of a kind: he agreed 19 times in 20, over at least this many decisions. */
export const AGREEMENT_READY_ONE_IN = 20;
export const AGREEMENT_READY_MIN_DECISIONS = 20;

/** One decided review or building, as the meter reads it. */
export type AgreementDecision = {
  advice: string | null;
  code: string | null;
  outcome: "approved" | "rejected";
  /** The system approved it itself (`system_approved_rule`). */
  bySystem: boolean;
};

export type AgreementKind = {
  code: string;
  label: string;
  advice: PlaceCheckAdviceKind;
  decided: number;
  approved: number;
  rejected: number;
  /** Decisions that went the way the advice said. Null for "Check it yourself", which is not scored. */
  agreed: number | null;
  /** Agreed 19 times in 20 over at least 20 decisions: the number a kind needs before the page may call it ready. */
  meetsReady: boolean;
};

export type PlaceCheckAgreement = {
  /** Decisions of his that kept an advice. */
  decided: number;
  /** Of those, the ones the system had an answer for (approve or reject). */
  scored: number;
  agreed: number;
  /** Places the system approved itself that still stand. Not his decisions, never scored. */
  bySystem: number;
  /** Places the system approved itself that he took back. Each is in `decided` as a disagreement. */
  takenBack: number;
  kinds: AgreementKind[];
};

function adviceKind(value: string | null): PlaceCheckAdviceKind | null {
  return value === "approve" || value === "reject" || value === "look" ? value : null;
}

export function placeCheckAgreement(decisions: ReadonlyArray<AgreementDecision>): PlaceCheckAgreement {
  const kinds = new Map<string, AgreementKind>();
  const total: PlaceCheckAgreement = { decided: 0, scored: 0, agreed: 0, bySystem: 0, takenBack: 0, kinds: [] };
  for (const decision of decisions) {
    const advice = adviceKind(decision.advice);
    // A row that kept no advice it can read is a decision from before the count began.
    if (!advice || !decision.code) continue;
    if (decision.bySystem && decision.outcome === "approved") {
      total.bySystem += 1;
      continue;
    }
    if (decision.bySystem) total.takenBack += 1;
    const key = `${advice}:${decision.code}`;
    const kind = kinds.get(key) ?? {
      code: decision.code,
      label: placeCheckAdviceKindLabel(decision.code),
      advice,
      decided: 0,
      approved: 0,
      rejected: 0,
      agreed: advice === "look" ? null : 0,
      meetsReady: false,
    };
    kind.decided += 1;
    if (decision.outcome === "approved") kind.approved += 1;
    else kind.rejected += 1;
    total.decided += 1;
    if (advice !== "look") {
      const agrees = (advice === "approve") === (decision.outcome === "approved");
      total.scored += 1;
      if (agrees) {
        total.agreed += 1;
        kind.agreed = (kind.agreed ?? 0) + 1;
      }
    }
    kinds.set(key, kind);
  }
  for (const kind of kinds.values()) {
    kind.meetsReady =
      kind.agreed !== null && kind.decided >= AGREEMENT_READY_MIN_DECISIONS && (kind.decided - kind.agreed) * AGREEMENT_READY_ONE_IN <= kind.decided;
  }
  // The kinds he decided most come first; a tie reads in the label's order, so the list never shuffles.
  total.kinds = [...kinds.values()].sort((left, right) => right.decided - left.decided || left.label.localeCompare(right.label));
  return total;
}

const decisions = (count: number) => `${count} ${count === 1 ? "decision" : "decisions"}`;

/** The meter in one or two sentences. It starts empty and says so, never a share of nothing. */
export function agreementSentence(agreement: PlaceCheckAgreement): string {
  if (agreement.decided === 0) {
    return `No decision has kept the system's advice yet. The count starts with your next decision and covers ${AGREEMENT_WINDOW_DAYS} days.`;
  }
  const looked = agreement.decided - agreement.scored;
  const said = looked === 0 ? "" : ` On ${looked} more it said to check yourself.`;
  if (agreement.scored === 0) {
    return `In the last ${AGREEMENT_WINDOW_DAYS} days the system said to check yourself on all ${decisions(agreement.decided)}.`;
  }
  return `In the last ${AGREEMENT_WINDOW_DAYS} days you decided the way the system advised on ${agreement.agreed} of the ${decisions(agreement.scored)} it had an answer for.${said}`;
}
