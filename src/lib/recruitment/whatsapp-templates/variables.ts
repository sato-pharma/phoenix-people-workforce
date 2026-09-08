// Recruitment / ATS — the variable engine behind the WhatsApp message templates.
//
// A template is plain text the owner types, with `{{placeholders}}` wherever a value changes per
// candidate. This module is the whole contract between "what he typed" and "what gets sent":
// it finds the placeholders, decides which are filled for him and which he must type, and renders
// the final message.
//
// THE PLACEHOLDER LIST IS DERIVED FROM THE BODY, NEVER FROM A FIXED SCHEMA. That is the entire
// reason this feature answers "full control": the moment he types `{{room_number}}` into a template,
// a "Room number" box appears on the send screen. Nothing here needs editing to allow a new field,
// and there is no migration behind adding one. A hard-coded field list would have meant a developer
// for every new question, which is the opposite of what was asked for.

/** Auto-filled placeholders — resolved from the candidate row and the sender, never typed. */
export const AUTO_VARIABLE_KEYS = [
  "candidate_name",
  "candidate_first_name",
  "job_title",
  "sender_name",
  "company_name",
  // Read through the candidate's application to its offer LETTER. Auto only when that link exists
  // and the letter carries a date; otherwise it stays empty and the sender types it, which is the
  // same refuse-rather-than-guess rule every other field here follows.
  "start_date",
  // The joining documents a person brings in themselves, read LIVE from the Hiring Documents
  // checklist. Renders as a bullet block, so a body says `{{document_list}}` on a line of its own.
  //
  // NOT CANDIDATE-DERIVED — it is the same list for everybody, which is why a MANUAL send fills it
  // too. Empty when the checklist cannot be read or holds nothing, and an empty value is REPORTED
  // missing: a document request with no documents in it is not a message worth sending.
  "document_list",
  // The end of the 90-day probation window, filled only when the target is an EMPLOYEE. Derived
  // through the owner-locked `probationEndDate` helper (hire + 90 days), never read from
  // `employees.probation_end_date` — that column is NULL for every employee and always has been.
  "probation_end_date",
] as const;

export type AutoVariableKey = (typeof AUTO_VARIABLE_KEYS)[number];

/**
 * Auto keys that ONLY the employee path can answer.
 *
 * A template using one of these can never be completed from a CV — a candidate has no hire date, so
 * there is no probation window to speak of — and the send screen would offer it, refuse it, and ask
 * the recruiter for a date that does not exist. So it is not offered there at all.
 *
 * DERIVED FROM THE BODY, NEVER FROM THE CATEGORY. Keying this on `category === "Probation"` would
 * work this afternoon and break the first time the owner renames the category, which he can do from
 * the template editor with no warning that anything depends on the old word. It would also miss a
 * probation-shaped template filed under a different name, and hide a perfectly fillable one that
 * happens to sit in that category. The placeholders a template uses are what actually decide whether
 * it can be filled, so they are what decides where it is offered.
 */
export const EMPLOYEE_ONLY_VARIABLE_KEYS = ["probation_end_date"] as const;

const EMPLOYEE_ONLY_KEY_SET = new Set<string>(EMPLOYEE_ONLY_VARIABLE_KEYS);

/**
 * True when this body needs something only an employee record can supply.
 *
 * Used to decide which templates a CV screen offers. The employee screen and the template MANAGER
 * are unaffected: the manager must show every template, because it is where they are written.
 */
export function requiresEmployeeTarget(body: string): boolean {
  return extractVariableKeys(body).some((key) => EMPLOYEE_ONLY_KEY_SET.has(key));
}


const AUTO_KEY_SET = new Set<string>(AUTO_VARIABLE_KEYS);

/**
 * Placeholders we suggest in the editor. NOT a whitelist — a body may use any key at all, and an
 * unknown one simply becomes a box to type in. These exist so the editor can offer a starting
 * vocabulary rather than leaving him to invent names with nothing to copy.
 */
export const SUGGESTED_VARIABLE_LABELS: Record<string, string> = {
  address: "Address",
  candidate_first_name: "Candidate first name (auto)",
  candidate_name: "Candidate full name (auto)",
  company_name: "Company name (auto)",
  document_list: "Joining documents (auto, from the Hiring Documents checklist)",
  dress_code: "Dress code",
  interview_date: "Interview date",
  interview_time: "Interview time",
  interviewer_name: "Interviewer name",
  interviewer_title: "Interviewer job title",
  job_title: "Job title applied for (auto)",
  probation_end_date: "Probation end date (auto, for an employee)",
  location_link: "Location (Google Maps link)",
  sender_name: "Your name (auto)",
  start_date: "First working day",
  website: "Web site",
};

/**
 * `{{ key }}` with optional inner spacing. Deliberately narrow: letters, digits and underscore only.
 *
 * Anything else — a stray `{{`, an emoji, an Arabic word between braces — is NOT a placeholder and
 * is left in the message exactly as typed. That direction is chosen on purpose: a body that half
 * matches must render as the literal text he wrote, because the failure a recruiter would never
 * catch is a placeholder silently deleted from a message that then goes out with a hole in it.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu;

/** A placeholder key normalized the way both the editor and the renderer must agree on. */
export function normalizeVariableKey(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isAutoVariable(key: string): boolean {
  return AUTO_KEY_SET.has(normalizeVariableKey(key));
}

/**
 * Every placeholder in a body, in the order it first appears, de-duplicated.
 *
 * Order is first-appearance rather than alphabetical so the send screen reads top-to-bottom in the
 * same order as the message itself — the recruiter fills the form by reading down the preview.
 */
export function extractVariableKeys(body: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const key = normalizeVariableKey(match[1] ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** The placeholders a human must type for this body — everything the system cannot resolve itself. */
export function manualVariableKeys(body: string): string[] {
  return extractVariableKeys(body).filter((key) => !isAutoVariable(key));
}

/**
 * A human label for a placeholder key. Falls back to the key itself, title-cased, so a key nobody
 * registered still reads as words on the send screen rather than as `room_number`.
 */
export function variableLabel(key: string): string {
  const normalized = normalizeVariableKey(key);
  const known = SUGGESTED_VARIABLE_LABELS[normalized];
  if (known) return known.replace(" (auto)", "");
  return normalized
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type RenderResult = {
  /** The message as it will reach WhatsApp. */
  text: string;
  /** Placeholders that had no value — the send screen blocks on these rather than sending a hole. */
  missing: string[];
};

/**
 * Substitute values into a body.
 *
 * A placeholder with no value is REPORTED, not silently emptied, and the caller refuses the send.
 * The alternative — rendering "Dear ," — is the one outcome that reaches a real candidate and
 * cannot be taken back, so an unfilled field is treated as an error and not as an empty string.
 *
 * Values are inserted verbatim. No escaping is applied and none is wanted: the output is plain text
 * destined for a WhatsApp message box, not HTML, and stripping characters here would mangle the
 * Arabic addresses and bullet characters the owner's own templates are built from.
 */
export function renderTemplate(body: string, values: Record<string, string | null | undefined>): RenderResult {
  const missing: string[] = [];
  const seenMissing = new Set<string>();

  const text = body.replace(PLACEHOLDER_PATTERN, (whole, rawKey: string) => {
    const key = normalizeVariableKey(rawKey);
    const value = values[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) {
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missing.push(key);
      }
      // Left as the literal placeholder so a preview shows exactly where the hole is. The send is
      // refused on `missing` regardless, so this text can never be what leaves the building.
      return whole;
    }
    return trimmed;
  });

  return { missing, text };
}
