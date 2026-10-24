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
// 🔴 TWO OPTIONAL FIELDS, AND THE PLAIN REQUEST BEHIND THEM (measured live 18 Oct 2026, after the first
// version shipped with neither). The first version sent model, max_tokens, system and messages only,
// because it was written before the live API could be called. Two things it left out were costing real
// failures once Claude was the only provider answering:
//   1. `output_config.effort`, translated from the caller's OpenAI `reasoning.effort`. Without it Claude
//      thinks at its own default (medium on Haiku 5.5, high on Sonnet 5.5) while OpenAI was told "low":
//      the signboard read took 3.5–3.8 s where low takes 2.2–2.4 s, and a door read timed out at 8 s.
//   2. `output_config.format`, Claude's own JSON outputs, for a caller that sends a JSON Schema. Asked
//      for in the system prompt alone, Haiku at low effort answered the signboard schema WITH THE SCHEMA
//      ITSELF, which parses as JSON and reads as "no signs at all". The constrained reply cannot do that.
// A request either field makes the API refuse (HTTP 400 naming it) is sent again without the format
// when the refusal is about the format — the effort kept — and plain only after that or when the effort
// is what was refused; that model + format pair keeps the shape that answered for the life of the
// process, so the worst case is the old behaviour. JSON is still asked for in the prompt whenever the
// format is dropped, and still cleaned on the way out.
//
// 🔴 TWO ANTHROPIC ACCOUNTS, ASKED IN ORDER (owner, 2026-10-24: "If no credit, then fall back to the first
// Anthropic account. If no credit in … the first Anthropic account, then fall back to the second"). The
// first account's key is ANTHROPIC_API_KEY and the second's ANTHROPIC_API_KEY_2. Every Messages call goes to
// the first and moves to the second ONLY when the first is out of credit or its key is refused — the same
// two codes that move a call off OpenAI (`shouldFailOverToNextProvider`); a timeout, a rate limit or a bad
// request stays with the account that gave it. An account that refused is asked LAST for the next ten
// minutes (never skipped: it is still the last resort), and asked first again once it answers. Each
// account is billed separately, so every reply and every failure names the account it came from, and the
// out-of-credit alarm pages for each by name.

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

/**
 * The Anthropic account a call was billed to. The names are the AI board's provider names
 * (`AiCallProvider` in ai-metrics.ts), so a caller records the account without a table.
 */
export type AnthropicAccount = "anthropic" | "anthropic_backup";

// In the order they are asked. The first keeps the name it has always had, so nothing already set moves.
export const ANTHROPIC_ACCOUNT_KEYS: readonly { account: AnthropicAccount; envName: string }[] = [
  { account: "anthropic", envName: "ANTHROPIC_API_KEY" },
  { account: "anthropic_backup", envName: "ANTHROPIC_API_KEY_2" },
];

// Same spellings as PhoenixOpenAiErrorCode, so openai-client.ts maps one onto the other without a table.
export class AnthropicRequestError extends Error {
  /** The account that refused, so the failure row and the alarm name the account to top up. */
  account?: AnthropicAccount;
  code: AnthropicFailureCode;
  requestId?: string;
  status?: number;

