export type JourneyStatus = "passed" | "failed" | "skipped";

export interface JourneyDefinition {
  id: string;
  name: string;
  route: string;
  role: string;
  /**
   * Journeys that would mutate data must set this and self-skip unless
   * SYNTHETIC_ALLOW_MUTATION=true (see README "How to add a new journey").
   * One journey sets it: the Outstation Expenses export, whose download writes an audit row.
   */
  mutates?: boolean;
}

export interface JourneyResult {
  journeyId: string;
  journeyName: string;
  route: string;
  role: string;
  status: JourneyStatus;
  durationMs: number;
  errors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  screenshotPath?: string;
  recommendation?: string;
  /** The reason a check gave when it skipped itself. Absent on a check that simply never ran. */
  skipReason?: string;
}
