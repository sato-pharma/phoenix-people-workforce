import { createOpenAiResponseText, hasAiApiKey, resolveOpenAiCopilotModel } from "@/lib/ai/openai-client";
import { logError } from "@/lib/observability/log";

import { COPILOT_OVERRIDE_FIELDS, type ProposedAction } from "./types.ts";

/**
 * The LLM boundary — PARSE ONLY.
 *
 * parseCeoReply turns the CEO's free text ("give Ahmed 2000 bonus, deduct 500
 * from Mona") into structured ProposedAction[]. The model NEVER computes a
 * salary/tax figure and NEVER writes to the database — it only proposes
 * instructions, which the CEO confirms and negotiation.ts applies
 * deterministically. When no OpenAI key is configured (or the call fails), a
 * deterministic regex parser handles the explicit forms so the Copilot still
 * works.
 */

export type ParseCandidate = { hrId: string; name: string };
export type ParseContext = { candidates: ParseCandidate[] };

const ACTION_KINDS = [
  "bonus",
  "penalty",
  "loan",
  "advance",
  "prorate",
  "override",
  "include",
  "defer",
  "confirm",
  "hold",
] as const;

function firstNumber(text: string): number | null {
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Remove an HR id (and its compact form) from a clause before extracting the
 * amount — ids like "B-100" contain digits that would otherwise be mistaken for
 * the amount.
 */
function stripHrId(text: string, hrId: string): string {
  const variants = [hrId, hrId.replace(/[^a-z0-9]+/gi, "")].filter(Boolean);
  let result = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "ig"), " ");
  }
  return result;
}

function resolveHrId(text: string, candidates: ParseCandidate[]): string | null {
  const lower = text.toLowerCase();
  // Prefer an explicit HR id match.
  for (const candidate of candidates) {
    const id = candidate.hrId.toLowerCase();
    if (id && (lower.includes(id) || lower.includes(id.replace(/[^a-z0-9]+/g, "")))) {
      return candidate.hrId;
    }
  }
  // Otherwise match on any distinctive name token (>= 3 chars).
  for (const candidate of candidates) {
    const tokens = candidate.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.some((token) => lower.includes(token))) return candidate.hrId;
  }
  return null;
}

/** Deterministic parser for explicit instruction forms (fallback path). */
export function parseDeterministic(text: string, context: ParseContext): ProposedAction[] {
  const actions: ProposedAction[] = [];
  const clauses = text.split(/(?:,|;|\band\b|\bthen\b)/i).map((c) => c.trim()).filter(Boolean);

  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    const hrId = resolveHrId(clause, context.candidates);
    if (!hrId) continue;
    const amount = firstNumber(stripHrId(clause, hrId));

    if (/\bloan\b/.test(lower) && amount !== null) {
      const monthsMatch = /(?:for|over|x|×)\s*(\d+)\s*(?:months?|installments?|x)?/.exec(lower);
      const installments = monthsMatch ? Number(monthsMatch[1]) : 1;
      actions.push({ kind: "loan", hrId, monthlyAmount: amount, installments, reason: clause });
    } else if (/\badvance\b/.test(lower) && amount !== null) {
      actions.push({ kind: "advance", hrId, amount, reason: clause });
    } else if (/(bonus|reward|incentive|add)\b/.test(lower) && amount !== null) {
      actions.push({ kind: "bonus", hrId, amount, reason: clause });
    } else if (/(deduct|penalt|penalize|fine|cut|subtract)\w*/.test(lower) && amount !== null) {
      actions.push({ kind: "penalty", hrId, amount, reason: clause });
    } else if (/\bprorate\b|worked\s+\d+\s+days?/.test(lower) && amount !== null) {
      actions.push({ kind: "prorate", hrId, workedDays: amount, reason: clause });
    } else if (/\bhold\b|\bfreeze\b|\bwithhold\b|do ?n[o']?t pay|do not pay/.test(lower)) {
      actions.push({ kind: "hold", hrId, reason: clause });
    } else if (/\bdefer\b|next month|skip\b/.test(lower)) {
      actions.push({ kind: "defer", hrId, reason: clause });
    } else if (/\binclude\b|keep\b|pay (them|him|her)\b/.test(lower)) {
      actions.push({ kind: "include", hrId, reason: clause });
    } else if (/\bconfirm\b|correct\b|as[- ]is|approve\b|ok\b/.test(lower)) {
      actions.push({ kind: "confirm", hrId, reason: clause });
    }
  }

  return actions;
}

