// ─────────────────────────────────────────────────────────────────────────────
// Marketing request Case File — the shared contract.
//
// A marketing request is a spend commitment that climbs an approval chain and is judged months
// later on realized sales. There has never been one place to see it: its data is spread across
// ~20 routes, and three lifecycle stages have NO surface at all — a rejected request vanishes from
// the requester's workspace, an approver cannot reopen what they decided, and `closed` shows
// nothing. This is the data layer for one consolidated per-request view of all of it.
//
// ── THE ORGANIZING RULE ──────────────────────────────────────────────────────
//
// Every fallible section is a discriminated union, never a nullable field. The module's recurring
// defect is a read that FAILED rendering identically to a read that came back EMPTY: the approval
// screen's double-count check is wrapped in `.catch(() => [])`, so "no overlapping campaigns" and
// "the overlap query fell over" are the same pixels. Same shape, opposite meaning, real money.
//
//   ok             — the read succeeded; `value` is the answer.
//   unavailable    — the read FAILED or could not run. Say so; never substitute a zero.
//   not_applicable — the thing legitimately does not exist yet (no pay date, window not open).
//
// Warnings carry the same idea in three states, where "unavailable" is emphatically NOT "clear".
//
// Pure types only — no imports that reach a database — so the contract can be shared with the UI
// (phase 4b) and asserted in tests without a Supabase client.
// ─────────────────────────────────────────────────────────────────────────────

