// The second AI provider behind the shared client in openai-client.ts.
//
// WHY IT EXISTS (owner, 2026-10-18): the OpenAI account failed to recharge, and every AI feature in the
// app — CV extraction, email assist, the payroll copilot, CRM notes, invoice reading, the Needs You
// summary, error triage — calls ONE function, `createOpenAiResponseText`. This module lets that one
// function answer from Anthropic's Messages API when OpenAI is out of credit or rejects its key, so
// nothing else had to change.
//
// 🔴 PLAIN `fetch`, NO SDK. A new dependency cannot be installed from a worktree (pnpm there purges the
// shared node_modules junction), and the request is small enough that an SDK adds nothing but weight.
//
// 🔴 THE REQUEST IS DELIBERATELY THE PLAIN ONE — model, max_tokens, system, messages, and nothing
// optional. No structured-output parameter, no thinking budget, no temperature: this was written
// without being able to call the live API, and an optional field a given model rejects would fail every
// call with a 400. JSON replies are asked for in the system prompt instead and cleaned on the way out;
// every caller already parses and validates the reply, as it did for OpenAI.

type AnthropicEnv = Record<string, string | undefined>;

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";

// The two tiers the app already thinks in (openai-client.ts: nano for drafting and reading, the strong
// tier for payroll and faded signboards). Env overrides exist so a model can be changed on Railway
// without a deploy.
export const ANTHROPIC_FAST_MODEL = "claude-haiku-5-5";
export const ANTHROPIC_STRONG_MODEL = "claude-sonnet-5-5";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAY_MS = 500;

export type AnthropicFailureCode = "auth_failed" | "failed" | "quota_exceeded" | "rate_limited" | "timeout";

// Same spellings as PhoenixOpenAiErrorCode, so openai-client.ts maps one onto the other without a table.
export class AnthropicRequestError extends Error {
  code: AnthropicFailureCode;
  requestId?: string;
  status?: number;

