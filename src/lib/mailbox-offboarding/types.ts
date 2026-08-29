/**
 * Mailbox offboarding — domain types for the Turbify leaver register.
 *
 * These mirror `mailbox_offboarding_tasks` (migration 20260830001000) one for one, in camelCase.
 * Nothing here talks to Turbify: Turbify publishes no email API, so every field records what a
 * named admin said they did in the control panel, never what Phoenix observed.
 */

/** Where a task came from. `backfill` marks the 52 leavers the register found on day one. */
export type MailboxTaskSource = "resignation" | "backfill" | "sweep";

/**
 * `pending`        — nothing recorded.
 * `in_progress`    — a step is recorded but the mailbox is NOT shut.
 * `revoked`        — the door is closed. Requires the mailbox deleted or suspended, or BOTH the
 *                    password reset and the app passwords cleared. A reset alone never earns this.
 * `not_applicable` — no mailbox, or handled outside Phoenix. Requires a written reason.
 *
 * Only `phx_mailbox_offboarding_refresh_status` writes this. No page and no service recomputes it.
 */
export type MailboxTaskStatus = "pending" | "in_progress" | "revoked" | "not_applicable";

/**
 * What became of the mailbox itself.
 *
 * Only `deleted` and `suspended` revoke anything. `forwarding` and `retained` both describe a
 * mailbox that is still alive and still reachable — they are dispositions, not revocations, and
 * the status function treats them that way.
 */
export type MailboxDisposition = "deleted" | "suspended" | "forwarding" | "retained";

/** The steps an admin can record. `reopen` is the correction path for a mis-recorded row. */
export type MailboxStep =
  | "password_reset"
  | "app_passwords_cleared"
  | "disposition"
  | "not_applicable"
  | "reopen";

export type MailboxOffboardingTask = {
  id: string;
  employeeHrId: string;
  /** Snapshotted when the task opened — a later directory edit must not rewrite the trail. */
  employeeName: string;
  workEmail: string;
  jobTitle: string | null;
  lastWorkingDate: string | null;
  status: MailboxTaskStatus;

  passwordResetAt: string | null;
  passwordResetBy: string | null;
  /** Resolved from the directory for display. Null when the id names nobody. */
  passwordResetByName: string | null;

  appPasswordsClearedAt: string | null;
  appPasswordsClearedBy: string | null;
  appPasswordsClearedByName: string | null;

  disposition: MailboxDisposition | null;
  dispositionAt: string | null;
  dispositionBy: string | null;
  dispositionByName: string | null;

  forwardingTo: string | null;
  forwardingExpiresOn: string | null;

  reason: string | null;
  note: string | null;
  source: MailboxTaskSource;
  openedAt: string;
  openedBy: string | null;
  revokedAt: string | null;

  /**
   * Last working date has passed and the mailbox is still not revoked. This is the number the page
   * leads with: an overdue row is a live credential belonging to someone who has left.
   */
  isOverdue: boolean;
  /** Days since the last working date, 0 when it has not passed or is unknown. */
  daysOverdue: number;
  /**
   * True when the password was reset but the app passwords were not cleared. The most dangerous
   * state in the register, because it is the one that LOOKS finished from the control panel while
   * every phone and Outlook client the leaver set up is still connected.
   */
  isHalfRevoked: boolean;
  /** Forwarding whose expiry has passed — set at an exit and never torn down. */
  isForwardingExpired: boolean;
};

export type MailboxOffboardingStats = {
  total: number;
  pending: number;
  inProgress: number;
  revoked: number;
  notApplicable: number;
  overdue: number;
  /** How many rows sit in the reset-but-not-cleared state. Called out on its own for a reason. */
  halfRevoked: number;
  forwardingExpired: number;
};

/** A leaver with a mailbox and no task — the sweep's input, surfaced so the gap is never silent. */
export type MailboxAwaitingLeaver = {
  employeeHrId: string;
  employeeName: string;
  workEmail: string;
  jobTitle: string | null;
  lastWorkingDate: string | null;
  employmentStatus: string | null;
};

export type MailboxOffboardingDashboardData = {
  tasks: MailboxOffboardingTask[];
  awaiting: MailboxAwaitingLeaver[];
  stats: MailboxOffboardingStats;
  /** The Turbify control-panel URL the page deep-links to. Surfaced so the UI never hardcodes it. */
  controlPanelUrl: string;
};

export type RecordMailboxStepInput = {
  taskId: string;
  step: MailboxStep;
  disposition?: MailboxDisposition | null;
  forwardingTo?: string | null;
  forwardingExpiresOn?: string | null;
  reason?: string | null;
  note?: string | null;
};
