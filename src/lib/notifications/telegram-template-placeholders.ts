import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

// True when the text holds `<` + a letter with a `>` anywhere after it — exactly what
// `/<[a-z][\s\S]*>/i` tested, found in one pass. That pattern restarts at every `<letter` and scans to
// the end each time, so a long run of `<a` with no `>` was quadratic. The earliest `<letter` is the
// only one that matters: any `>` after a later one is also after it.
function containsHtmlTag(value: string) {
  const open = /<[a-z]/i.exec(value);
  return open !== null && value.indexOf(">", open.index + 2) !== -1;
}

export function extractTelegramPlaceholders(text: string) {
  return Array.from(new Set(Array.from(text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)).map((match) => match[1])));
}

export function insertTelegramPlaceholder(text: string, placeholder: string, selectionStart: number, selectionEnd = selectionStart) {
  const safeStart = Math.max(0, Math.min(selectionStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, text.length));
  return `${text.slice(0, safeStart)}{{${placeholder}}}${text.slice(safeEnd)}`;
}

export function validateTelegramTemplateText(text: string, allowedPlaceholders: string[]) {
  const unknownPlaceholders = extractTelegramPlaceholders(text).filter((placeholder) => !allowedPlaceholders.includes(placeholder));
  const errors: string[] = [];
  if (!cleanText(text)) errors.push("Message text is required.");
  if (containsHtmlTag(text)) errors.push("Telegram templates must be plain text. HTML is not allowed.");
  if (unknownPlaceholders.length > 0) errors.push(`Unknown placeholders: ${unknownPlaceholders.join(", ")}.`);
  return { errors, unknownPlaceholders };
}

export function validateTelegramCta(input: {
  allowedPlaceholders: string[];
  ctaEnabled: boolean;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
}) {
  const errors: string[] = [];
  const label = cleanText(input.ctaLabel);
  const url = cleanText(input.ctaUrl);
  const unknownPlaceholders = extractTelegramPlaceholders(url).filter((placeholder) => !input.allowedPlaceholders.includes(placeholder));

  if (!input.ctaEnabled) return { errors, unknownPlaceholders };
  if (!label) errors.push("CTA label is required when CTA is enabled.");
  if (containsHtmlTag(label)) errors.push("CTA label must be plain text. HTML is not allowed.");
  if (/\b(approve|approved|reject|rejected|decline|declined)\b/i.test(label)) {
    errors.push("Telegram CTA labels cannot be approval or rejection actions in notification-only mode.");
  }
  if (!url) errors.push("CTA URL is required when CTA is enabled.");
  if (containsHtmlTag(url)) errors.push("CTA URL must be plain text. HTML is not allowed.");
  if (unknownPlaceholders.length > 0) errors.push(`Unknown CTA placeholders: ${unknownPlaceholders.join(", ")}.`);

  return { errors, unknownPlaceholders };
}

export type TelegramTemplateButtonInput = {
  enabled?: boolean;
  label?: string | null;
  type?: string | null;
  url?: string | null;
};

export const telegramTemplateButtonTypes = ["open_phoenix", "view_details", "custom"] as const;
export type TelegramTemplateButtonType = (typeof telegramTemplateButtonTypes)[number];

function isSafeButtonType(value: string) {
  return (telegramTemplateButtonTypes as readonly string[]).includes(value);
}

function approvalLabelBlocked(label: string) {
  return /\b(approve|approved|reject|rejected|decline|declined)\b/i.test(label);
}

function approvalLabelAllowedInPhoenix(label: string, url: string) {
  const normalizedLabel = cleanText(label).toLowerCase();
  const normalizedUrl = cleanText(url).toLowerCase();
  const isPhoenixDecision =
    normalizedUrl.includes("/leave-management/vacation-decision/") ||
    normalizedUrl.includes("/employee-portals/marketing-requests/decision/") ||
    normalizedUrl.includes("{{approveurl}}") ||
    normalizedUrl.includes("{{rejecturl}}") ||
    normalizedUrl.includes("{{returnurl}}");
  return isPhoenixDecision && (normalizedLabel === "approve in phoenix" || normalizedLabel === "reject in phoenix");
}

export function validateTelegramTemplateButtons(input: {
  allowedPlaceholders: string[];
  buttons?: TelegramTemplateButtonInput[] | null;
}) {
  const errors: string[] = [];
  const unknownPlaceholders: string[] = [];
  const enabledButtons = (input.buttons ?? []).filter((button) => button?.enabled !== false);

  if (enabledButtons.length > 3) errors.push("Telegram templates can include at most 3 action buttons.");

  enabledButtons.forEach((button, index) => {
    const label = cleanText(button.label);
    const url = cleanText(button.url);
    const type = cleanText(button.type) || "custom";
    const unknown = extractTelegramPlaceholders(url).filter((placeholder) => !input.allowedPlaceholders.includes(placeholder));
    unknownPlaceholders.push(...unknown);

    if (!isSafeButtonType(type)) errors.push(`Button ${index + 1} has an unsupported type.`);
    if (!label) errors.push(`Button ${index + 1} label is required.`);
    if (containsHtmlTag(label)) errors.push(`Button ${index + 1} label must be plain text. HTML is not allowed.`);
    if ((approvalLabelBlocked(label) && !approvalLabelAllowedInPhoenix(label, url)) || type === "approve" || type === "reject") {
      errors.push("Telegram action buttons cannot approve or reject unless they open a Phoenix confirmation page.");
    }
    if (!url) errors.push(`Button ${index + 1} URL is required.`);
    if (containsHtmlTag(url)) errors.push(`Button ${index + 1} URL must be plain text. HTML is not allowed.`);
    if (unknown.length > 0) errors.push(`Unknown button placeholders: ${unknown.join(", ")}.`);
  });

  return { errors, unknownPlaceholders: Array.from(new Set(unknownPlaceholders)) };
}

export function isSafeTelegramCtaUrl(value: string) {
  const url = cleanText(value);
  if (!url) return false;
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function renderTelegramCtaUrl(text: string, variables: Record<string, unknown>, allowedPlaceholders: string[]) {
  const rendered = renderTelegramTemplateText(text, variables, allowedPlaceholders);
  if (!isSafeTelegramCtaUrl(rendered)) {
    throw new TelegramTemplateError("invalid_cta_url", "CTA URL must be a Phoenix path or a valid web URL.");
  }
  return rendered;
}

export function renderTelegramTemplateText(
  text: string,
  variables: Record<string, unknown>,
  allowedPlaceholders: string[],
  // When provided, ONLY these placeholders are required — any other placeholder that
  // the live event omits renders to empty instead of throwing. This guarantees a
  // template that passes preview (complete sampleVariables) cannot throw at live send
  // because a real event legitimately omitted an optional variable. When omitted, every
  // placeholder is treated as required (back-compat, used by strict CTA-URL rendering).
  requiredPlaceholders?: string[],
) {
  const validation = validateTelegramTemplateText(text, allowedPlaceholders);
  if (validation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_template", validation.errors.join(" "));
  }

  const requiredSet = requiredPlaceholders ? new Set(requiredPlaceholders) : null;
  const missing = extractTelegramPlaceholders(text).filter(
    (placeholder) => cleanText(variables[placeholder]) === "" && (requiredSet ? requiredSet.has(placeholder) : true),
  );
  if (missing.length > 0) {
    throw new TelegramTemplateError("missing_variables", `Missing required variables: ${missing.join(", ")}.`);
  }

  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => cleanText(variables[key]));
}
