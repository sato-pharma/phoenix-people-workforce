/**
 * The step revision a downloaded step file carries (payroll audit 2026-11-14, finding 1; owner: "Refuse
 * and reload"). Written into the workbook's keywords by exports/step-template.ts and read back by
 * imports/step-parser.ts, so an upload of a file built before somebody else's save is refused rather
 * than written over the newer figures. A document property, never a cell: the sheet's layout is unchanged.
 */
export const STEP_FILE_REVISION_PREFIX = "phoenix-step-revision:";

/**
 * How the server's stale-step refusal opens (run-service.ts, assertStepUnchangedSince). Shared with the
 * step screen, which offers "Reload the step" on exactly this refusal. Pure on purpose: the screen imports it.
 */
export const STALE_STEP_OPENING = "This step was changed after you opened it";

/** The revision of a step that had never been saved when the file was built. */
export const STEP_FILE_NEVER_SAVED = "never-saved";

/**
 * What the keywords say. `undefined`: the file carries no revision (built before this, or made by hand),
 * so it cannot be judged and is let through. `null`: the step had never been saved.
 */
export function readStepFileRevision(keywords: string | null | undefined): string | null | undefined {
  const text = String(keywords ?? "");
  const at = text.indexOf(STEP_FILE_REVISION_PREFIX);
  if (at < 0) return undefined;
  const value = text.slice(at + STEP_FILE_REVISION_PREFIX.length).trim().split(/\s/)[0] ?? "";
  if (!value) return undefined;
  return value === STEP_FILE_NEVER_SAVED ? null : value;
}
