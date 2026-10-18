import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_COPILOT_DEFAULT_MODEL,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
} from "@/lib/ai/openai-client";
import { tryParseAiJson } from "@/lib/ai/parse-ai-json";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";

export type AiDraftMode = "composer" | "email_template";

export type AiDraftVariable = {
  label: string;
  sampleValue: string;
  token: string;
};

export type AiDraftRecipientRole = { label: string; value: string };

export type AiDraftRecipientRules = {
  bccRoles: string[];
  bccStaticEmails: string[];
  ccRoles: string[];
  ccStaticEmails: string[];
  targetLines: string[];
  targetTitles: string[];
  toRoles: string[];
  toStaticEmails: string[];
};

export type AiDraftRequest = {
  current: {
    bodyHtml?: string;
    closingText?: string;
    greeting?: string;
    previewText?: string;
    rules?: AiDraftRecipientRules;
    subject?: string;
  };
  healthIssues?: string[];
  instruction: string;
  mode: AiDraftMode;
  recipientRoles?: AiDraftRecipientRole[];
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
  /** Plain-language diagnosis/explanation — shown to the admin, e.g. why a template is
   * "Broken" or what a routing change does. Present whenever the AI has something to say
   * beyond the raw field diff (always for a diagnostic question, optional otherwise). */
  explanation: string;
  /** Present only when the instruction was about recipients/routing; the admin still
   * reviews it in the UI (same as content) before it's ever saved. */
  rules: AiDraftRecipientRules | null;
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

// Architecture briefing (owner request, 2026-07-22): the assistant used to only know how
// to write prose. It now also needs to understand — and be able to fix — the template's
// recipient routing, and to correctly diagnose why a template shows as "Broken"/"Needs
// Attention". This is deliberately scoped: it can propose changes to THIS template's
// content and recipient rules, always as a draft the admin reviews before saving — it has
// no ability to touch source code, other templates, or how/whether a template is wired to
// a real send call (a separate, code-level concern outside this feature's blast radius).
const emailSystemBriefing = [
  "SYSTEM ARCHITECTURE (so you can diagnose, not just write):",
  "- Every {{token}} in bodyHtml/bodyText/subject/greeting/closingText/previewText must come from the 'Allowed placeholders' list you are given for THIS template — never invent one.",
  "- A handful of tokens (planTable, digestTable, scoreTable, productsTable, returnCallout, detailsTable) are 'pre-rendered HTML block' tokens: the SAME {{token}} is used in both bodyHtml and bodyText — the renderer automatically swaps in the token's plain-text projection for text fields. NEVER write a token with a 'Text' suffix like {{detailsTableText}} directly in a draft field — that suffix does not exist as an insertable token, only {{detailsTable}} does (same for the others). This exact mistake breaks template validation.",
  "- Recipient routing (the 'rules' object) has three layers: toRoles/ccRoles/bccRoles (semantic roles like direct_manager, hr, employee, ceo — resolved dynamically per send against the real org chart, so they always stay correct as people change roles), toStaticEmails/ccStaticEmails/bccStaticEmails (fixed addresses — only @satopharma.com addresses avoid a health warning; anything else is flagged 'needs careful review' even if valid), and targetLines/targetTitles (only used by the same_line_selected_titles / all_lines_selected_titles / selected_lines_selected_titles roles, to scope which line(s) and job title(s) those roles resolve against).",
  "- A template's health score comes from: missing subject (-25), missing body (-30), no recipient rule configured at all (-30), template inactive (-10), each unresolved/unknown-token or validation issue (-15 each), non-satopharma.com static recipients (-10, warning only). Below 60 or any error-severity issue = 'Broken'. Below 90 or any issue = 'Needs Attention'. Otherwise 'Good'.",
  "- If asked to diagnose or explain a health issue, use the 'healthIssues' list you are given (the exact current issues for this template) — do not guess at a different cause.",
  "- Recipient role glossary: employee (the subject of the email), candidate (external, no Phoenix login), direct_manager, manager_of_manager, manager_chain (every manager above, escalating), employee_team (peers reporting to the same manager), direct_reports, employee_line (everyone active on the same line), hr, hr_manager, finance, hiring_manager, admin (Super Admin), ceo, recruiter, district_manager, regional_sales_manager, national_sales_manager, line_manager, same_line_selected_titles / all_lines_selected_titles / selected_lines_selected_titles (title-based, scoped by targetLines/targetTitles as described above).",
  "- Only propose a 'rules' change when the instruction is actually about who receives the email (add/remove a recipient, CC someone, route to a different role, etc). For a pure content/wording request, leave rules unset — never touch routing the admin didn't ask about.",
  "- One template already known to be disconnected from live sending regardless of what you draft: 'job_offer' (the offer letter) uses a fixed PDF-attaching design, not this template engine — if asked about it, say so plainly rather than promising the edit will take effect.",
].join("\n");

const emailAiInstructions = [
  "You are the email writing AND email-system assistant inside Phoenix Workforce, the HR system of an Egyptian pharma company.",
  "You draft or adjust HR email content and recipient routing for the template being edited, and you can explain/diagnose template health issues, while preserving the admin's intent and the system's constraints.",
  emailSystemBriefing,
  "STRICT RULES:",
  "1. Placeholders: use ONLY placeholders listed in the request input, written exactly with double curly braces. NEVER invent new placeholders (see the pre-rendered-block-token rule above — this is the most common mistake).",
  `2. bodyHtml must be simple valid HTML using only: ${allowedHtmlSummary} No <html>/<head>/<body> wrapper, no scripts, no images unless the user explicitly provides an https image URL.`,
  '3. subject, previewText, greeting and closingText are plain text (placeholders allowed). greeting looks like "Dear {{recipientName}},". previewText is one short line shown under the email title and as the inbox preview.',
  '4. The user may write in Arabic or English. Write the email in the language the user asks for; default to the language of the instruction. Give Arabic paragraphs dir="rtl" on their <p> tags.',
  "5. PRIORITY: the user's request ALWAYS wins over the current draft. When the user provides their own text or structure, follow it faithfully (fix grammar, improve flow, format it well) and do NOT fall back to the current draft's wording. Use the current draft as the base ONLY for adjustment requests like 'make it shorter' or 'more formal'.",
  "6. When the user writes bracketed fields like [Employee Name] or [Hiring Date], replace each with the closest placeholder from the allowed list. If nothing fits, keep the text without brackets.",
  '7. When the user lists label/value rows (Employee: ..., Title: ..., Area: ...), render them as a clean two-column HTML table: label cells bold with style="border: 1px solid #cbd5e1; padding: 8px; background-color: #f8fafc", value cells with style="border: 1px solid #cbd5e1; padding: 8px".',
  "8. Never return the current draft unchanged or nearly unchanged, and never answer with a single thin sentence when the user asked for structured content. Write a complete, polished email.",
  "9. Return all five content fields required by the schema. For fields the user did not ask to change, keep or improve the current value instead of omitting it.",
  "10. Recipient roles/toStaticEmails/etc you return in 'rules' must use ONLY the role values listed in 'recipientRoles' you are given — never invent a role name. Omit the whole 'rules' field (leave it null) unless the instruction was actually about routing.",
  "11. Always fill 'explanation' with a short (1-4 sentence) plain-language note: what you changed and why, or — if the instruction was a question/diagnosis request rather than an edit — your direct answer. Never leave it empty.",
].join("\n\n");

const roleArray = {
  description: "Recipient role values, each one of the exact strings listed in the request's recipientRoles.",
  items: { type: "string" },
  type: "array",
} as const;
const emailArray = {
  description: "Fixed email addresses (only @satopharma.com avoids a health warning).",
  items: { type: "string" },
  type: "array",
} as const;
const textArray = { items: { type: "string" }, type: "array" } as const;

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
        explanation: {
          description: "1-4 sentence plain-language note: what changed and why, or a direct answer to a diagnostic question. Never empty.",
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
        rules: {
          additionalProperties: false,
          description: "Recipient routing changes. Set the ENTIRE object to null unless the instruction was actually about who receives this email.",
          properties: {
            bccRoles: roleArray,
            bccStaticEmails: emailArray,
            ccRoles: roleArray,
            ccStaticEmails: emailArray,
            targetLines: textArray,
            targetTitles: textArray,
            toRoles: roleArray,
            toStaticEmails: emailArray,
          },
          required: ["toRoles", "toStaticEmails", "ccRoles", "ccStaticEmails", "bccRoles", "bccStaticEmails", "targetLines", "targetTitles"],
          type: ["object", "null"],
        },
        subject: {
          description: "Plain text inbox subject.",
          type: "string",
        },
      },
      required: ["subject", "previewText", "greeting", "bodyHtml", "closingText", "rules", "explanation"],
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

  const recipientRoles = input.recipientRoles ?? [];

  return [
    input.mode === "email_template"
      ? `Mode: reusable system email template "${input.templateName ?? ""}". It is sent automatically, so placeholders are filled with real employee data on every send.`
      : "Mode: one-off HR email in the manual composer.",
    "Allowed placeholders:",
    variableLines || "- (none available - do not use any placeholders)",
    bracketExamples ? `Bracket field examples in scope: ${bracketExamples}` : "No bracket field examples are in scope.",
    recipientRoles.length > 0
      ? `recipientRoles (valid values for rules.toRoles/ccRoles/bccRoles):\n${recipientRoles.map((role) => `- ${role.value} (${role.label})`).join("\n")}`
      : "recipientRoles: (none provided — do not propose a rules change).",
    input.healthIssues && input.healthIssues.length > 0
      ? `Current health issues for this template:\n${input.healthIssues.map((issue) => `- ${issue}`).join("\n")}`
      : "Current health issues for this template: none.",
    "Current draft as JSON (including current recipient rules):",
    JSON.stringify(input.current ?? {}),
    "User request:",
    instruction,
  ].join("\n\n");
}