type RawAction = {
  kind?: unknown;
  hrId?: unknown;
  amount?: unknown;
  monthlyAmount?: unknown;
  installments?: unknown;
  workedDays?: unknown;
  field?: unknown;
  value?: unknown;
  reason?: unknown;
};

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Narrow a raw LLM object into a valid ProposedAction (or null). */
export function normalizeAction(raw: RawAction, candidates: ParseCandidate[]): ProposedAction | null {
  const kind = String(raw.kind ?? "") as (typeof ACTION_KINDS)[number];
  if (!ACTION_KINDS.includes(kind)) return null;

  const rawId = String(raw.hrId ?? "").trim();
  const hrId =
    candidates.find((c) => c.hrId.toLowerCase() === rawId.toLowerCase())?.hrId ??
    resolveHrId(rawId, candidates);
  if (!hrId) return null;

  const reason = String(raw.reason ?? "").trim() || `${kind} via chat`;

  switch (kind) {
    case "bonus":
    case "penalty":
    case "advance": {
      const amount = toNumber(raw.amount);
      if (amount === null || amount <= 0) return null;
      return { kind, hrId, amount, reason };
    }
    case "loan": {
      const monthlyAmount = toNumber(raw.monthlyAmount) ?? toNumber(raw.amount);
      const installments = toNumber(raw.installments);
      if (monthlyAmount === null || monthlyAmount <= 0 || installments === null || installments < 1) {
        return null;
      }
      return { kind, hrId, monthlyAmount, installments: Math.round(installments), reason };
    }
    case "prorate": {
      const workedDays = toNumber(raw.workedDays);
      if (workedDays === null || workedDays < 0) return null;
      return { kind, hrId, workedDays: Math.round(workedDays), reason };
    }
    case "override": {
      const field = String(raw.field ?? "");
      const value = toNumber(raw.value);
      if (!COPILOT_OVERRIDE_FIELDS.includes(field as (typeof COPILOT_OVERRIDE_FIELDS)[number]) || value === null) {
        return null;
      }
      return { kind, hrId, field: field as (typeof COPILOT_OVERRIDE_FIELDS)[number], value, reason };
    }
    case "include":
    case "defer":
    case "confirm":
      return { kind, hrId, reason };
    case "hold":
      // Hold zeroes the employee's pay this run; the reason is required and is
      // shown on their payslip, so keep whatever the CEO said (the fallback is
      // only a last resort when the model emitted no reason at all).
      return { kind, hrId, reason };
    default:
      return null;
  }
}

