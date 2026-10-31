import { skillsSurveyOldFormRetiredMessage } from "@/lib/coaching/skills-survey/vocabulary";

/**
 * The old coaching report form takes no new reports (owner, 2026-10-31): the Team Coaching Skills
 * Survey replaced it. Every path that CREATED an old-form report refuses with this error — the form's
 * own create and the workbook import, which turned each row into a report. Everything that READS the
 * 122 old reports, and a rep acknowledging one he already has, keeps working unchanged.
 *
 * The coaching routes answer it with 410 Gone (app/api/coaching/_lib/route-utils.ts), so a stale
 * screen reads the sentence below rather than a server error.
 */
export class CoachingOldFormRetiredError extends Error {
  constructor() {
    super(skillsSurveyOldFormRetiredMessage);
    this.name = "CoachingOldFormRetiredError";
  }
}

/** Always throws — called first by every old-form create path. */
export function refuseOldCoachingFormCreate(): void {
  throw new CoachingOldFormRetiredError();
}
