// Recruitment / ATS — the shape of a WhatsApp message template, and what makes one valid.
//
// Validation lives apart from the store so the editor can check a draft as it is typed without a
// round trip, and the API can re-check the same rules server-side. Both call THESE functions: a
// second copy of the rules in the route is how a client-only check becomes the only check.

import { extractVariableKeys } from "@/lib/recruitment/whatsapp-templates/variables";

/** Groups the templates on screen. Free text, not an enum — he adds a category by typing one. */
export const DEFAULT_TEMPLATE_CATEGORY = "Interview";

export const TEMPLATE_NAME_MAX_LENGTH = 80;
export const TEMPLATE_CATEGORY_MAX_LENGTH = 40;

/**
 * WhatsApp's own text-message ceiling is 4096 characters, and the message travels inside a URL, so
 * the practical limit is lower still — a long body percent-encodes to roughly three times its size
 * and some browsers refuse a URL past ~8000 characters. 2000 leaves comfortable room for the
 * encoded form of an Arabic address, where every character costs nine bytes once escaped.
 */
export const TEMPLATE_BODY_MAX_LENGTH = 2000;

export type WhatsAppTemplate = {
  id: string;
  name: string;
  category: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
  /** 'any' = candidates and employees; 'employee' = kept off the candidate screen. */
  audience: "any" | "employee";
  /** Derived from the body on read — never stored, so it can never disagree with the text. */
  variableKeys: string[];
  updatedAt: string | null;
  updatedByHrId: string | null;
};

export type TemplateDraft = {
  name: string;
  category: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
};

/**
 * Everything wrong with a draft, as sentences a non-engineer can act on.
 *
 * Returns ALL the problems rather than the first, so the editor never plays whack-a-mole: fixing the
 * name and being told the body is too long is the interaction this avoids.
 */
export function templateDraftViolations(draft: Partial<TemplateDraft>): string[] {
  const problems: string[] = [];

  const name = (draft.name ?? "").trim();
  if (!name) problems.push("Give the template a name.");
  else if (name.length > TEMPLATE_NAME_MAX_LENGTH)
    problems.push(`Keep the name under ${TEMPLATE_NAME_MAX_LENGTH} characters.`);

  const category = (draft.category ?? "").trim();
  if (category.length > TEMPLATE_CATEGORY_MAX_LENGTH)
    problems.push(`Keep the category under ${TEMPLATE_CATEGORY_MAX_LENGTH} characters.`);

  const body = (draft.body ?? "").trim();
  if (!body) problems.push("Write the message.");
  else if (body.length > TEMPLATE_BODY_MAX_LENGTH)
    problems.push(
      `The message is ${body.length} characters — WhatsApp links stop working past about ${TEMPLATE_BODY_MAX_LENGTH}. Shorten it.`,
    );

  // An unclosed `{{` is the one typo that survives every other check and then reaches a candidate
  // as literal braces in the middle of an invitation. Counting the delimiters catches it while the
  // template is still being written.
  if (body) {
    const opens = (body.match(/\{\{/gu) ?? []).length;
    const closes = (body.match(/\}\}/gu) ?? []).length;
    if (opens !== closes) {
      problems.push("A placeholder is not closed properly — every {{name}} needs both braces.");
    } else if (opens > 0 && extractVariableKeys(body).length === 0) {
      problems.push("A placeholder is not readable — use letters, numbers and underscores, like {{interview_date}}.");
    }
  }

  return problems;
}
