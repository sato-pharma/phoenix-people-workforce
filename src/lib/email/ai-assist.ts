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

// OPENAI_MODEL must be a chat-completions model that supports response_format
// json_object (gpt-5*, gpt-4o*, gpt-4.1*, o3*, o4-mini*). Deprecated o1-mini/o1-preview
// and Responses-API-only models (gpt-5-pro, o1-pro) will 400 - surfaced to the admin as 502.
function openAiModel() {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5-mini";
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

function buildPrompt(input: AiDraftRequest) {
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
    "You are the email writing assistant inside Phoenix Workforce, the HR system of an Egyptian pharma company.",
    input.mode === "email_template"
      ? `You are editing the reusable system email template "${input.templateName ?? ""}". It is sent automatically, so placeholders are filled with real employee data on every send.`
      : "You are drafting a one-off HR email in the manual composer.",
    "STRICT RULES:",
    `1. Placeholders: use ONLY these, written exactly with double curly braces. NEVER invent new ones.\n${variableLines || "- (none available - do not use any placeholders)"}`,
    `2. bodyHtml must be simple valid HTML using only: ${allowedHtmlSummary} No <html>/<head>/<body> wrapper, no scripts, no images unless the user explicitly provides an https image URL.`,
    "3. subject, previewText, greeting and closingText are plain text (placeholders allowed). greeting looks like \"Dear {{recipientName}},\". previewText is one short line shown under the email title and as the inbox preview.",
    "4. The user may write in Arabic or English. Write the email in the language the user asks for; default to the language of the instruction. Give Arabic paragraphs dir=\"rtl\" on their <p> tags.",
    "5. PRIORITY: the user's request ALWAYS wins over the current draft. When the user provides their own text or structure, follow it faithfully (fix grammar, improve flow, format it well) and do NOT fall back to the current draft's wording. Use the current draft as the base ONLY for adjustment requests like 'make it shorter' or 'more formal'.",
    `6. When the user writes bracketed fields like [Employee Name] or [Hiring Date], replace each with the closest placeholder from the allowed list${bracketExamples ? ` (e.g. ${bracketExamples})` : ""}. If nothing fits, keep the text without brackets.`,
    "7. When the user lists label/value rows (Employee: ..., Title: ..., Area: ...), render them as a clean two-column HTML table: label cells bold with style=\"border: 1px solid #cbd5e1; padding: 8px; background-color: #f8fafc\", value cells with style=\"border: 1px solid #cbd5e1; padding: 8px\".",
    "8. Never return the current draft unchanged or nearly unchanged, and never answer with a single thin sentence when the user asked for structured content. Write a complete, polished email.",
    "Current draft as JSON:",
    JSON.stringify(input.current ?? {}),
    "User request:",
    input.instruction,
    'Respond ONLY with a JSON object: {"subject": string, "previewText": string, "greeting": string, "bodyHtml": string, "closingText": string}',
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

/**
 * Draft or adjust email content with OpenAI. The output is forced through the same
 * guardrails as a human edit: unknown {{tokens}} are stripped and the HTML body goes
 * through sanitizeEmailTemplateHtml, so the AI cannot produce anything the editor
 * itself would not allow.
 */
export async function draftEmailWithAi(input: AiDraftRequest): Promise<AiDraftResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new AiAssistError(
      "ai_not_configured",
      "The AI assistant is not configured yet. Add your OpenAI key as OPENAI_API_KEY.",
    );
  }
  const instruction = input.instruction?.trim();
  if (!instruction) throw new AiAssistError("ai_failed", "Tell the assistant what you want first.");

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      body: JSON.stringify({
        // Reasoning models (gpt-5 family, o-series) spend completion tokens on internal
        // reasoning BEFORE the JSON answer - a small cap starves the actual reply. They
        // also reject the legacy max_tokens parameter and non-default temperature, so
        // max_completion_tokens is used and temperature is left at its default.
        max_completion_tokens: 8192,
        messages: [{ content: buildPrompt({ ...input, instruction }), role: "user" }],
        model: openAiModel(),
        response_format: { type: "json_object" },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    throw new AiAssistError(
      "ai_failed",
      `Could not reach the AI service: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { code?: string; message?: string };
  } | null;

  if (response.status === 429) {
    const quota = payload?.error?.code === "insufficient_quota";
    throw new AiAssistError(
      "ai_rate_limited",
      quota
        ? "The OpenAI account is out of credit. Add billing/credit on platform.openai.com and try again."
        : "The OpenAI rate limit was reached for now. Wait a minute and try again.",
    );
  }

  if (!response.ok) {
    // Upstream error bodies are logged server-side only - they can echo request details
    // (and on 401 a redacted key fragment) that must never reach the browser.
    console.error(`[email-ai] OpenAI request failed (${response.status}): ${payload?.error?.message ?? "no error body"}`);
    throw new AiAssistError(
      "ai_failed",
      response.status === 401 || response.status === 403
        ? "OpenAI rejected the API key. Check OPENAI_API_KEY on the server."
        : `The AI service returned ${response.status}. Try again.`,
    );
  }

  const text = payload?.choices?.[0]?.message?.content ?? "";
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
