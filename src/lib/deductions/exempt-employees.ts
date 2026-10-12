// People the owner has taken OUT of every automated deduction type.
//
// Owner, 2026-10-12: "remove sama mossaad and reham from any deduction type". Both are
// head-office staff with no way to leave a record the detection engines can read, so every
// absence the engines find for them is the engines' blind spot, not an absence.
//
//   - A-3     Samaa Mosaad Said Khalil          (QPPV)
//   - OF-0004 Reham Mahmoud Abdelaal Elwiy      (Regulatory Affairs Supervisor)
//
// Applied where drafts are produced, never where a figure is read, so no connector needs to know:
//   - collect.ts drops them before the connector's output reaches the ledger (and, for the
//     connectors that reconcile, a re-run supersedes their still-live rows);
//   - insertCandidateDrafts drops them from any automated writer (the Employee Day-by-Day Report
//     writes through it) but NEVER from a manual HR entry — `autoDecideStatus` marks that path, and a
//     manual loan or "other" line is the owner's own deliberate act;
//   - the Daily Deductions module drops them from every connector's range tally.
//
// Rows already written for a published month are history and are not touched here.

import { compactDeductionsHrId } from "./candidate-key.ts";
import type { DeductionsCandidateDraft } from "./types.ts";

export const DEDUCTION_EXEMPT_EMPLOYEES: ReadonlyArray<{ hrId: string; name: string }> = [
  { hrId: "A-3", name: "Samaa Mosaad Said Khalil" },
  { hrId: "OF-0004", name: "Reham Mahmoud Abdelaal Elwiy" },
];

const EXEMPT_COMPACT_KEYS: ReadonlySet<string> = new Set(
  DEDUCTION_EXEMPT_EMPLOYEES.map((entry) => compactDeductionsHrId(entry.hrId)).filter((key): key is string => Boolean(key)),
);

export function isDeductionExemptEmployee(hrId: string | null | undefined): boolean {
  const key = compactDeductionsHrId(String(hrId ?? ""));
  return Boolean(key) && EXEMPT_COMPACT_KEYS.has(key as string);
}

/** Splits a connector's drafts into the ones that may be raised and the exempt ones left out. */
export function dropDeductionExemptDrafts<T extends Pick<DeductionsCandidateDraft, "employeeHrId">>(
  drafts: readonly T[],
): { kept: T[]; droppedCount: number } {
  const kept = drafts.filter((draft) => !isDeductionExemptEmployee(draft.employeeHrId));
  return { kept, droppedCount: drafts.length - kept.length };
}
