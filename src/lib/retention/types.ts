/**
 * Retention register — the domain types behind HR Business Partner job description §3,
 * "conduct structured stay discussions and exit interviews, summarised into themes".
 *
 * These shapes mirror `hr_retention_*` (migration 20260828160000). The register holds what an
 * employee said in confidence about their manager and their pay, which is why the `retention`
 * permission resource is held by HR Advisory alone and never by HR Operations.
 */

/**
 * `stay` — held with someone still employed, to learn what keeps them and what would not.
 * `exit` — held with someone leaving.
 *
 * The kind decides which fields are required: a CHECK constraint forbids `retentionRisk` on an
 * exit conversation and `isRegrettable` on a stay one, so a roll-up can trust either without
 * filtering. A stay conversation carrying `isRegrettable` would silently join the turnover figures.
 */
export type RetentionConversationKind = "stay" | "exit";

/** How likely this person is to leave, in the interviewer's judgement. Stay conversations only. */
export type RetentionRisk = "low" | "medium" | "high";

/**
 * `driver`  — what holds someone here, or what was good about the job.
 * `blocker` — what pushed them out, or what would.
 *
 * One theme can legitimately be both: pay is often the reason someone stays and the reason they
 * nearly did not.
 */
export type RetentionThemeSentiment = "driver" | "blocker";

export type RetentionTheme = {
  themeKey: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type RetentionConversationTheme = {
  themeKey: string;
  /** Snapshotted from the catalogue at read time; falls back to the key if a theme is retired. */
  label: string;
  sentiment: RetentionThemeSentiment;
  note: string | null;
};

export type RetentionConversation = {
  id: string;
  kind: RetentionConversationKind;
  employeeHrId: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  conductedOn: string;
  conductedBy: string | null;
  conductedByName: string | null;
  resignationId: string | null;
  retentionRisk: RetentionRisk | null;
  /** Exit only. Losing someone you wanted to keep is a different event from someone leaving. */
  isRegrettable: boolean | null;
  wouldRejoin: boolean | null;
  summary: string;
  followUpAction: string | null;
  followUpDue: string | null;
  followUpDoneAt: string | null;
  /**
   * A follow-up with a due date in the past and nothing recorded against it. Stay conversations
   * are worth nothing without follow-through, and that is the half that usually gets dropped.
   */
  followUpOverdue: boolean;
  themes: RetentionConversationTheme[];
  createdAt: string;
  /** The row's version. An edit sends it back as expectedUpdatedAt, so a stale screen cannot overwrite a newer save. */
  updatedAt: string;
};

/** One row of the themes roll-up — the "summarised into themes" the job description asks for. */
export type RetentionThemeRollup = {
  themeKey: string;
  label: string;
  driverCount: number;
  blockerCount: number;
  /** Blockers named in exit conversations only — why people actually left. */
  exitBlockerCount: number;
  /** Drivers named in stay conversations only — what is holding the people still here. */
  stayDriverCount: number;
  total: number;
};

export type RetentionStats = {
  stayCount: number;
  exitCount: number;
  highRisk: number;
  regrettableExits: number;
  wouldRejoin: number;
  openFollowUps: number;
  overdueFollowUps: number;
  /**
   * Exit conversations recorded against the resignations in the same window, as a percentage.
   * Null when there were no departures to interview — a rate over an empty base is a lie, not a
   * zero, and the page says "no departures" instead of "0% covered".
   */
  exitCoveragePercent: number | null;
  resignationsInWindow: number;
};

export type RetentionDashboardData = {
  conversations: RetentionConversation[];
  themes: RetentionTheme[];
  rollup: RetentionThemeRollup[];
  stats: RetentionStats;
  /** False when the migration has not reached this environment yet. */
  schemaReady: boolean;
};

export type RetentionThemeInput = {
  themeKey: string;
  sentiment: RetentionThemeSentiment;
  note?: string | null;
};

export type CreateRetentionConversationInput = {
  kind: RetentionConversationKind;
  employeeHrId: string;
  conductedOn: string;
  summary: string;
  /** Stay only — required for a stay conversation, rejected on an exit one. */
  retentionRisk?: RetentionRisk | null;
  /** Exit only — required for an exit conversation, rejected on a stay one. */
  isRegrettable?: boolean | null;
  wouldRejoin?: boolean | null;
  resignationId?: string | null;
  followUpAction?: string | null;
  followUpDue?: string | null;
  themes?: RetentionThemeInput[];
};

export type UpdateRetentionConversationInput = {
  id: string;
  summary?: string;
  retentionRisk?: RetentionRisk | null;
  isRegrettable?: boolean | null;
  wouldRejoin?: boolean | null;
  followUpAction?: string | null;
  followUpDue?: string | null;
  /** Set true to stamp the follow-up as done, false to reopen it. */
  followUpDone?: boolean;
  themes?: RetentionThemeInput[];
  /**
   * The conversation's updatedAt as the editor's screen loaded it. The save is refused (409) when
   * the row has moved on since; absent, the server compares against its own read instead.
   */
  expectedUpdatedAt?: string | null;
};
