import {
  createOpenAiResponseText,
  hasOpenAiApiKey,
  OPENAI_EMAIL_MAX_OUTPUT_TOKENS,
  PhoenixOpenAiError,
} from "@/lib/ai/openai-client";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";

export type AiDraftMode = "composer" | "email_template";

export type AiDraftVariable = {
  label: string;
  sampleValue: string;
  token: string;
};

export type AiDraftRequest = {
  current: {
    bodyHtml?: string;
    closingText?: string;
    greeting?: string;
    previewText?: string;
    subject?: string;
  };
  instruction: string;
  mode: AiDraftMode;
  templateName?: string;
  variables: AiDraftVariable[];
};

export type AiDraftResult = {
  draft: {
    bodyHtml: string;
    closingText: string;
    greeting: string;
    previewText: string;
    subject: string;
  };
  warnings: string[];
};

export class AiAssistError extends Error {
  code: "ai_failed" | "ai_not_configured" | "ai_rate_limited";

  constructor(code: AiAssistError["code"], message: string) {
    super(message);
    this.name = "AiAssistError";
    this.code = code;
  }
}

// Mirrors the sanitizer in email-safety.ts INCLUDING its value grammar - values outside
// it (named colors, em units, ...) are silently dropped on save, so the model must be told
// the exact formats that survive.
const allowedHtmlSummary =
  "p, br, strong/b, em/i, u, s, ul, ol, li, a (https/mailto href only), hr, blockquote, " +
  "table/thead/tbody/tr/th/td, span. Inline style limited to: color and background-color " +
  "(hex like #b91c1c or rgb()/rgba() ONLY - named colors like 'red' are stripped), " +
  "font-size (px or pt, max 2 digits), font-family, letter-spacing (px), line-height, " +
  "text-align, direction; border, border-collapse, padding (px or %), width (px or %) on " +
  "table cells. The dir attribute (rtl/ltr) is allowed.";

const emailAiInstructions = [
  "You are the email writing assistant inside Phoenix Workforce, the HR system of an Egyptian pharma company.",
  "You draft or adjust HR email content while preserving the admin's intent and the system's template constraints.",
  "STRICT RULES:",
  "1. Placeholders: use ONLY placeholders listed in the request input, written exactly with double curly braces. NEVER invent new placeholders.",
  `2. bodyHtml must be simple valid HTML using only: ${allowedHtmlSummary} No <html>/<head>/<body> wrapper, no scripts, no images unless the user explicitly provides an https image URL.`,
  '3. subject, previewText, greeting and closingText are plain text (placeholders allowed). greeting looks like "Dear {{recipientName}},". previewText is one short line shown under the email title and as the inbox preview.',
  '4. The user may write in Arabic or English. Write the email in the language the user asks for; default to the language of the instruction. Give Arabic paragraphs dir="rtl" on their <p> tags.',
  "5. PRIORITY: the user's request ALWAYS wins over the current draft. When the user provides their own text or structure, follow it faithfully (fix grammar, improve flow, format it well) and do NOT fall back to the current draft's wording. Use the current draft as the base ONLY for adjustment requests like 'make it shorter' or 'more formal'.",
  "6. When the user writes bracketed fields like [Employee Name] or [Hiring Date], replace each with the closest placeholder from the allowed list. If nothing fits, keep the text without brackets.",
  '7. When the user lists label/value rows (Employee: ..., Title: ..., Area: ...), render them as a clean two-column HTML table: label cells bold with style="border: 1px solid #cbd5e1; padding: 8px; background-color: #f8fafc", value cells with style="border: 1px solid #cbd5e1; padding: 8px".',
  "8. Never return the current draft unchanged or nearly unchanged, and never answer with a single thin sentence when the user asked for structured content. Write a complete, polished email.",
  "9. Return all five fields required by the schema. For fields the user did not ask to change, keep or improve the current value instead of omitting it.",
].join("\n\n");

const emailDraftTextFormat = {
  format: {
    name: "phoenix_email_draft",
    schema: {
      additionalProperties: false,
      properties: {
        bodyHtml: {
          description: "Simple sanitized-email-compatible HTML fragment. No html/head/body wrapper.",
          type: "string",
        },
        closingText: {
          description: "Plain text closing line. Use an empty string only when intentionally blank.",
          type: "string",
        },
        greeting: {
          description: "Plain text greeting, for example Dear {{recipientName}},.",
          type: "string",
        },
        previewText: {
          description: "One short plain text inbox preview line.",
          type: "string",
        },
        subject: {
          description: "Plain text inbox subject.",
          type: "string",
        },
      },
      required: ["subject", "previewText", "greeting", "bodyHtml", "closingText"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

function buildPromptInput(input: AiDraftRequest, instruction: string) {
  const variableLines = input.variables
    .map((variable) => `- {{${variable.token}}} = ${variable.label} (example: ${variable.sampleValue})`)
    .join("\n");
  // Bracket-mapping examples must only mention placeholders that are actually in scope for
  // this template type - an out-of-scope example teaches the model a token that the
  // guardrail below would immediately strip again.
  const allowedTokenSet = new Set(input.variables.map((variable) => variable.token));
  const bracketExamples = ([
    ["[Employee Name]", "employeeName"],
    ["[Job Title]", "jobTitle"],
    ["[Area]", "area"],
    ["[Hiring Date]", "hireDate"],
    ["[Probation End Date] / [End Date]", "endDate"],
    ["[Days Remaining] / [X Days]", "duration"],
    ["[Manager]", "managerName"],
  ] as const)
    .filter(([, token]) => allowedTokenSet.has(token))
    .map(([label, token]) => `${label} -> {{${token}}}`)
    .join(", ");

  return [
    input.mode === "email_template"
      ? `Mode: reusable system email template "${input.templateName ?? ""}". It is sent automatically, so placeholders are filled with real employee data on every send.`
      : "Mode: one-off HR email in the manual composer.",
    "Allowed placeholders:",
    variableLines || "- (none available - do not use any placeholders)",
    bracketExamples ? `Bracket field examples in scope: ${bracketExamples}` : "No bracket field examples are in scope.",
    "Current draft as JSON:",
    JSON.stringify(input.current ?? {}),
    "User request:",
    instruction,
  ].join("\n\n");
}

function parseAiJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through to the error below */
      }
    }
  }
  throw new AiAssistError("ai_failed", "The AI reply was not in the expected format. Try again.");
}

