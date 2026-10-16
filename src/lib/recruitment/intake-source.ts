/**
 * How a CV reached us, written for a person to read.
 *
 * `candidates.source` stores the intake channel as a bare lower-case code — `whatsapp`, `email` —
 * written by `cv-intake-service.ts`. That is a storage value, and the owner's standing rule is that
 * a screen shows human-readable names and never raw codes: a screening list printing "whatsapp"
 * forty times reads like a database dump, which is exactly the noise this exists to remove.
 *
 * The map lived privately inside `daily-cv-digest.ts`, where the same rule had already been applied
 * to the digest email. Two callers now need it, so it lives here rather than being copied — a second
 * copy is how "WhatsApp" in the email and "whatsapp" on the screen happened in the first place.
 */

/**
 * The values Phoenix writes itself: the two intake channels, and a person added from an empty cell
 * of the interview calendar. Anything else is somebody's own word and is kept verbatim.
 */
const SOURCE_LABELS: Record<string, string> = {
  email: "Email",
  interview_calendar: "Interview calendar",
  website: "Website",
  whatsapp: "WhatsApp",
};

export function intakeSourceLabel(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // Anything unrecognised is shown verbatim rather than folded into an "other" bucket — a value
  // somebody or something recorded is information, and the owner's rule is that text is never hidden.
  return SOURCE_LABELS[raw.toLowerCase()] ?? raw;
}
