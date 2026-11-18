/**
 * Where a Super Admin can go to verify a Private Calendar review request — the closed list the
 * employee ticks, plus an escape hatch for anything else.
 *
 * Owner, 2026-11-15: the calendar disputes still offered "CRM / iReports360 (Double Visit)" as the
 * place to check, nine days after iReports360 was retired (6 November 2026). Phoenix CRM is where a
 * visit, a double visit and a day activity (training, meeting, travel…) are recorded now, so the
 * option names Phoenix CRM. Pure and client-safe: the employee's form imports the list, and every
 * reader of a stored request passes the text through {@link currentVerificationSourceText}, so a
 * request filed before the rename reads the current name rather than the retired system's.
 */

export const PHOENIX_CRM_VERIFICATION_SOURCE = "Phoenix CRM (visit, double visit or day activity)";

/** The option the form offered until 2026-11-15. Stored requests still carry it; it is never offered again. */
export const RETIRED_CRM_VERIFICATION_SOURCE = "CRM / iReports360 (Double Visit)";

export const verificationSourceOptions = [
  PHOENIX_CRM_VERIFICATION_SOURCE,
  "Fingerprint / Attendance Device",
  "Manager Confirmation",
  "HR Records (Vacation / Excuse Approval)",
  "Other",
] as const;

/**
 * A stored "where to verify" text with the retired CRM option renamed. The text is the employee's
 * ticked options joined by ", " (and "Other: …" with his own words), so only that exact option is
 * replaced — anything he typed himself is left as he wrote it.
 */
export function currentVerificationSourceText(text: string): string;
export function currentVerificationSourceText(text: string | null): string | null;
export function currentVerificationSourceText(text: string | null): string | null {
  if (text == null) return text;
  // A request filed 16-18 Nov 2026 stored "Confirmed by <name>" at submission, before anyone had answered: it names who
  // was ASKED. Read as what it always was, so the day's proof never says somebody confirmed what nobody has.
  return text.split(RETIRED_CRM_VERIFICATION_SOURCE).join(PHOENIX_CRM_VERIFICATION_SOURCE).replace(/^Confirmed by /, "Named confirmer: ");
}
