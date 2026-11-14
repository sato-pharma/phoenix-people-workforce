/**
 * The reason a check gave when it skipped itself.
 *
 * `test.skip(condition, "why")` leaves an annotation of type "skip" carrying that sentence. A check
 * skipped with no sentence, and one that never ran because the sign-in step before it failed, leave
 * none — and the run is filed as a warning for those (src/lib/synthetic-journeys/overall-status.ts).
 */
export function declaredSkipReason(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
): string | undefined {
  for (const annotation of annotations) {
    if (annotation.type !== "skip") continue;
    const reason = annotation.description?.trim();
    if (reason) return reason;
  }
  return undefined;
}
