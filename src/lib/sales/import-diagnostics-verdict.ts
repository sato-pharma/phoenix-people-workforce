/**
 * Which verdict the Sales Diagnostics screen is allowed to show for an analysed file.
 *
 * The screen used to choose its banner from the unmapped count ALONE:
 *
 *   unknowns > 0 ? "would block import" : "Fully recognized — this file would import cleanly"
 *
 * `analyze.validation.errorCount` was rendered a few lines below, in the "Strict checks" box, and
 * had no say in the banner. So a file with zero unmapped items and a dozen strict-check errors was
 * given a green tick reading "this file would import cleanly" — the one sentence on the screen a
 * person acts on, and the one most likely to be wrong.
 *
 * A green verdict now requires BOTH to be clean. Pure and exported so that property is testable
 * without rendering anything.
 */
export type ImportDiagnosticsTone = "success" | "warning" | "danger";

export function importDiagnosticsVerdict(input: {
  /** Distinct items the sheet could not map. */
  unmappedCount: number;
  /** Strict-check errors from the validation pass; 0 when validation did not run. */
  strictErrorCount: number;
}): ImportDiagnosticsTone {
  // A strict-check error outranks everything: it is the pass that decides whether the file is
  // usable at all, so it must never sit behind a green banner.
  if (input.strictErrorCount > 0) return "danger";
  if (input.unmappedCount > 0) return "warning";
  return "success";
}
