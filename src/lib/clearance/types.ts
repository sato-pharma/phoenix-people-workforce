/**
 * Clearance & offboarding — the domain types behind HR Operations job description §6,
 * "coordinate clearance across departments with evidence of completion before final settlement".
 *
 * The shapes here mirror `hr_clearance_*` (migration 20260828160000) one for one, in camelCase.
 * Nothing in this module computes pay: a clearance says a departure is *administratively* closed,
 * and "may not approve final settlement" is a named boundary in that same job description.
 */

/** A department that has to sign off before a leaver is administratively closed. */
export type ClearanceStation = {
  stationKey: string;
  label: string;
  description: string | null;
  /** Who in the business owns this station — shown so HR chases the right person. */
  responsible: string | null;
  sortOrder: number;
};

export type ClearanceItemStatus = "pending" | "cleared" | "blocked" | "waived";

/**
 * `open`      — at least one station still pending or blocked.
 * `ready`     — every station decided; the settlement may be released.
 * `released`  — HR recorded that the final settlement was handed over. Frozen.
 * `cancelled` — the departure did not happen. Frozen.
 *
 * Only the database moves a checklist between `open` and `ready`
 * (`phx_hr_clearance_refresh_status`). No page and no service recomputes it.
 */
export type ClearanceChecklistStatus = "open" | "ready" | "released" | "cancelled";

export type ClearanceItem = {
  id: string;
  stationKey: string;
  /**
   * Snapshotted at the moment the checklist opened, deliberately not joined live. A station
   * renamed in 2027 must not silently rewrite what a 2026 clearance said was signed off.
   */
  stationLabel: string;
  sortOrder: number;
  status: ClearanceItemStatus;
  /** Required by a CHECK constraint for `blocked` and `waived`. Always null otherwise. */
  reason: string | null;
  /** What is owed, when a station is blocked on money. Null in every other status. */
  amountDue: number | null;
  evidenceNote: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Resolved from the employee directory for display. Null when the id names nobody. */
  decidedByName: string | null;
};

export type ClearanceChecklist = {
  id: string;
  resignationId: string;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  lastWorkingDate: string | null;
  status: ClearanceChecklistStatus;
  openedAt: string;
  openedBy: string | null;
  readyAt: string | null;
  settlementReleasedAt: string | null;
  settlementReleasedBy: string | null;
  settlementReleasedByName: string | null;
  settlementNote: string | null;
  notes: string | null;
  items: ClearanceItem[];
  /** Stations still `pending` or `blocked` — the exact set the release gate refuses on. */
  outstandingLabels: string[];
  clearedCount: number;
  totalCount: number;
  /** Sum of `amountDue` across blocked stations. 0 when nothing is owed. */
  amountOutstanding: number;
  /**
   * Last working date has passed and the settlement is still unreleased. This is the number the
   * page leads with: an unreleased clearance is somebody waiting to be paid off.
   */
  isOverdue: boolean;
  /** Whole days since the last working date. Negative before it, null when there is no date. */
  daysSinceLastWorkingDate: number | null;
};

export type ClearanceStats = {
  open: number;
  ready: number;
  released: number;
  cancelled: number;
  overdue: number;
  blockedStations: number;
  amountOutstanding: number;
};

/**
 * A resignation that has no clearance checklist at all.
 *
 * Every resignation recorded from now on opens one automatically (trg_hr_clearance_on_resignation),
 * so this list exists for the ones that predate the trigger - 54 of them on the day this shipped,
 * including both HR leavers. Without it those departures are invisible to this module and the
 * trigger's own promise that "HR can open one by hand" has nowhere to happen.
 *
 * Deliberately NOT backfilled in the migration. Most of those 54 left months ago and were settled
 * outside Phoenix; opening a checklist for each would have manufactured dozens of permanently
 * overdue rows that nobody owes anything on, which is the misleading-zero trap wearing a different
 * hat. Offering them instead lets HR Operations open the ones that are real and ignore the rest.
 */
export type ClearanceAwaitingResignation = {
  resignationId: string;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  lastWorkingDate: string | null;
};

export type ClearanceDashboardData = {
  checklists: ClearanceChecklist[];
  stations: ClearanceStation[];
  stats: ClearanceStats;
  /** Resignations with no checklist yet, recent first. See the type above for why not backfilled. */
  awaiting: ClearanceAwaitingResignation[];
  /** False when the migration has not reached this environment yet. */
  schemaReady: boolean;
};

export type DecideClearanceItemInput = {
  itemId: string;
  status: ClearanceItemStatus;
  reason?: string | null;
  evidenceNote?: string | null;
  amountDue?: number | null;
};

export type ReleaseClearanceInput = {
  checklistId: string;
  note?: string | null;
};