function stripUnknownTokens(value: string, allowed: ReadonlySet<string>, warnings: string[]) {
  // Pass 1: keep well-formed allowed tokens (protected behind sentinels), drop well-formed
  // unknown ones. Pass 2: drop ANY remaining {{...}} residue - dotted, spaced, hyphenated or
  // nested inventions the token grammar does not match - so no literal braces ever ship in a
  // sent email. Sentinels survive sanitize-html untouched and are restored at the end.
  const protectedTokens: string[] = [];
  const known = value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
    if (!allowed.has(token)) {
      warnings.push(`Removed unknown variable {{${token}}} from the AI draft.`);
      return "";
    }
    protectedTokens.push(`{{${token}}}`);
    return `@@PHX_TOKEN_${protectedTokens.length - 1}@@`;
  });
  const cleaned = known.replace(/\{\{[\s\S]*?\}\}/g, () => {
    warnings.push("Removed malformed placeholder syntax from the AI draft.");
    return "";
  });
  return cleaned.replace(/@@PHX_TOKEN_(\d+)@@/g, (_match, index: string) => protectedTokens[Number(index)] ?? "");
}

function aiAssistErrorFromOpenAi(error: PhoenixOpenAiError) {
  switch (error.code) {
    case "not_configured":
      return new AiAssistError(
        "ai_not_configured",
        "The AI assistant is not configured yet. Add your OpenAI key as OPENAI_API_KEY.",
      );
    case "quota_exceeded":
      return new AiAssistError(
        "ai_rate_limited",
        "The OpenAI account is out of credit. Add billing/credit on platform.openai.com and try again.",
      );
    case "rate_limited":
      return new AiAssistError(
        "ai_rate_limited",
        "The OpenAI rate limit was reached for now. Wait a minute and try again.",
      );
    case "auth_failed":
      return new AiAssistError("ai_failed", "OpenAI rejected the API key. Check OPENAI_API_KEY on the server.");
    case "timeout":
      return new AiAssistError("ai_failed", "Could not reach the AI service: request timed out.");
    case "failed":
      return new AiAssistError(
        "ai_failed",
        error.status ? `The AI service returned ${error.status}. Try again.` : `Could not reach the AI service: ${error.message}`,
      );
  }
}

/**
 * Draft or adjust email content with OpenAI. The output is forced through the same
 * guardrails as a human edit: unknown {{tokens}} are stripped and the HTML body goes
 * through sanitizeEmailTemplateHtml, so the AI cannot produce anything the editor
 * itself would not allow.
 */
export async function draftEmailWithAi(input: AiDraftRequest): Promise<AiDraftResult> {
  if (!hasOpenAiApiKey()) {
    throw new AiAssistError(
      "ai_not_configured",
      "The AI assistant is not configured yet. Add your OpenAI key as OPENAI_API_KEY.",
    );
  }
  const instruction = input.instruction?.trim();
  if (!instruction) throw new AiAssistError("ai_failed", "Tell the assistant what you want first.");

  let text: string;
  try {
    const response = await createOpenAiResponseText({
      input: buildPromptInput(input, instruction),
      instructions: emailAiInstructions,
      maxOutputTokens: OPENAI_EMAIL_MAX_OUTPUT_TOKENS,
      purpose: "email-ai",
      text: emailDraftTextFormat,
    });
    text = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) {
      throw aiAssistErrorFromOpenAi(error);
    }
    throw new AiAssistError(
      "ai_failed",
      `Could not reach the AI service: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const parsed = parseAiJson(text);

  const fieldKeys = ["bodyHtml", "closingText", "greeting", "previewText", "subject"] as const;
  if (!fieldKeys.some((key) => typeof parsed[key] === "string" && String(parsed[key]).trim())) {
    throw new AiAssistError("ai_failed", "The AI reply did not contain any email fields. Try again.");
  }
  // A key the model omitted means "keep the current value" - never wipe a field the admin
  // already wrote just because the reply left it out. A present-but-empty string is honored.
  const fieldValue = (key: (typeof fieldKeys)[number]) =>
    typeof parsed[key] === "string" ? String(parsed[key]) : input.current?.[key] ?? "";

  const allowedTokens = new Set(input.variables.map((variable) => variable.token));
  const warnings: string[] = [];
  const cleanText = (value: string) => stripUnknownTokens(value.trim(), allowedTokens, warnings);

  return {
    draft: {
      bodyHtml: sanitizeEmailTemplateHtml(stripUnknownTokens(fieldValue("bodyHtml"), allowedTokens, warnings)),
      closingText: cleanText(fieldValue("closingText")),
      greeting: cleanText(fieldValue("greeting")),
      previewText: cleanText(fieldValue("previewText")),
      subject: cleanText(fieldValue("subject")),
    },
    warnings: Array.from(new Set(warnings)),
  };
}
