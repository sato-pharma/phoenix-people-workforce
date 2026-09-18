// The confidence a customer pick on the normalizer is saved with.
//
// A confidence describes ONE brick: the one the suggestion step chose. Until 2026-09-18 a pick changed
// by hand - in the row's dropdown, by bulk map or by a group assign - kept the suggestion's number, so
// the saved confidence described a brick that was no longer the one being saved, and a person's own
// decision was stored as if it were a guess of the suggestion's strength. A pick that is not the
// suggestion's own is a person's decision and carries no confidence at all.

/** Brick ids compare the way saveMappings keys them: trimmed, case-insensitive. */
function sameBrick(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * The suggestion's confidence while the pick is still the suggestion's brick; otherwise undefined.
 * Picking the suggested brick again after changing it restores the number - it describes that brick.
 */
export function pickConfidence(
  pick: string | undefined,
  suggestedPick: string | undefined,
  confidence: number | undefined,
): number | undefined {
  if (!pick || !suggestedPick || typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  return sameBrick(pick, suggestedPick) ? confidence : undefined;
}