const actionsSchema = {
  format: {
    name: "payroll_copilot_actions",
    schema: {
      additionalProperties: false,
      properties: {
        actions: {
          type: "array",
          items: {
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: [...ACTION_KINDS] },
              hrId: { type: "string" },
              amount: { type: ["number", "null"] },
              monthlyAmount: { type: ["number", "null"] },
              installments: { type: ["number", "null"] },
              workedDays: { type: ["number", "null"] },
              field: { type: ["string", "null"] },
              value: { type: ["number", "null"] },
              reason: { type: "string" },
            },
            required: [
              "kind",
              "hrId",
              "amount",
              "monthlyAmount",
              "installments",
              "workedDays",
              "field",
              "value",
              "reason",
            ],
            type: "object",
          },
        },
      },
      required: ["actions"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

async function parseWithLlm(text: string, context: ParseContext): Promise<ProposedAction[]> {
  const roster = context.candidates
    .map((c) => `- ${c.hrId}: ${c.name}`)
    .join("\n");
  const instructions = [
    "You are a sharp, literal-minded assistant reading a CEO's free-text instructions about this month's payroll, and converting them into structured actions.",
    "The CEO writes the way a busy executive actually talks: casual phrasing, typos, nicknames, mixed Arabic/English names, several instructions run together in one message, implicit references ('him', 'the last one', 'same as Ahmed'), and approvals stated indirectly ('fine', 'that's correct', 'leave it', 'go ahead').",
    "Resolve every person mention against the roster below by whatever means gets it right: exact HR_ID, full name, first name only, a nickname or partial name, or a fuzzy/misspelled match — pick the single best roster match. Only omit a person if there is genuinely no plausible match.",
    "A single message can contain multiple unrelated instructions for different people — split them and return one action per instruction, in the order given.",
    "Never invent amounts. Use amount for bonus/penalty/advance; monthlyAmount+installments for a loan; workedDays for prorate; field+value for a direct override.",
    `Allowed override fields: ${COPILOT_OVERRIDE_FIELDS.join(", ")}.`,
    "Treat any clear approval, agreement, or 'this is fine as-is' phrasing as confirm — do not require the literal word 'confirm'.",
    "Use hold when the CEO wants to withhold someone's pay this month (e.g. 'hold his salary', 'don't pay her yet', 'freeze his pay pending investigation'). Put the CEO's stated reason in the reason field — it is shown on the payslip, so keep it meaningful.",
    "If an instruction is genuinely ambiguous (no plausible person match, or no way to tell what action is meant), omit that one instruction rather than guessing — but do not omit instructions just because the phrasing is casual or indirect.",
    "Return every unrelated field as null.",
    "",
    "Examples (roster: B-100 Ahmed Sharaf, B-142 Mona Khalil, B-155 Youssef Adel):",
    'Input: "give ahmed a 2000 bonus, mona is fine, deduct 500 from youssef for the late deliveries"',
    'Output actions: [{kind:"bonus",hrId:"B-100",amount:2000,reason:"2000 bonus"}, {kind:"confirm",hrId:"B-142",reason:"confirmed as-is"}, {kind:"penalty",hrId:"B-155",amount:500,reason:"late deliveries"}]',
    'Input: "loan youssef 1000 a month for half a year"',
    'Output actions: [{kind:"loan",hrId:"B-155",monthlyAmount:1000,installments:6,reason:"6-month loan"}]',
    'Input: "hold ahmed\'s salary this month, still under investigation"',
    'Output actions: [{kind:"hold",hrId:"B-100",reason:"under investigation"}]',
    "",
    "Roster:",
    roster,
  ].join("\n");

  const response = await createOpenAiResponseText({
    input: text,
    instructions,
    model: resolveOpenAiCopilotModel(),
    purpose: "payroll_copilot_parse",
    reasoning: { effort: "high" },
    text: actionsSchema,
  });

  let parsed: { actions?: RawAction[] };
  try {
    parsed = JSON.parse(response.outputText || "{}");
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed.actions) ? parsed.actions : [];
  return raw
    .map((item) => normalizeAction(item, context.candidates))
    .filter((action): action is ProposedAction => action !== null);
}

export async function parseCeoReply(text: string, context: ParseContext): Promise<ProposedAction[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (hasAiApiKey()) {
    try {
      const actions = await parseWithLlm(trimmed, context);
      if (actions.length > 0) return actions;
    } catch (error) {
      logError("Payroll copilot LLM parse failed, using deterministic fallback", {
        labels: { event: "copilot_llm_parse_failed" },
        error,
      });
    }
  }
  return parseDeterministic(trimmed, context);
}