  constructor(
    code: AnthropicFailureCode,
    message: string,
    options: { account?: AnthropicAccount; requestId?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "AnthropicRequestError";
    this.account = options.account;
    this.code = code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

/** Whether ANY Anthropic account has a key — the first, the second, or both. */
export function hasAnthropicApiKey(env: AnthropicEnv = process.env) {
  return ANTHROPIC_ACCOUNT_KEYS.some(({ envName }) => Boolean(env[envName]?.trim()));
}

// The two failures that mean the ACCOUNT is dead, so the next account is asked. The same pair as
// `shouldFailOverToNextProvider` in openai-client.ts, kept here because that module imports this one.
export function shouldTryNextAnthropicAccount(code: AnthropicFailureCode) {
  return code === "quota_exceeded" || code === "auth_failed";
}

// An account that refused for credit or its key is asked last for this long, then first again.
export const ANTHROPIC_ACCOUNT_BENCH_MS = 10 * 60_000;
const accountBenchedUntil = new Map<AnthropicAccount, number>();

export function noteAnthropicAccountUnavailable(account: AnthropicAccount, nowMs = Date.now()) {
  accountBenchedUntil.set(account, nowMs + ANTHROPIC_ACCOUNT_BENCH_MS);
}

export function noteAnthropicAccountAvailable(account: AnthropicAccount) {
  accountBenchedUntil.delete(account);
}

export function resetAnthropicAccountMemory() {
  accountBenchedUntil.clear();
}

/**
 * The accounts to ask, in order: every account with a key, the first before the second, except that one
 * which refused in the last ten minutes goes to the back. The same key pasted under both names is one
 * account, asked once.
 */
export function planAnthropicAccounts(
  env: AnthropicEnv = process.env,
  nowMs = Date.now(),
): { account: AnthropicAccount; apiKey: string }[] {
  const seen = new Set<string>();
  const accounts: { account: AnthropicAccount; apiKey: string }[] = [];
  for (const { account, envName } of ANTHROPIC_ACCOUNT_KEYS) {
    const apiKey = env[envName]?.trim();
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    accounts.push({ account, apiKey });
  }
  const benched = (account: AnthropicAccount) => nowMs < (accountBenchedUntil.get(account) ?? 0);
  return [...accounts.filter((entry) => !benched(entry.account)), ...accounts.filter((entry) => benched(entry.account))];
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

export type AnthropicEffort = "high" | "low" | "medium";

export type AnthropicOutputFormat = { schema: unknown; type: "json_schema" };

export type AnthropicRequestBody = {
  max_tokens: number;
  messages: AnthropicMessage[];
  model: string;
  output_config?: { effort?: AnthropicEffort; format?: AnthropicOutputFormat };
  system: string;
};

// The families that take `output_config.effort` (Opus 4.5 onward, Sonnet 4.6 onward, every 5-series
// model). Anything else — an older model forced through ANTHROPIC_MODEL — is sent no effort at all.
const EFFORT_MODELS = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[5-8]|sonnet-4-6)(?:-|$)/i;

// The families that take `output_config.format` (Claude's JSON outputs).
const STRUCTURED_OUTPUT_MODELS = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|opus-4-[158]|haiku-4-5)(?:-|$)/i;

/**
 * The Claude effort for the caller's OpenAI `reasoning.effort`, or null to send none. `xhigh` is capped
 * at `high`, the top level every effort-taking model accepts; an unknown value sends nothing.
 */
export function anthropicEffortFor(effort: unknown, model: string): AnthropicEffort | null {
  if (!EFFORT_MODELS.test(model)) return null;
  switch (String(effort ?? "").trim().toLowerCase()) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default:
      return null;
  }
}

// JSON Schema keywords Claude's JSON outputs refuse (numeric and string bounds, array-size rules) plus
// OpenAI's own `strict` flag, which some callers carry inside the schema object. Dropped, never rewritten:
// every caller validates the parsed reply itself, exactly as it did for OpenAI.
const DROPPED_SCHEMA_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "strict",
  "uniqueItems",
]);
const SUPPORTED_STRING_FORMATS = new Set(["date", "date-time", "duration", "email", "hostname", "ipv4", "ipv6", "time", "uri", "uuid"]);

/**
 * A copy of an OpenAI JSON Schema that Claude's JSON outputs accept. Property NAMES are never touched —
 * a field called "pattern" or "format" is data, only a keyword in a schema position is dropped.
 */
