import type { MarketAwarenessLine } from "@/lib/market-awareness/lines";

/**
 * Statuses. `withdrawn` is a terminal state distinct from `rejected` on purpose: a request the PM
 * pulled back is not a request the CEO refused, and putting a rejection on the record for a typing
 * error is what a withdraw path exists to prevent.
 */
export const MARKET_AWARENESS_STATUSES = [
  "draft",
  "pending_manager",
  "pending_ceo",
  "returned",
  "rejected",
  "approved",
  "executed",
  "closed",
  "withdrawn",
] as const;

export type MarketAwarenessStatus = (typeof MARKET_AWARENESS_STATUSES)[number];

export const MARKET_AWARENESS_DECISION_ACTIONS = [
  "approve",
  "reject",
  "return",
  "withdraw",
  "execute",
  "close",
] as const;

export type MarketAwarenessDecisionAction = (typeof MARKET_AWARENESS_DECISION_ACTIONS)[number];

export type MarketAwarenessStepCode = "manager" | "ceo";

export type MarketAwarenessActivityType = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
};

export type MarketAwarenessProduct = {
  productCode: string;
  productName: string | null;
  lineId: number | null;
};

export type MarketAwarenessBrick = {
  brickId: string;
  brickName: string | null;
  isPrimary: boolean;
};

export type MarketAwarenessCostItem = {
  id: number;
  label: string;
  amount: number;
  sortOrder: number;
};

export type MarketAwarenessDecision = {
  id: number;
  stepCode: string;
  actorHrId: string;
  actorName: string | null;
  action: MarketAwarenessDecisionAction;
  comment: string | null;
  amendedCost: number | null;
  createdAt: string;
};

/**
 * A seat holder as the screen shows them. `replacedOriginal` is the owner's answer 33: display
 * today's holder, but say plainly when it is not who it was at approval — "show todays but highlight
 * and mention that the original rep resigned and this replaced him".
 */
export type MarketAwarenessSeatHolder = {
  hrId: string | null;
  name: string | null;
  /** Who held the seat when the activity was approved, when that differs from today. */
  originalHrId: string | null;
  originalName: string | null;
  replacedOriginal: boolean;
  /** True when the seat exists but nobody is in it — 41 of 147 area-line rows on production. */
  vacant: boolean;
};

export type MarketAwarenessActivity = {
  id: string;
  activityCode: string;
  status: MarketAwarenessStatus;

  requesterHrId: string;
  requesterName: string | null;
  managerHrId: string | null;
  managerName: string | null;

  activityType: MarketAwarenessActivityType;
  title: string | null;
  venue: string | null;
  city: string | null;
  startDate: string;
  endDate: string | null;
  expectedAttendees: number | null;
  speakers: string | null;

  primaryLine: MarketAwarenessLine;
  lines: MarketAwarenessLine[];
  regionCode: string;
  regionName: string | null;
  areaCode: string;
  areaName: string | null;

  products: MarketAwarenessProduct[];
  bricks: MarketAwarenessBrick[];
  costItems: MarketAwarenessCostItem[];

  currency: string;
  estimatedCost: number;
  amendedCost: number | null;
  /** What was actually approved: the CEO's amended figure when he set one, else the estimate. */
  approvedCost: number | null;
  actualCost: number | null;

  durationMonths: number;
  baselineMonths: number;
  expectedUpliftPct: number | null;

  financePaid: boolean;
  financeMarkedAt: string | null;

  rep: MarketAwarenessSeatHolder;
  districtManagers: MarketAwarenessSeatHolder[];

  executedAt: string | null;
  outcomeNote: string | null;

  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  returnedAt: string | null;
  withdrawnAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;

  decisions: MarketAwarenessDecision[];
};

/** One month of the tracking series, for one line. */
export type MarketAwarenessTrackingPoint = {
  /** `YYYY-MM`. */
  period: string;
  /** Distributor-invoice half of the closing, revalued at factory price. */
  indirectValue: number;
  /** Direct-order half, folded on at the row's own area and brick. */
  directValue: number;
  /** The two halves added. Quoting either alone is wrong in a different direction. */
  totalValue: number;
  /** Only populated when the activity targets exactly ONE product. */
  units: number | null;
};

export type MarketAwarenessTrackingSeries = {
  line: MarketAwarenessLine;
  /** The primary brick's own series. */
  brick: MarketAwarenessTrackingPoint[];
  /** The whole area's series, same products. */
  area: MarketAwarenessTrackingPoint[];
};

/**
 * The reconciliation check, shown on the screen rather than assumed. Sum of every brick in the area
 * against the published area figure for the same period and product set. They agree by construction
 * — it is the same rows grouped one level finer — so a disagreement means something upstream
 * changed and the screen must say so instead of printing a number that contradicts the closing.
 */
export type MarketAwarenessReconciliation = {
  period: string;
  bricksSum: number;
  publishedAreaValue: number;
  difference: number;
  reconciled: boolean;
};

export type MarketAwarenessTracking = {
  /** Periods before the activity, `baselineMonths` of them. */
  baselinePeriods: string[];
  /** Periods from the activity month forward, `durationMonths` of them. */
  windowPeriods: string[];
  /**
   * The last period a closing has been published for. The Tracking tab can never show the current
   * month — a closing is only publishable on the first day of the following month — and saying so
   * is better than rendering a half month that reads as a collapse.
   */
  lastClosedPeriod: string | null;
  series: MarketAwarenessTrackingSeries[];
  reconciliation: MarketAwarenessReconciliation[];
  /** Set when the window has not finished, so a comparison would be against a partial period. */
  windowIncompleteReason: string | null;
};
