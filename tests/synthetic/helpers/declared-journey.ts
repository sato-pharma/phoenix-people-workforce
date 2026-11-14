/**
 * The page and role a check names BEFORE it skips itself.
 *
 * Every check hands its page to `runJourney`, which reports it. A check that skips itself stops on
 * its first line and never gets that far, so the reporter had nothing to print and wrote the word
 * "unknown" — on the Synthetic Journeys page the Outstation Expenses export read "unknown · skipped"
 * on all 1,083 runs from 9 September to 14 November 2026, although the check knows exactly which
 * page it is for.
 *
 * So a check that may skip itself leaves a note first — `testInfo.annotations.push(journeyAnnotation(journey))`
 * — and the reporter reads it back when the check never reported (helpers/reporter.ts).
 *
 * Kept free of imports, like skip-reason.ts, so the reporter and the tests can both read it.
 */

export const JOURNEY_ANNOTATION_TYPE = "journey";

export interface DeclaredJourney {
  id: string;
  route: string;
  role: string;
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The note a check leaves on itself. Only the three fields the report prints are carried. */
export function journeyAnnotation(journey: DeclaredJourney): { type: string; description: string } {
  return {
    type: JOURNEY_ANNOTATION_TYPE,
    description: JSON.stringify({ id: journey.id, route: journey.route, role: journey.role }),
  };
}

/** The journey a check declared, or undefined when it left no note or the note cannot be read. */
export function declaredJourney(
  annotations: ReadonlyArray<{ type: string; description?: string }>,
): DeclaredJourney | undefined {
  for (const annotation of annotations) {
    if (annotation.type !== JOURNEY_ANNOTATION_TYPE || !annotation.description) continue;
    try {
      const parsed = JSON.parse(annotation.description) as Partial<DeclaredJourney> | null;
      if (parsed && isFilled(parsed.id) && isFilled(parsed.route) && isFilled(parsed.role)) {
        return { id: parsed.id.trim(), route: parsed.route.trim(), role: parsed.role.trim() };
      }
    } catch {
      // A note that is not ours, or was cut short. The next one may be readable.
    }
  }
  return undefined;
}
