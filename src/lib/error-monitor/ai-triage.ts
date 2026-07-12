// AI triage for the System Issues dashboard: explain a single error, or summarize a
// cluster of recent errors, in plain English an admin can act on. Reuses the shared
// OpenAI helper (Responses API, structured JSON, timeout/retry). All input is redacted
// (see ai-redact.ts) before it leaves the server, and results are memoized in-process so
// repeat clicks / multiple admins on the same signature don't re-bill.

import { createOpenAiResponseText, PhoenixOpenAiError, resolveOpenAiEmailModel } from "@/lib/ai/openai-client";
import { redactForAi } from "@/lib/error-monitor/ai-redact";

const MAX_MESSAGE = 2_000;
const MAX_STACK = 4_000;
const MEMO_CAP = 200;

// Cheap FNV-1a hash for the memo key (no crypto import needed; collisions are harmless —
// worst case is one extra AI call).
function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function makeMemo<T>() {
  const store = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      return store.get(key);
    },
    set(key: string, value: T): void {
      if (store.size >= MEMO_CAP) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, value);
    },
  };
}

function parseJson(text: string): Record<string, unknown> {
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
        /* fall through */
      }
    }
  }
  throw new PhoenixOpenAiError("failed", "The AI reply was not in the expected format.");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ── Explain a single error ────────────────────────────────────────────────────

export type ExplainErrorInput = {
  message: string;
  route?: string | null;
  moduleLabel?: string | null;
  severity?: string | null;
  stack?: string | null;
};

export type ErrorExplanation = {
  explanation: string;
  likelyCause: string;
  suggestedFix: string;
  confidence: "low" | "medium" | "high";
};

const explainMemo = makeMemo<ErrorExplanation>();

const EXPLAIN_INSTRUCTIONS = [
  "You are a senior engineer helping a NON-technical HR admin understand a production error",
  "in a Next.js + Supabase web app. Be concrete and brief. Explain what the error means in",
  "plain English, the single most likely cause, and one concrete suggested fix. If you are",
  "unsure, say so and set confidence to low. Never invent specifics you cannot see.",
  "Respond ONLY as JSON matching the schema.",
].join(" ");

const EXPLAIN_FORMAT = {
  format: {
    name: "phoenix_error_explanation",
    schema: {
      additionalProperties: false,
      properties: {
        confidence: { enum: ["low", "medium", "high"], type: "string" },
        explanation: { description: "Plain-English meaning of the error, 1-2 sentences.", type: "string" },
        likelyCause: { description: "The single most likely cause, 1 sentence.", type: "string" },
        suggestedFix: { description: "One concrete next step to fix or investigate.", type: "string" },
      },
      required: ["explanation", "likelyCause", "suggestedFix", "confidence"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

export async function explainError(input: ExplainErrorInput): Promise<ErrorExplanation> {
  const redacted = {
    message: redactForAi(input.message).slice(0, MAX_MESSAGE),
    moduleLabel: redactForAi(input.moduleLabel).slice(0, 120),
    route: redactForAi(input.route).slice(0, 300),
    severity: (input.severity ?? "").slice(0, 20),
    stack: redactForAi(input.stack).slice(0, MAX_STACK),
  };
  const promptInput = JSON.stringify(redacted);
  const key = hashKey(promptInput);
  const cached = explainMemo.get(key);
  if (cached) return cached;

  const { outputText } = await createOpenAiResponseText({
    input: promptInput,
    instructions: EXPLAIN_INSTRUCTIONS,
    maxOutputTokens: 700,
    model: resolveOpenAiEmailModel(),
    purpose: "system-issues-explain",
    text: EXPLAIN_FORMAT,
  });

  const parsed = parseJson(outputText);
  const confidenceRaw = str(parsed.confidence).toLowerCase();
  const result: ErrorExplanation = {
    confidence: confidenceRaw === "high" || confidenceRaw === "medium" ? confidenceRaw : "low",
    explanation: str(parsed.explanation) || "No explanation was produced.",
    likelyCause: str(parsed.likelyCause),
    suggestedFix: str(parsed.suggestedFix),
  };
  explainMemo.set(key, result);
  return result;
}

// ── Summarize a cluster of recent errors ───────────────────────────────────────

export type ErrorCluster = {
  moduleLabel: string;
  route: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  releases: string[];
  sampleMessage: string;
};

export type ClusterSummary = {
  summary: string;
  themes: string[];
  recommendation: string;
};

const summaryMemo = makeMemo<ClusterSummary>();

const SUMMARY_INSTRUCTIONS = [
  "You are a senior engineer briefing a NON-technical HR admin on the health of a Next.js +",
  "Supabase app. Given aggregated error clusters (each with a count, module, route, first/last",
  "seen, and which deploy revisions they appeared in), write a short plain-English summary of",
  "what is going on, the main themes, and one prioritized recommendation. Mention deploy",
  "revisions when a cluster is tied to one. Do not invent specifics. Respond ONLY as JSON.",
].join(" ");

const SUMMARY_FORMAT = {
  format: {
    name: "phoenix_error_cluster_summary",
    schema: {
      additionalProperties: false,
      properties: {
        recommendation: { description: "One prioritized next action.", type: "string" },
        summary: { description: "2-4 sentence plain-English overview.", type: "string" },
        themes: { description: "Short bullet themes.", items: { type: "string" }, type: "array" },
      },
      required: ["summary", "themes", "recommendation"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

export async function summarizeErrorClusters(clusters: ErrorCluster[]): Promise<ClusterSummary> {
  if (clusters.length === 0) {
    return { recommendation: "No action needed.", summary: "No application errors in the selected window.", themes: [] };
  }

  const redacted = clusters.slice(0, 40).map((c) => ({
    count: c.count,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
    moduleLabel: redactForAi(c.moduleLabel).slice(0, 120),
    releases: c.releases.slice(0, 6),
    route: redactForAi(c.route).slice(0, 300),
    sample: redactForAi(c.sampleMessage).slice(0, 300),
  }));
  const promptInput = JSON.stringify(redacted);
  const key = hashKey(promptInput);
  const cached = summaryMemo.get(key);
  if (cached) return cached;

  const { outputText } = await createOpenAiResponseText({
    input: promptInput,
    instructions: SUMMARY_INSTRUCTIONS,
    maxOutputTokens: 900,
    model: resolveOpenAiEmailModel(),
    purpose: "system-issues-summary",
    text: SUMMARY_FORMAT,
  });

  const parsed = parseJson(outputText);
  const themes = Array.isArray(parsed.themes) ? parsed.themes.filter((t): t is string => typeof t === "string") : [];
  const result: ClusterSummary = {
    recommendation: str(parsed.recommendation),
    summary: str(parsed.summary) || "No summary was produced.",
    themes,
  };
  summaryMemo.set(key, result);
  return result;
}
