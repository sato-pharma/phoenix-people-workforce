// Unified Deductions module: connector health assertions.
//
// The failure this exists to stop: a feeder that errors and returns an EMPTY
// result is indistinguishable from a feeder that legitimately found nothing.
// "The CRM sync is down" and "nobody missed a visit this month" both surface as
// zero candidates, and the month publishes successfully having deducted nothing
// — or, worse, having deducted everyone because their evidence never loaded.
//
// getBaseSalaryMap() in payroll/copilot/feeders.ts is the concrete case: on any
// query error it logs and returns an empty Map, so every amount silently
// resolves to null.
//
// Rule: a connector that cannot trust its inputs must FAIL, not return [].

export class DeductionsConnectorDegradedError extends Error {
  public readonly code = "DEDUCTIONS_CONNECTOR_DEGRADED" as const;
  public readonly connector: string;

  constructor(connector: string, reason: string) {
    super(
      `${connector} could not run against trustworthy data: ${reason}. No candidates were produced — this is deliberately treated as a failure rather than "no deductions", so nothing is published against incomplete data.`,
    );
    this.name = "DeductionsConnectorDegradedError";
    this.connector = connector;
  }
}

/**
 * Asserts a base-salary map actually loaded.
 *
 * An empty map is never legitimate: the company always has salaried employees,
 * so zero entries means the feeder failed. Without this, every day-based
 * candidate silently gets estimatedAmount = null.
 */
export function assertBaseSalaryMapLoaded(connector: string, map: Map<string, number>): void {
  if (map.size === 0) {
    throw new DeductionsConnectorDegradedError(
      connector,
      "the base-salary feeder returned no employees (it swallows query errors and returns an empty map, so this means the lookup failed, not that nobody has a salary)",
    );
  }
}

/**
 * Asserts a source scan returned something to reason about.
 *
 * Used where an empty source genuinely cannot be a real business state for a
 * whole month — e.g. company-wide CRM visits. Do NOT use it where zero is a
 * legitimate answer (a month with no unpaid vacations is perfectly normal).
 */
export function assertSourceScanned(connector: string, rowsScanned: number, sourceLabel: string): void {
  if (rowsScanned <= 0) {
    throw new DeductionsConnectorDegradedError(
      connector,
      `${sourceLabel} returned zero rows for the whole month, which cannot be a real business state — treat as a sync/outage problem`,
    );
  }
}