function parseAiJson(text: string): Record<string, unknown> {
  const parsed = tryParseAiJson(text);
  if (parsed) return parsed;
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
    // Provider-neutral since Anthropic answers too: by the time a dead account reaches here, every
    // configured provider has said so, and naming OpenAI alone sent people to the wrong billing page.
    case "not_configured":
      return new AiAssistError(
        "ai_not_configured",
        "The AI assistant is not configured yet. Add OPENAI_API_KEY or ANTHROPIC_API_KEY on the server.",
      );
    case "quota_exceeded":
      return new AiAssistError(
        "ai_rate_limited",
        "The AI service is out of credit. Add credit to the AI account and try again.",
      );
    case "rate_limited":
      return new AiAssistError(
        "ai_rate_limited",
        "The AI service is busy right now. Wait a minute and try again.",
      );
    case "auth_failed":
      return new AiAssistError("ai_failed", "The AI service rejected the API key. Check OPENAI_API_KEY and ANTHROPIC_API_KEY on the server.");
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
  if (!hasAiApiKey()) {
    throw new AiAssistError(
      "ai_not_configured",
      "The AI assistant is not configured yet. Add OPENAI_API_KEY or ANTHROPIC_API_KEY on the server.",
    );
  }
  const instruction = input.instruction?.trim();
  if (!instruction) throw new AiAssistError("ai_failed", "Tell the assistant what you want first.");

  let text: string;
  try {
    const response = await createOpenAiResponseText({
      input: buildPromptInput(input, instruction),
      instructions: emailAiInstructions,
      // Reasoning tokens are drawn from THIS budget alongside the visible JSON in the
      // Responses API — at 4096 a heavier reasoning pass starved the structured output and
      // truncated it to invalid JSON (confirmed live 2026-07-22: a 502 / "reply not in the
      // expected format"). 8000 leaves ample room for both the reasoning and the (now larger,
      // rules+explanation-bearing) response.
      maxOutputTokens: 8_000,
      // Owner request (2026-07-22): drafts + fixes real HR/workflow templates an admin
      // publishes to real employees — use the strongest model this codebase trusts (gpt-5.4,
      // the Payroll Copilot tier), NOT the fast/cheap email-nano default. Effort is "medium",
      // not "high": email editing + recipient-rule reasoning is far lighter than the copilot's
      // 100-person-roster free-text parsing, and "high" measured 100+s per call (unusable UX)
      // while "medium" keeps the same model's quality at a fraction of the latency.
      model: OPENAI_COPILOT_DEFAULT_MODEL,
      purpose: "email-ai",
      reasoning: { effort: "medium" },
      text: emailDraftTextFormat,
      // The default client timeout (25s) is calibrated for the fast/cheap nano model this
      // call no longer uses — give the stronger model the full route budget.
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
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

  // Defense-in-depth for recipient rules, mirroring stripUnknownTokens' guarantee for
  // placeholders: even though the strict JSON schema constrains string values, it cannot
  // constrain them to THIS request's specific allowed role list, so re-validate here.
  const allowedRoles = new Set((input.recipientRoles ?? []).map((role) => role.value));
  const rawRules = parsed.rules;
  const rules: AiDraftRecipientRules | null =
    rawRules && typeof rawRules === "object"
      ? (() => {
          const r = rawRules as Record<string, unknown>;
          const roles = (key: string) => {
            const values = Array.isArray(r[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
            const kept = values.filter((value) => allowedRoles.has(value));
            if (kept.length < values.length) warnings.push(`Removed an unrecognized recipient role from ${key}.`);
            return kept;
          };
          const emails = (key: string) =>
            Array.isArray(r[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string" && v.includes("@")) : [];
          const strings = (key: string) =>
            Array.isArray(r[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
          return {
            bccRoles: roles("bccRoles"),
            bccStaticEmails: emails("bccStaticEmails"),
            ccRoles: roles("ccRoles"),
            ccStaticEmails: emails("ccStaticEmails"),
            targetLines: strings("targetLines"),
            targetTitles: strings("targetTitles"),
            toRoles: roles("toRoles"),
            toStaticEmails: emails("toStaticEmails"),
          };
        })()
      : null;

  const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";

  return {
    draft: {
      bodyHtml: sanitizeEmailTemplateHtml(stripUnknownTokens(fieldValue("bodyHtml"), allowedTokens, warnings)),
      closingText: cleanText(fieldValue("closingText")),
      greeting: cleanText(fieldValue("greeting")),
      previewText: cleanText(fieldValue("previewText")),
      subject: cleanText(fieldValue("subject")),
    },
    explanation,
    rules,
    warnings: Array.from(new Set(warnings)),
  };
}