  constructor(code: AnthropicFailureCode, message: string, options: { requestId?: string; status?: number } = {}) {
    super(message);
    this.name = "AnthropicRequestError";
    this.code = code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

export function hasAnthropicApiKey(env: AnthropicEnv = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Which Claude model answers a call that asked for `requestedModel` (an OpenAI name, or an env override
 * of one). Nano/mini asks are the cheap tier; everything else is the strong tier. `ANTHROPIC_MODEL`
 * forces one model for every call; a request that already names a Claude model is left alone.
 */
export function resolveAnthropicModel(requestedModel: string, env: AnthropicEnv = process.env) {
  const forced = env.ANTHROPIC_MODEL?.trim();
  if (forced) return forced;
  if (/^claude-/i.test(requestedModel)) return requestedModel;
  if (/nano|mini|haiku/i.test(requestedModel)) return env.ANTHROPIC_FAST_MODEL?.trim() || ANTHROPIC_FAST_MODEL;
  return env.ANTHROPIC_STRONG_MODEL?.trim() || ANTHROPIC_STRONG_MODEL;
}

type AnthropicTextBlock = { text: string; type: "text" };
type AnthropicImageBlock = {
  source: { data: string; media_type: string; type: "base64" } | { type: "url"; url: string };
  type: "image";
};
type AnthropicDocumentBlock = {
  source: { data: string; media_type: "application/pdf"; type: "base64" };
  title?: string;
  type: "document";
};
export type AnthropicContentBlock = AnthropicDocumentBlock | AnthropicImageBlock | AnthropicTextBlock;

export type AnthropicMessage = {
  content: AnthropicContentBlock[];
  role: "assistant" | "user";
};

export type AnthropicRequestBody = {
  max_tokens: number;
  messages: AnthropicMessage[];
  model: string;
  system: string;
};

const DATA_URL = /^data:([^;,]+);base64,([\s\S]*)$/;

function unsupported(what: string): never {
  throw new AnthropicRequestError("failed", `The Anthropic fallback cannot send ${what}.`);
}

function blockFromPart(part: unknown): AnthropicContentBlock {
  const item = (part ?? {}) as Record<string, unknown>;
  switch (item.type) {
    case "input_text":
    case "output_text":
    case "text":
      return { text: String(item.text ?? ""), type: "text" };
    case "input_image": {
      const url = String(item.image_url ?? "");
      const data = DATA_URL.exec(url);
      if (data) return { source: { data: data[2], media_type: data[1], type: "base64" }, type: "image" };
      if (/^https?:\/\//i.test(url)) return { source: { type: "url", url }, type: "image" };
      return unsupported("an image that is neither a data URL nor an http(s) address");
    }
    case "input_file": {
      const data = DATA_URL.exec(String(item.file_data ?? ""));
      if (data && data[1] === "application/pdf") {
        const filename = typeof item.filename === "string" && item.filename ? item.filename : undefined;
        return {
          source: { data: data[2], media_type: "application/pdf", type: "base64" },
          ...(filename ? { title: filename } : {}),
          type: "document",
        };
      }
      return unsupported("a file that is not an inline PDF");
    }
    default:
      return unsupported(`a "${String(item.type)}" input part`);
  }
}

function blocksFromContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ text: content, type: "text" }];
  if (Array.isArray(content)) return content.map(blockFromPart);
  return [];
}

/**
 * The instruction that stands in for OpenAI's `text.format`. JSON is asked for in the system prompt
 * because this adapter sends no optional parameter (see the header); a plain-text format adds nothing.
 */
export function jsonInstructionFor(format: unknown): string | null {
  const wanted = (format ?? {}) as { schema?: unknown; type?: string };
  if (wanted.type === "json_schema") {
    return (
      "Reply with ONLY one JSON object that conforms to the JSON Schema below. No prose before or after it, "
      + "no markdown fences, no comments.\nJSON Schema:\n"
      + JSON.stringify(wanted.schema ?? {})
    );
  }
  if (wanted.type === "json_object") {
    return "Reply with ONLY one valid JSON object. No prose before or after it and no markdown fences.";
  }
  return null;
}

/**
 * Turns the OpenAI-shaped call `createOpenAiResponseText` receives into a Messages API body.
 * `input` is a plain string or a list of role + content items (input_text / input_image / input_file
 * parts); system and developer items join the system prompt, everything else becomes a turn.
 */
export function buildAnthropicRequest(
  params: { format?: unknown; input: unknown; instructions: string; maxOutputTokens: number },
  model: string,
): AnthropicRequestBody {
  const system: string[] = [params.instructions];
  const messages: AnthropicMessage[] = [];

  const addTurn = (role: AnthropicMessage["role"], blocks: AnthropicContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ content: [...blocks], role });
  };

  if (typeof params.input === "string") {
    addTurn("user", [{ text: params.input, type: "text" }]);
  } else if (Array.isArray(params.input)) {
    for (const entry of params.input) {
      const item = (entry ?? {}) as { content?: unknown; role?: unknown };
      if (typeof item.role !== "string") return unsupported("an input item that has no role");
      const blocks = blocksFromContent(item.content);
      if (item.role === "system" || item.role === "developer") {
        for (const block of blocks) if (block.type === "text") system.push(block.text);
      } else {
        addTurn(item.role === "assistant" ? "assistant" : "user", blocks);
      }
    }
  } else {
    return unsupported("an input that is neither a string nor a list of items");
  }

  if (!messages.some((message) => message.role === "user")) {
    return unsupported("a request with no user content");
  }

  const jsonInstruction = jsonInstructionFor(params.format);
  if (jsonInstruction) system.push(jsonInstruction);

  return {
    max_tokens: params.maxOutputTokens,
    messages,
    model,
    system: system.filter((part) => part.trim().length > 0).join("\n\n"),
  };
}

