import { TelegramTemplateError } from "@/lib/notifications/telegram-template-types";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
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
  if (/<[a-z][\s\S]*>/i.test(text)) errors.push("Telegram templates must be plain text. HTML is not allowed.");
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
  if (/<[a-z][\s\S]*>/i.test(label)) errors.push("CTA label must be plain text. HTML is not allowed.");
  if (/\b(approve|approved|reject|rejected|decline|declined)\b/i.test(label)) {
    errors.push("Telegram CTA labels cannot be approval or rejection actions in notification-only mode.");
  }
  if (!url) errors.push("CTA URL is required when CTA is enabled.");
  if (/<[a-z][\s\S]*>/i.test(url)) errors.push("CTA URL must be plain text. HTML is not allowed.");
  if (unknownPlaceholders.length > 0) errors.push(`Unknown CTA placeholders: ${unknownPlaceholders.join(", ")}.`);

  return { errors, unknownPlaceholders };
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

export function renderTelegramTemplateText(text: string, variables: Record<string, unknown>, allowedPlaceholders: string[]) {
  const validation = validateTelegramTemplateText(text, allowedPlaceholders);
  if (validation.errors.length > 0) {
    throw new TelegramTemplateError("invalid_template", validation.errors.join(" "));
  }

  const missing = extractTelegramPlaceholders(text).filter((placeholder) => cleanText(variables[placeholder]) === "");
  if (missing.length > 0) {
    throw new TelegramTemplateError("missing_variables", `Missing required variables: ${missing.join(", ")}.`);
  }

  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => cleanText(variables[key]));
}