import type { PhoenixRole } from "@/lib/auth/permissions";
import type { RoiConfidence } from "@/lib/marketing-requests/roi-confidence";
import type { RoiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";
import type {
  MarketingRoiDataCoverage,
  MarketingRoiResultStatus,
} from "@/lib/marketing-requests/roi-report-types";
import type {
  MarketingApprovalStepStatus,
  MarketingRequestStatus,
  MarketingValidationStatus,
} from "@/lib/marketing-requests/types";

/**
 * A section that can fail to load.
 *
 * `reason` is always prose fit for a screen — never a bare code, and never empty. A reader must be
 * able to tell WHY a section is not showing them a number without opening a log.
 */
export type CaseFileBlock<T> =
  | { state: "ok"; value: T }
  | { state: "unavailable"; reason: string }
  | { state: "not_applicable"; reason: string };

export type MarketingCaseFileWarningKey =
  | "double_spend"
  | "suspect_pharmacy_codes"
  | "unvalidated_customer"
  | "unvalidated_pharmacies"
  | "no_target_pharmacies"
  | "confidential_withheld";

/**
 * One check, and what it found.
 *
 * `state` is tri-valued on purpose: "we ran the check and it passed" and "we could not run the
 * check" must never render the same. `severity` is how loudly to say it, NOT whether it is true.
 */
export type MarketingCaseFileWarning = {
  key: MarketingCaseFileWarningKey;
  state: "clear" | "flagged" | "unavailable";
  severity: "info" | "warn" | "block";
  /** Prose for the screen — never a bare code. */
  sentence: string;
  /** Supporting rows when there is something to show; null when there is nothing to list. */
  detail: unknown[] | null;
};

// ── header ───────────────────────────────────────────────────────────────────

/**
 * The REQUESTER's own org context.
 *
 * Its own group, deliberately. On the approval screen "Area" and "Line" sit under the Customer
 * heading while carrying the requester's values — so an approver reading "Area: Giza" believes it
 * describes the customer. It never did. The customer's own geography is in
 * {@link MarketingCaseFileCustomerLocation}, and it is frequently a different place.
 */
export type MarketingCaseFileRequester = {
  areaName: string | null;
  hrId: string;
  lineName: string | null;
  name: string;
  regionName: string | null;
  role: string | null;
};

export type MarketingCaseFileHeader = {
  closedAt: string | null;
  /** approvedAt / rejectedAt / returnedAt — whichever terminal stamp this request carries. */
  decidedAt: string | null;
  /**
   * Where the money is right now — computed SERVER-side so every surface agrees.
   *
   * The existing helper only ever ran in the browser, over rows the ROI engine returned. The ROI
   * engine never returns draft / returned / rejected requests, so the one population that most
   * needs a stage was the one that could not have one.
   */
  lifecycleStage: RoiLifecycleStage;
  /** One sentence: where it is, and what happens next. Never a bare status code. */
  lifecycleSentence: string;
  /** "phoenix" (submitted here) or "xlsx_import" (bulk-loaded, no live chain). */
  origin: string;
  payDate: string | null;
  requestCode: string;
  requestDate: string | null;
  requestId: string;
  requestType: string | null;
  requester: MarketingCaseFileRequester;
  status: MarketingRequestStatus;
  /**
   * The status in words. Differs from `status` only where the stored value understates progress —
   * a request sitting on Finance Execution still stores `pending_approval` but has no approval
   * outstanding. See request-status-label.ts.
   */
  statusLabel: string;
  submittedAt: string | null;
};

// ── money ────────────────────────────────────────────────────────────────────

export type MarketingCaseFilePriorRequest = {
  actualSalesValue: number | null;
  estimatedCost: number;
  payDate: string | null;
  requestCode: string;
  status: string;
};

export type MarketingCaseFileSpentBefore = {
  /**
   * True only when this customer genuinely has no earlier committed request. Kept apart from
   * `requests.length === 0` because "we have never spent here" and "we could not read the history"
   * are opposite facts that otherwise render as the same empty list.
   */
  isFirstRequest: boolean;
  /** Null, never 0, when NO earlier request has a calculated return. */
  priorRealisedSales: number | null;
  requests: MarketingCaseFilePriorRequest[];
  /**
   * Sum of every earlier request's estimated cost, EXCLUDING drafts and rejected.
   *
   * The approval screen's equivalent applies no status filter at all, so an abandoned draft and a
   * refused request both read as money that left the company.
   */
  total: number;
};

export type MarketingCaseFileMoney = {
  estimatedCost: number;
  expectedRoiValue: number;
  /** expected / required. A FORECAST made at submission — never a realized result. */
  forecastCoverageRatio: number;
  requiredRoiValue: number;
  roiDurationMonths: number;
  roiWindow: string | null;
  spentBefore: CaseFileBlock<MarketingCaseFileSpentBefore>;
};

// ── chain ────────────────────────────────────────────────────────────────────

/**
 * One rung of the approval chain.
 *
 * CC/advisory rows are KEPT here (tagged `isCc`) rather than dropped. On the inbox they are
 * correctly hidden — an advisory comment is not an approval and must not read as one more yes —
 * but on a case file "the Product Manager was asked and said nothing" is a fact about the
 * decision, and dropping the row deletes it.
 */
export type MarketingCaseFileChainRung = {
  approverName: string;
  assignedHrId: string | null;
  assignedName: string;
  assignedRole: string;
  decisionAt: string | null;
  decisionByHrId: string | null;
  decisionNote: string | null;
  isCc: boolean;
  isCurrent: boolean;
  /** True for the viewer's own rung, so the screen can say "this one is yours". */
  isMine: boolean;
  sequence: number;
  status: MarketingApprovalStepStatus;
  stepName: string;
};

export type MarketingCaseFileChain = {
  /** Gating rungs approved so far, out of `totalGatingSteps`. */
  approvedGatingCount: number;
  currentStepName: string | null;
  returnReason: string | null;
  rungs: MarketingCaseFileChainRung[];
  totalGatingSteps: number;
};

// ── customer ─────────────────────────────────────────────────────────────────

/** The CUSTOMER's own geography, as captured on site. Not the requester's — see the note there. */
export type MarketingCaseFileCustomerLocation = {
  /** Captured on the doorstep, so it is PII: withheld from viewers with no stake in the request. */
  capturedAddress: CaseFileBlock<string | null>;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
};

export type MarketingCaseFileCustomerValidation = {
  /**
   * Never surfaced anywhere until now, though 155 of 157 customers and 286 of 289 pharmacies sit
   * at `pending`. "Nobody has ever validated this customer" must be visible, not silent.
   */
  status: MarketingValidationStatus;
  /** Prose. "Validated by SFE on …" / "Never validated — nobody has checked this customer exists." */
  sentence: string;
  validatedAt: string | null;
  validatedByName: string | null;
};

export type MarketingCaseFileEvidencePhoto = {
  capturedAt: string | null;
  /**
   * The capture filename. On its own this is NOT proof and must never be shown as such — for every
   * customer created before 2026-08-04 the bytes were discarded in the browser and only this
   * string was kept. `url` is the field that says whether an image actually exists.
   */
  fileName: string | null;
  url: string | null;
};

export type MarketingCaseFileCustomer = {
  code: string | null;
  contact: CaseFileBlock<{ mobile: string | null; name: string | null }>;
  customerId: string | null;
  /** PII: a GPS-stamped frame of a real business address. Withheld from non-participants. */
  evidencePhoto: CaseFileBlock<MarketingCaseFileEvidencePhoto>;
  location: MarketingCaseFileCustomerLocation;
  name: string | null;
  speciality: string | null;
  type: string | null;
  validation: MarketingCaseFileCustomerValidation;
};

// ── products ─────────────────────────────────────────────────────────────────

export type MarketingCaseFileProduct = {
  expectedValue: number;
  factoryPrice: number;
  forecastQuantity: number;
  line: string | null;
  name: string;
  productId: number;
  valueShare: number;
};

export type MarketingCaseFileProducts = {
  /**
   * How many promoted products this viewer may not see (LA003/LA004/SS001).
   *
   * Announced rather than silently dropped: a row list that is quietly short is how a reader ends
   * up believing a campaign is smaller than it is.
   */
  confidentialWithheldCount: number;
  rows: MarketingCaseFileProduct[];
  totalExpectedValue: number;
  totalForecastUnits: number;
};

// ── target pharmacies ────────────────────────────────────────────────────────

/**
 * How trustworthy a target pharmacy's distributor code is.
 *
 * `lookup_failed` is a state the rest of the module does not have. `reference_status` coalesces a
 * failed lookup to "pending", and production holds 273 matched / 16 not_found / ZERO genuine
 * pending — so every "pending" on screen today is a failed lookup wearing a benign label.
 */
export type MarketingCaseFileReferenceStatus =
  | "matched"
  | "manual_approved"
  | "ambiguous"
  | "not_found"
  | "rejected"
  | "pending"
  | "lookup_failed";

export type MarketingCaseFileTargetPharmacy = {
  distributorName: string;
  distributorPharmacyCode: string;
  /** PII: a GPS-stamped shop front. Withheld from non-participants. */
  evidencePhotoUrl: string | null;
  notes: string | null;
  pharmacyCode: string;
  pharmacyId: string | null;
  pharmacyName: string;
  referenceStatus: MarketingCaseFileReferenceStatus;
  /** Prose for the chip. Never the raw status word. */
  referenceStatusSentence: string;
  /**
   * True when this code cannot be relied on to attribute a sale. Measured on production: a code
   * the reference database cannot find has no sales 27.9% of the time versus 1.3% for a matched
   * code — ~21x worse.
   */
  suspect: boolean;
  /** The pharmacy record's OWN validation state, distinct from its distributor code's. */
  validationStatus: MarketingValidationStatus | null;
};

export type MarketingCaseFileTargetPharmacies = {
  rows: MarketingCaseFileTargetPharmacy[];
  suspectCount: number;
  unvalidatedCount: number;
};

// ── outcome ──────────────────────────────────────────────────────────────────

export type MarketingCaseFileOutcome = {
  actualCoverageRatio: number;
  actualSalesUnits: number;
  actualSalesValue: number;
  /** The engine's own reason when nothing attributed. Null when sales did attribute. */
  attributionGapReason: string | null;
  /** How much the FIGURE can be trusted — never a judgement of how the campaign performed. */
  confidence: CaseFileBlock<RoiConfidence>;
  dataCoverage: MarketingRoiDataCoverage;
  requiredRoiValue: number;
  resultStatus: MarketingRoiResultStatus;
  /** Prose verdict. Never renders zero attributed sales as a failure when the window is not due. */
  resultSentence: string;
  roiWindow: string | null;
  /** Latest validated Source-of-Sales invoice period (YYYY-MM) backing attribution. */
  salesDataAsOf: string | null;
  windowEnd: string | null;
  windowStart: string | null;
};

// ── viewer ───────────────────────────────────────────────────────────────────

/**
 * Which rule admitted this viewer. Announced, never silent — a reader who is seeing a redacted
 * case file must be able to tell why.
 */
export type MarketingCaseFileAdmission =
  | "system"
  | "company_oversight"
  | "requester"
  | "hierarchy"
  | "chain_step"
  | "cc_reviewer"
  | "product_owner";

/** One control on the decision bar. `href` is already resolved for THIS viewer's shell. */
export type MarketingCaseFileDecisionAction = {
  decision: "approve" | "return" | "reject";
  /**
   * The shell-correct decision page, resolved per viewer. The Case File is shell-NEUTRAL (one URL
   * for every recipient of a notification), so a hardcoded path would be wrong for half the chain:
   * the portal page redirects admin-shell approvers to /overview and the workspace page redirects
   * portal roles back out.
   */
  href: string;
  /** The step's own wording — "Validate & Forward", "Execute", "Decline" — never a generic verb. */
  label: string;
};

/**
 * The viewer's own OPEN rung, as the controls that answer it.
 *
 * Null unless `can.decide` is true, so this is never a set of buttons a viewer may not press.
 * `actions` always leads with approve; return and reject appear only when the rung permits them
 * (Finance Execution carries `allow_reject: false`, and a Reject control there is one whose only
 * outcome is `marketing_reject_not_allowed`).
 */
export type MarketingCaseFileViewerDecision = {
  actions: MarketingCaseFileDecisionAction[];
  /** The rung's name, so the bar can say WHICH decision is being asked for. */
  stepName: string;
};

export type MarketingCaseFileViewer = {
  admittedAs: MarketingCaseFileAdmission[];
  /**
   * Action affordances. These are UI hints ONLY — every one of them is separately enforced by the
   * route that performs the action. A capability boolean must never be used as a data gate.
   */
  can: {
    comment: boolean;
    decide: boolean;
    resubmit: boolean;
  };
  /**
   * The customer's captured address, contact mobile and evidence frames. Participants and
   * oversight only.
   */
  canSeeCustomerPii: boolean;
  /**
   * LA003 / LA004 / SS001. CEO and Super Admin only, with NO `scope === "system"` bypass — the
   * locked rule is role-based, and a scope bypass would reopen it for every system-scoped role.
   */
  canSeeConfidentialProducts: boolean;
  /**
   * `can.decide` made actionable. It was a boolean nothing rendered for three weeks — see the
   * header of case-file-decision-bar.ts for what that cost.
   */
  decision: MarketingCaseFileViewerDecision | null;
  hrId: string | null;
  role: PhoenixRole;
  /**
   * The shell base ("/admin" or "/employee-portals") for THIS viewer, resolved from
   * resolveNavigationMode — the same source the decision bar uses. The "Matched sales rows" lazy
   * panel (MarketingRequestSalesView) builds its own internal view-sales links off this base, so a
   * hardcoded root would send half the chain into the wrong shell, exactly as the decision hrefs
   * would. The Case File itself is shell-neutral (one URL for every notification recipient), which
   * is why the base has to travel on the payload rather than be inferred from the current path.
   */
  viewSalesBasePath: string;
};

// ── lazy sections ────────────────────────────────────────────────────────────

/**
 * A panel the Case File deliberately does NOT inline.
 *
 * Each of these costs its own multi-query pass (sales history, per-line attribution explain, the
 * full matched-sales table). Paying for all of them on every open would make the one page slower
 * than the twenty it replaces. `available` lets the UI avoid offering a link this viewer would
 * only be 403'd on.
 */
export type MarketingCaseFileLazySection = {
  available: boolean;
  href: string;
  key: "sales_evidence" | "roi_explain" | "view_sales" | "direct_tracking";
  label: string;
  /** Why it is not inlined, in prose. */
  reason: string;
};

// ── the case file ────────────────────────────────────────────────────────────

export type MarketingRequestCaseFile = {
  chain: CaseFileBlock<MarketingCaseFileChain>;
  customer: CaseFileBlock<MarketingCaseFileCustomer>;
  /** ISO. Render in Africa/Cairo. */
  generatedAt: string;
  header: MarketingCaseFileHeader;
  history: CaseFileBlock<MarketingCaseFileHistory>;
  lazySections: MarketingCaseFileLazySection[];
  money: MarketingCaseFileMoney;
  outcome: CaseFileBlock<MarketingCaseFileOutcome>;
  products: CaseFileBlock<MarketingCaseFileProducts>;
  targetPharmacies: CaseFileBlock<MarketingCaseFileTargetPharmacies>;
  viewer: MarketingCaseFileViewer;
  warnings: MarketingCaseFileWarning[];
};

// ── history ──────────────────────────────────────────────────────────────────

export type MarketingRequestEventKind =
  | "request_created"
  | "request_submitted"
  | "request_status_changed"
  | "request_value_changed"
  | "request_deleted"
  | "step_opened"
  | "step_decided"
  | "step_commented";

/**
 * One thing that happened, already resolved for the screen.
 *
 * This is the ONLY place a second comment from the same reviewer is visible. `decision_note` on the
 * approval step holds one string and every comment overwrites it, so the step row shows the latest
 * and nothing else; the event log keeps each one with its own timestamp.
 */
export type MarketingCaseFileHistoryEntry = {
  /** Cairo-formatted server-side. The owner's standing rule: never a raw UTC stamp on screen. */
  atLabel: string;
  /**
   * The person, by NAME. `null` means the event did not record an actor — which is "not recorded",
   * NEVER "the system". The two must not render the same.
   */
  actorName: string | null;
  actorHrId: string | null;
  /** Prose, resolved from the kind. Never a raw `step_commented` on screen. */
  headline: string;
  /**
   * Derived from an existing row during the 2026-08-13 backfill rather than captured when it
   * happened, so its actor and timing are reconstructions. Shown as such.
   */
  isBackfilled: boolean;
  kind: MarketingRequestEventKind;
  note: string | null;
  occurredAt: string;
  stepName: string | null;
};

export type MarketingCaseFileHistory = {
  /** How many `step_commented` entries — the count the step row cannot tell you. */
  commentCount: number;
  /**
   * States the limit of the record in prose. Events begin at the 2026-08-13 backfill: anything a
   * reviewer overwrote before that is genuinely gone, and the screen must say so rather than
   * present a short list as a complete one.
   */
  coverageSentence: string;
  entries: MarketingCaseFileHistoryEntry[];
};

// ── constructors ─────────────────────────────────────────────────────────────
//
// Deliberately the only way a block is built. An inline object literal is how `{ state: "ok" }`
// with a zeroed value gets written by accident, which is the exact failure this contract exists to
// prevent.

export function caseFileOk<T>(value: T): CaseFileBlock<T> {
  return { state: "ok", value };
}

export function caseFileUnavailable<T>(reason: string): CaseFileBlock<T> {
  return { reason, state: "unavailable" };
}

export function caseFileNotApplicable<T>(reason: string): CaseFileBlock<T> {
  return { reason, state: "not_applicable" };
}

/** The value when the block is `ok`, else `fallback`. For callers that must fold to one shape. */
export function caseFileValueOr<T>(block: CaseFileBlock<T>, fallback: T): T {
  return block.state === "ok" ? block.value : fallback;
}
