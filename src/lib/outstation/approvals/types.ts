/**
 * Expense Approvals — the shapes the page, the routes and the checks share.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). Type-only and import-free, so the browser
 * screen, the server reads and the tests all read one definition.
 */

import type { TripStanding } from "@/lib/outstation/approvals/standing";

/** A check never says "probably": it passed, it failed, or it could not be checked. */
export type CheckAnswer = "pass" | "fail" | "unknown";

export type CheckKey =
  | "field_work"
  | "arrival_photo"
  | "departure_photo"
  | "ticket"
  | "duplicate"
  | "route"
  | "odometer"
  | "amounts";

export type ClaimCheck = {
  answer: CheckAnswer;
  key: CheckKey;
  label: string;
  /** One sentence, in the approver's words. */
  sentence: string;
};

/** Ready = every check passed. Anything else is his call, and says the one reason why. */
export type ClaimLane = "ready" | "your_call";

export type ClaimVerdict = {
  checks: ClaimCheck[];
  /** Trip days with no visit and no recorded meeting — what the idle-day cut is offered on. */
  idleDates: string[];
  lane: ClaimLane;
  /** The one sentence a "Your call" row wears; null on a Ready row. */
  reason: string | null;
};

export type DecisionAction = "approve" | "reduce" | "reject";

/** What Approve does when the trip has idle days and an allowance: the pre-cut, named on the button. */
export type ClaimPreCut = {
  deduction: number;
  label: string;
  payable: number;
  reason: string;
};

/** One trip on the desk. Money is whole figures in EGP exactly as the payroll mapper produced them. */
export type DeskClaim = {
  allowance: number;
  /** The amount he typed when he reduced it; null when the claim pays in full. */
  approvedAmount: number | null;
  daysWaiting: number;
  decidedAt: string | null;
  /**
   * The visits the employee declared, and the verdict stamped at submission — what the old system's
   * record is read against, for a trip with days before the team moved to Phoenix CRM.
   */
  declaredWorkload?: { am: number; matchStatus: string | null; pharmacies: number | null; pm: number } | null;
  employeeName: string;
  employeeNote: string | null;
  employeeRole: string | null;
  from: string;
  /**
   * Waiting claims only: why approving it would be held out of payroll for now, in the payroll
   * gate's words; null when an approval goes straight to the next payroll.
   */
  holdReason: string | null;
  hrComment: string;
  hrId: string | null;
  /** True once a payroll took it: nothing here can change it any more. */
  locked: boolean;
  /** What the trip pays as it stands: the claim while waiting, the approved figure once decided. */
  payable: number;
  payoutMonth: number;
  payoutYear: number;
  preCut: ClaimPreCut | null;
  /** Other claims the duplicate check named, so the reviewer can open them. */
  relatedRequestIds: number[];
  requestId: number;
  /** The claim's version token; a decision carries it back so a claim that moved is refused. */
  revision: string;
  standing: TripStanding;
  submittedAt: string | null;
  /** The system's own sentence on an undecided claim — a one-press insert, never a pre-filled reason. */
  systemNote: string | null;
  to: string;
  total: number;
  transportation: string;
  tripEnd: string;
  tripId: string;
  tripStart: string;
  tripType: string;
  verdict: ClaimVerdict;
};

export type DeskLaneSummary = { count: number; value: number };

export type DeskAgreement = {
  /** Decisions stamped in the window, by the lane the system had filed them in. */
  ready: { approved: number; decided: number };
  yourCall: { approved: number; decided: number };
  windowDays: number;
};

export type DeskQueue = {
  agreement: DeskAgreement;
  /** Could the caller decide, or only read? The CEO reads. */
  canDecide: boolean;
  claims: DeskClaim[];
  /** Sources that could not be read; the page names them rather than showing a clean pass. */
  unavailable: string[];
  /** How many waiting claims are older than seven days. */
  overSevenDays: number;
  tiles: Record<TripStanding, DeskLaneSummary>;
};

export type DeskDecisionRequest = {
  action: DecisionAction;
  /**
   * Reduce: the amount to pay. Approve: the idle-day cut the button named, when it named one —
   * the server pays it only while its own reading of the trip still gives the same figure.
   */
  approvedAmount?: number | null;
  comment?: string | null;
  /**
   * Approve only: "Keep full claim", said out loud. An Approve that names no amount and does not
   * carry this is paid in full only while the server's own reading finds no idle-day cut.
   */
  keepFull?: boolean;
  requestId: number;
  revision: string;
};

export type DeskDecisionOutcome = {
  /** The claim as it reads after the decision; null when it could not be re-read. */
  claim: DeskClaim | null;
  /**
   * `changed` = the claim moved since he saw it; `refused` = the write said no;
   * `amount_not_saved` = it was approved, but NOT at the figure he chose, and the message says
   * what it pays as it stands.
   */
  code: "saved" | "changed" | "refused" | "amount_not_saved";
  message: string | null;
  requestId: number;
};
