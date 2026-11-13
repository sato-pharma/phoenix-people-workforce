import type { RunPhase } from "./types.ts";

/**
 * THE AUTOMATED PAYROLL RUN MACHINE, WRITTEN DOWN (audit item REC-005).
 *
 * run-service.ts moves a run between phases at six places, each one a
 * `claimTransition(runId, <the phases it may leave from>, "<label>")` followed by the phase write
 * (see claimTransition — audit finding 50). Nothing in those six places reads this table: the run
 * machine moves money, so it is DESCRIBED here and registered in `workflow_registry_modules`
 * (module `automated_payroll_runs`, migration 20261113201813) for the Workflow Control map, and it
 * is deliberately NOT routed through the registry at runtime.
 *
 * tests/workflow-registry-coverage.test.ts holds the three copies together: every claim site in
 * run-service.ts must match one row here by its label and its from-phases, the phase it then writes
 * must be this row's `to`, and the registry seed must equal this table. Change a claim site and
 * this table in the same change, or that test goes red.
 */
export const automatedPayrollRunWorkflowRegistryModuleKey = "automated_payroll_runs";

export type AutomatedPayrollRunTransition = {
  /** The registry action key. */
  action: "cancel" | "confirm_part1" | "reopen_part1" | "confirm_part2" | "reopen_part2" | "publish";
  from: readonly RunPhase[];
  to: RunPhase;
  /** The label run-service.ts passes to claimTransition, word for word. */
  claimLabel: string;
};

export const AUTOMATED_PAYROLL_RUN_TRANSITIONS: readonly AutomatedPayrollRunTransition[] = [
  { action: "cancel", from: ["part1", "part2", "ready"], to: "cancelled", claimLabel: "Cancelling this run" },
  { action: "confirm_part1", from: ["part1"], to: "part2", claimLabel: "Confirming Part 1" },
  { action: "reopen_part1", from: ["part2"], to: "part1", claimLabel: "Reopening Part 1" },
  { action: "confirm_part2", from: ["part2"], to: "ready", claimLabel: "Confirming Part 2" },
  { action: "reopen_part2", from: ["ready"], to: "part2", claimLabel: "Reopening Part 2" },
  { action: "publish", from: ["ready"], to: "published", claimLabel: "Publishing to payslips" },
];