export function schemaForAnthropic(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (DROPPED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "format" && typeof value === "string" && !SUPPORTED_STRING_FORMATS.has(value)) continue;
    if ((key === "properties" || key === "$defs" || key === "definitions") && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, schemaForAnthropic(sub)]));
    } else if ((key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map(schemaForAnthropic);
    } else if (key === "items" || key === "not" || (key === "additionalProperties" && typeof value === "object")) {
      out[key] = schemaForAnthropic(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Model + format pairs the API refused part of `output_config` for, in this process, and the shape that
// answered instead. They are sent in that shape from then on, so a refused schema costs one extra round
// trip once, never on every call.
//
// 🔴 TWO SHAPES, NOT ONE (19 Oct 2026). `without_format` drops only Claude's JSON outputs and KEEPS the
// effort; `plain` drops both. The resend used to be plain for every refusal, and the CV reader's refusal
// is about its SCHEMA alone ("too many parameters with union types" — 39 of a 16 limit), so the plain
// resend threw away an effort nobody had refused. Haiku then thought at its own default: replayed on the
// 11:18 Cairo CV three times, 7,280, 8,000 and 7,841 output tokens for about 10,000 characters of JSON —
// the rest a thinking block — and once it ran out of room at 8,000, which is the failure the escalation
// had to catch with a 37-second Sonnet read.
type DegradedShape = "plain" | "without_format";
const degradedRequests = new Map<string, DegradedShape>();

function plainOnlyKey(format: unknown, model: string) {
  const wanted = (format ?? {}) as { name?: unknown; schema?: unknown; type?: unknown };
  const name = typeof wanted.name === "string" && wanted.name ? wanted.name : JSON.stringify(wanted.schema ?? wanted.type ?? null);
  return `${model}|${name}`;
}

export function resetAnthropicPlainOnlyMemory() {
  degradedRequests.clear();
}

/** Claude's JSON outputs for an OpenAI `json_schema` format, or null when this call cannot use them. */
export function anthropicOutputFormatFor(format: unknown, model: string): AnthropicOutputFormat | null {
  const wanted = (format ?? {}) as { schema?: unknown; type?: string };
  if (wanted.type !== "json_schema" || !wanted.schema || typeof wanted.schema !== "object") return null;
  if (!STRUCTURED_OUTPUT_MODELS.test(model)) return null;
  return { schema: schemaForAnthropic(wanted.schema), type: "json_schema" };
}

// An HTTP 400 that names one of the optional fields — the one answer the plain resend exists for.
// "schema" is matched anywhere in a word: the CV reader's 50 nullable fields were refused on 18 Oct 2026
// with "Schemas contains too many parameters with union types", which a whole-word match never saw.
export function isOptionalFieldRefusal(status: number, rawBody: string) {
  return status === 400 && /output_config|output_format|schema|\beffort\b|union types/i.test(rawBody);
}

/**
 * The resends a refusal earns, in order. A refusal that does not name the effort is about the FORMAT, so
 * the first resend keeps the effort and drops only the format; plain is the second resort. A refusal
 * that names the effort, or a request that has nothing but one of the two to drop, goes straight to plain.
 */
export function resendShapesFor(rawBody: string, sent: { effort?: unknown; format?: unknown } | undefined): DegradedShape[] {
  if (sent?.effort && sent?.format && !/\beffort\b/i.test(rawBody)) return ["without_format", "plain"];
  return ["plain"];
}

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
    // "the data itself, never the schema": without it Haiku answered with the schema (see the header).
    return (
      "Reply with ONLY one JSON object that conforms to the JSON Schema below: the data itself, never the "
      + "schema. No prose before or after it, no markdown fences, no comments.\nJSON Schema:\n"
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
 * `plain` builds the request with no `output_config` at all, and `withoutFormat` keeps the effort and
 * drops only the JSON outputs — the two shapes the API is resent in when it refuses one of the optional
 * fields (see the header and `resendShapesFor`).
 */
export function buildAnthropicRequest(
  params: { format?: unknown; input: unknown; instructions: string; maxOutputTokens: number; reasoningEffort?: unknown },
  model: string,
  options: { plain?: boolean; withoutFormat?: boolean } = {},
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

  const remembered = degradedRequests.get(plainOnlyKey(params.format, model));
  const plain = options.plain === true || remembered === "plain";
  const withoutFormat = plain || options.withoutFormat === true || remembered === "without_format";
  const effort = plain ? null : anthropicEffortFor(params.reasoningEffort, model);
  const format = withoutFormat ? null : anthropicOutputFormatFor(params.format, model);

  // With Claude's JSON outputs the API hands the model the schema itself; repeating it in the prompt
  // would pay for it twice and is what invited the schema-echo answer in the first place.
  const jsonInstruction = format ? null : jsonInstructionFor(params.format);
  if (jsonInstruction) system.push(jsonInstruction);

  return {
    max_tokens: params.maxOutputTokens,
    messages,
    model,
    ...(effort || format ? { output_config: { ...(effort ? { effort } : {}), ...(format ? { format } : {}) } } : {}),
    system: system.filter((part) => part.trim().length > 0).join("\n\n"),
  };
}

// The answer a model gives when it repeats a JSON Schema back instead of filling it in: the schema's own
// top-level keywords, where the schema itself has no property of that name.
export function isEchoedSchema(reply: string, format: unknown) {
  const wanted = (format ?? {}) as { schema?: { properties?: Record<string, unknown> }; type?: string };
  if (wanted.type !== "json_schema") return false;
  try {
    const parsed = JSON.parse(reply) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const own = wanted.schema?.properties ?? {};
    return parsed.type === "object" && typeof parsed.properties === "object" && !("properties" in own) && !("type" in own);
  } catch {
    return false;
  }
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
 *
 * 🔴 A WORKSPACE SPEND LIMIT IS A 400 TOO (code review, 19 Oct 2026): "You have reached your specified API
 * usage limits. You will regain access on …", type `invalid_request_error`. Read only at 429 it fell to
 * `failed`: no failover to the next provider and no alarm, while every call Claude answers was refused.
 */
export function anthropicErrorCodeFor(status: number, rawBody: string): AnthropicFailureCode {
  const body = rawBody.toLowerCase();
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "quota_exceeded";
  if (status === 400 && (body.includes("credit balance") || body.includes("billing") || isSpendLimitBody(body))) {
    return "quota_exceeded";
  }
  if (status === 429) {
    return isSpendLimitBody(body) || body.includes("credit balance") ? "quota_exceeded" : "rate_limited";
  }
  return "failed";
}

/** A lowercased body naming the account's usage or spend limit — reached until the limit resets or is raised. */
function isSpendLimitBody(body: string) {
  return body.includes("usage limit") || body.includes("spend limit");
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
  /** The account that answered — the one the call is billed to. */
  account: AnthropicAccount;
  inputTokens?: number;
  model: string;
  outputText: string;
  outputTokens?: number;
  requestId?: string;
};

// The plain resend gets what is left of the call's own timeout, never a fresh one, but never under this.
const PLAIN_RESEND_MIN_MS = 1_000;

export type AnthropicCallParams = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  format?: unknown;
  input: unknown;
  instructions: string;
  maxOutputTokens: number;
  maxRetries: number;
  model: string;
  /** The caller's OpenAI `reasoning.effort`, translated by `anthropicEffortFor`. */
  reasoningEffort?: unknown;
  /** The caller's own way to stop the call once its answer is no longer needed (the signboard door). */
  signal?: AbortSignal;
  timeoutMs: number;
  /**
   * Told each time an account refuses for credit or its key and the next account is asked, so the caller
   * records that account's refusal (the out-of-credit alarm reads it) although the call itself succeeds.
   */
  onAccountFailedOver?: (refusal: {
    account: AnthropicAccount;
    code: AnthropicFailureCode;
    latencyMs: number;
    nextAccount: AnthropicAccount;
  }) => void;
};

/**
 * One Messages call, asked of each Anthropic account in turn (see the header): the next account only when
 * this one is out of credit or its key is refused, with what is left of `timeoutMs`. `apiKey` pins one key
 * and asks nothing else. Throws the last account's `AnthropicRequestError`, which names that account.
 */
export async function callAnthropicMessages(params: AnthropicCallParams, env: AnthropicEnv = process.env): Promise<AnthropicReply> {
  const pinned = params.apiKey?.trim();
  const accounts = pinned ? [{ account: "anthropic" as const, apiKey: pinned }] : planAnthropicAccounts(env);
  if (accounts.length === 0) throw new AnthropicRequestError("failed", "ANTHROPIC_API_KEY is not configured.");

  const startedAt = Date.now();
  for (const [index, { account, apiKey }] of accounts.entries()) {
    const legStartedAt = Date.now();
    const timeoutMs = index === 0 ? params.timeoutMs : Math.max(PLAIN_RESEND_MIN_MS, params.timeoutMs - (legStartedAt - startedAt));
    try {
      const reply = await callOneAnthropicAccount(params, account, apiKey, timeoutMs);
      noteAnthropicAccountAvailable(account);
      return reply;
    } catch (error) {
      if (!(error instanceof AnthropicRequestError) || params.signal?.aborted || !shouldTryNextAnthropicAccount(error.code)) {
        throw error;
      }
      // Benched only when another account can be asked instead: alone, it stays first and is asked again.
      if (accounts.length > 1) noteAnthropicAccountUnavailable(account);
      const next = accounts[index + 1];
      // Under a second left is not a call worth making; the refusal is the answer.
      if (!next || params.timeoutMs - (Date.now() - startedAt) < PLAIN_RESEND_MIN_MS) throw error;
      params.onAccountFailedOver?.({ account, code: error.code, latencyMs: Date.now() - legStartedAt, nextAccount: next.account });
    }
  }

  // Unreachable: `accounts` is never empty here, and its last entry always returns or throws above.
  throw new AnthropicRequestError("failed", "No Anthropic account was asked.");
}

/**
 * One Messages API round trip to ONE account, with the same retry budget shape as the OpenAI client
 * (`maxRetries` extra tries on a 429 / 5xx / 529, never on a timeout). A 400 naming `output_config` is
 * answered by at most two resends in smaller shapes (`resendShapesFor`), which are not retries and spend
 * none of `maxRetries`. Throws `AnthropicRequestError` naming the account — also for a refusal, a JSON
 * answer cut off at max_tokens, and a schema repeated back instead of filled in; never logs, and never
 * puts the key in a message.
 */
async function callOneAnthropicAccount(
  params: AnthropicCallParams,
  account: AnthropicAccount,
  apiKey: string,
  timeoutMs: number,
): Promise<AnthropicReply> {
  const shape = {
    format: params.format,
    input: params.input,
    instructions: params.instructions,
    maxOutputTokens: params.maxOutputTokens,
    reasoningEffort: params.reasoningEffort,
  };
  let request = buildAnthropicRequest(shape, params.model);
  const doFetch = params.fetchImpl ?? fetch;

  const post = async (body: AnthropicRequestBody, budgetMs: number) => {
    try {
      return await doFetch(ANTHROPIC_MESSAGES_URL, {
        body: JSON.stringify(body),
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        method: "POST",
        signal: params.signal ? AbortSignal.any([AbortSignal.timeout(budgetMs), params.signal]) : AbortSignal.timeout(budgetMs),
      });
    } catch (error) {
      // Stopped by the caller, not timed out: the caller already has its answer and records nothing for this one.
      if (params.signal?.aborted) throw new AnthropicRequestError("failed", "The Anthropic request was cancelled by its caller.", { account });
      if (isTimeout(error)) throw new AnthropicRequestError("timeout", "The Anthropic request timed out.", { account });
      throw new AnthropicRequestError("failed", error instanceof Error ? error.message : "The Anthropic request failed.", { account });
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    const sentAt = Date.now();
    let response = await post(request, timeoutMs);
    let rawBody = response.ok ? "" : await response.text().catch(() => "");

    if (!response.ok && request.output_config && isOptionalFieldRefusal(response.status, rawBody)) {
      // At most two resends, each a smaller shape, and never a loop: the format alone first when the
      // refusal is about it, then plain (see `degradedRequests`).
      for (const resend of resendShapesFor(rawBody, request.output_config)) {
        request = buildAnthropicRequest(shape, params.model, resend === "plain" ? { plain: true } : { withoutFormat: true });
        response = await post(request, Math.max(PLAIN_RESEND_MIN_MS, timeoutMs - (Date.now() - sentAt)));
        rawBody = response.ok ? "" : await response.text().catch(() => "");
        // Remembered only when a smaller shape is what worked: a request the API refuses every way is
        // broken for another reason, and must not switch the optional fields off for the whole process.
        if (response.ok) {
          degradedRequests.set(plainOnlyKey(params.format, params.model), resend);
          break;
        }
        if (!request.output_config || !isOptionalFieldRefusal(response.status, rawBody)) break;
      }
    }

    const requestId = response.headers.get("request-id") ?? undefined;

    if (!response.ok) {
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
        { account, requestId, status: response.status },
      );
    }

    const json = (await response.json()) as {
      content?: { text?: string; type?: string }[];
      model?: string;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const wantsJson = jsonInstructionFor(params.format) !== null;
    const outputText = wantsJson ? cleanJsonReply(text) : text;

    // Each of these used to come back as an ordinary answer — an empty string, half an object, or the
    // schema — which every caller then misread as "the model found nothing". A named failure instead.
    if (json.stop_reason === "refusal") {
      throw new AnthropicRequestError("failed", "Claude declined to answer this request.", { account, requestId, status: response.status });
    }
    if (wantsJson && json.stop_reason === "max_tokens") {
      throw new AnthropicRequestError("failed", "Claude ran out of room before it finished the JSON answer (max_tokens).", {
        account,
        requestId,
        status: response.status,
      });
    }
    if (isEchoedSchema(outputText, params.format)) {
      throw new AnthropicRequestError("failed", "Claude repeated the JSON Schema instead of answering it.", {
        account,
        requestId,
        status: response.status,
      });
    }

    return {
      account,
      inputTokens: json.usage?.input_tokens,
      model: json.model || params.model,
      outputText,
      outputTokens: json.usage?.output_tokens,
      requestId,
    };
  }
}