/**
 * Makes a JSON reply parseable when the model wrapped it: strips a markdown fence, or cuts the first
 * `{` to the last `}`. A reply that is already valid JSON, or has no object in it, is returned as is —
 * the caller's own parse and validation decide what happens next, exactly as they did for OpenAI.
 */
export function cleanJsonReply(raw: string) {
  const trimmed = raw.trim();
  const parses = (text: string) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  if (parses(trimmed)) return trimmed;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced && parses(fenced[1])) return fenced[1];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const span = trimmed.slice(first, last + 1);
    if (parses(span)) return span;
  }
  return trimmed;
}

/**
 * What an Anthropic HTTP failure means for the app. Out of credit arrives as a 400 whose message says the
 * credit balance is too low (or as a 402, or a 429 naming a usage limit) — that one is `quota_exceeded`,
 * the code that fails the shared client over and pages the owner; a plain 429 is a rate limit.
 */
export function anthropicErrorCodeFor(status: number, rawBody: string): AnthropicFailureCode {
  const body = rawBody.toLowerCase();
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "quota_exceeded";
  if (status === 400 && (body.includes("credit balance") || body.includes("billing"))) return "quota_exceeded";
  if (status === 429) {
    return body.includes("usage limit") || body.includes("spend limit") || body.includes("credit balance")
      ? "quota_exceeded"
      : "rate_limited";
  }
  return "failed";
}

function errorMessageFrom(rawBody: string) {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message.slice(0, 200);
  } catch {
    // Not JSON — fall through to the raw fragment.
  }
  return rawBody.slice(0, 200);
}

function isTimeout(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error
    && ((error as { name?: unknown }).name === "TimeoutError" || (error as { name?: unknown }).name === "AbortError");
}

export type AnthropicReply = {
  inputTokens?: number;
  model: string;
  outputText: string;
  outputTokens?: number;
  requestId?: string;
};

/**
 * One Messages API round trip, with the same retry budget shape as the OpenAI client (`maxRetries`
 * extra tries on a 429 / 5xx / 529, never on a timeout). Throws `AnthropicRequestError`; never logs,
 * and never puts the key in a message.
 */
export async function callAnthropicMessages(params: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  format?: unknown;
  input: unknown;
  instructions: string;
  maxOutputTokens: number;
  maxRetries: number;
  model: string;
  timeoutMs: number;
}): Promise<AnthropicReply> {
  const apiKey = (params.apiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
  if (!apiKey) throw new AnthropicRequestError("failed", "ANTHROPIC_API_KEY is not configured.");

  const body = JSON.stringify(
    buildAnthropicRequest(
      {
        format: params.format,
        input: params.input,
        instructions: params.instructions,
        maxOutputTokens: params.maxOutputTokens,
      },
      params.model,
    ),
  );
  const doFetch = params.fetchImpl ?? fetch;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(ANTHROPIC_MESSAGES_URL, {
        body,
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) throw new AnthropicRequestError("timeout", "The Anthropic request timed out.");
      throw new AnthropicRequestError("failed", error instanceof Error ? error.message : "The Anthropic request failed.");
    }

    const requestId = response.headers.get("request-id") ?? undefined;

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      if (RETRYABLE_STATUSES.has(response.status) && attempt < params.maxRetries) {
        // A 429 that means "out of credit" will not clear on a retry, so it must not wait for one.
        if (anthropicErrorCodeFor(response.status, rawBody) !== "quota_exceeded") {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
      }
      throw new AnthropicRequestError(
        anthropicErrorCodeFor(response.status, rawBody),
        `Anthropic answered HTTP ${response.status}: ${errorMessageFrom(rawBody)}`,
        { requestId, status: response.status },
      );
    }

    const json = (await response.json()) as {
      content?: { text?: string; type?: string }[];
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      inputTokens: json.usage?.input_tokens,
      model: json.model || params.model,
      outputText: jsonInstructionFor(params.format) ? cleanJsonReply(text) : text,
      outputTokens: json.usage?.output_tokens,
      requestId,
    };
  }
}
