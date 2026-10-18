import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_STRONG_MODEL,
  AnthropicRequestError,
  anthropicErrorCodeFor,
  buildAnthropicRequest,
  callAnthropicMessages,
  cleanJsonReply,
  jsonInstructionFor,
  resolveAnthropicModel,
} from "@/lib/ai/anthropic-fallback.ts";
import {
  hasAiApiKey,
  isOpenAiOutOfCredit,
  noteOpenAiUnavailable,
  OPENAI_UNAVAILABLE_WINDOW_MS,
  planAiProviders,
  resetOpenAiAvailability,
  resolveAiProviderMode,
  shouldFailOverToNextProvider,
} from "@/lib/ai/openai-client.ts";

// The second AI provider (2026-10-18): the OpenAI account failed to recharge, and every AI feature calls
// ONE function. These tests never reach the network — the adapter takes its fetch as a parameter, and the
// suite runs with production credentials, so nothing here may build a real client.

const TEST_KEY = "sk-ant-test-key-for-unit-tests-0001";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });
}

async function expectRequestError(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AnthropicRequestError, "the adapter throws its own error type");
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /sk-ant-/, "a key must never appear in an error message");
    return true;
  });
}

function planningTests() {
  const openAiOnly = { OPENAI_API_KEY: "sk-test-openai-key-0000000000" };
  const anthropicOnly = { ANTHROPIC_API_KEY: TEST_KEY };
  const both = { ...openAiOnly, ...anthropicOnly };

  assert.deepEqual(planAiProviders(openAiOnly, 0, 0), ["openai"], "today's environment is unchanged");
  assert.deepEqual(planAiProviders({}, 0, 0), ["openai"], "no key at all still reaches the not-configured error");
  assert.deepEqual(planAiProviders(anthropicOnly, 0, 0), ["anthropic"]);
  assert.deepEqual(planAiProviders(both, 0, 0), ["openai", "anthropic"], "OpenAI first, Anthropic as the second resort");
  assert.deepEqual(
    planAiProviders(both, 1_000, 5_000),
    ["anthropic", "openai"],
    "inside the unavailable window a call goes straight to Anthropic",
  );
  assert.deepEqual(planAiProviders(both, 5_000, 5_000), ["openai", "anthropic"], "the window closes by itself");
  assert.deepEqual(planAiProviders({ ...both, AI_PROVIDER: "openai" }, 0, 0), ["openai"]);
  assert.deepEqual(planAiProviders({ ...both, AI_PROVIDER: " Anthropic " }, 0, 0), ["anthropic"]);
  assert.equal(resolveAiProviderMode({ AI_PROVIDER: "nonsense" }), "auto", "an unknown value is auto, not an error");

  noteOpenAiUnavailable(10_000);
  try {
    assert.deepEqual(planAiProviders(both, 10_001), ["anthropic", "openai"], "the module remembers an unavailable OpenAI");
    assert.deepEqual(planAiProviders(both, 10_000 + OPENAI_UNAVAILABLE_WINDOW_MS), ["openai", "anthropic"]);
  } finally {
    resetOpenAiAvailability();
  }
  assert.deepEqual(planAiProviders(both, 10_001), ["openai", "anthropic"], "a reset forgets it");

  assert.equal(hasAiApiKey({}), false);
  assert.equal(hasAiApiKey(openAiOnly), true);
  assert.equal(hasAiApiKey(anthropicOnly), true, "an Anthropic key alone must keep every AI feature switched on");
  assert.equal(hasAiApiKey({ ...both, AI_PROVIDER: "openai" }), true);
  assert.equal(hasAiApiKey({ ...anthropicOnly, AI_PROVIDER: "openai" }), false, "a pinned provider needs ITS key");
  assert.equal(hasAiApiKey({ ...openAiOnly, AI_PROVIDER: "anthropic" }), false);

  assert.equal(shouldFailOverToNextProvider("quota_exceeded"), true);
  assert.equal(shouldFailOverToNextProvider("auth_failed"), true);
  for (const code of ["timeout", "rate_limited", "failed", "not_configured"] as const) {
    assert.equal(shouldFailOverToNextProvider(code), false, `${code} stays with the provider that gave it`);
  }

  // 🔴 The account's real answer on 18 Oct 2026 (HTTP 429, "You have no credits remaining"). Read by its
  //    code alone it was a rate limit, and nothing failed over while every AI feature was down.
  assert.equal(isOpenAiOutOfCredit("credit_balance_exhausted", "insufficient_quota"), true, "the 18 Oct answer is out of credit");
  assert.equal(isOpenAiOutOfCredit("credit_balance_exhausted", undefined), true, "by its code alone");
  assert.equal(isOpenAiOutOfCredit(undefined, "insufficient_quota"), true, "or by its type alone");
  assert.equal(isOpenAiOutOfCredit("insufficient_quota", undefined), true, "the older answer still counts");
  assert.equal(isOpenAiOutOfCredit("rate_limit_exceeded", "requests"), false, "a real rate limit stays a rate limit");
  assert.equal(isOpenAiOutOfCredit(undefined, undefined), false);
}

function modelTests() {
  assert.equal(resolveAnthropicModel("gpt-5.4-nano", {}), ANTHROPIC_FAST_MODEL);
  assert.equal(resolveAnthropicModel("gpt-5.4-mini", {}), ANTHROPIC_FAST_MODEL);
  assert.equal(resolveAnthropicModel("gpt-5.4", {}), ANTHROPIC_STRONG_MODEL);
  assert.equal(resolveAnthropicModel("gpt-5.5", {}), ANTHROPIC_STRONG_MODEL);
  assert.equal(resolveAnthropicModel("claude-opus-5-5", {}), "claude-opus-5-5", "a Claude name is left alone");
  assert.equal(resolveAnthropicModel("gpt-5.4", { ANTHROPIC_MODEL: " claude-x " }), "claude-x", "one model forced for every call");
  assert.equal(resolveAnthropicModel("gpt-5.4-nano", { ANTHROPIC_FAST_MODEL: "fast-x" }), "fast-x");
  assert.equal(resolveAnthropicModel("gpt-5.4", { ANTHROPIC_STRONG_MODEL: "strong-x" }), "strong-x");
}

function requestShapeTests() {
  const plain = buildAnthropicRequest(
    { input: "Draft a reply", instructions: "You write short emails.", maxOutputTokens: 900 },
    "claude-haiku-5-5",
  );
  assert.deepEqual(Object.keys(plain).sort(), ["max_tokens", "messages", "model", "system"], "no optional parameter is sent");
  assert.equal(plain.max_tokens, 900);
  assert.equal(plain.system, "You write short emails.");
  assert.deepEqual(plain.messages, [{ content: [{ text: "Draft a reply", type: "text" }], role: "user" }]);

  const schema = { additionalProperties: false, properties: { subject: { type: "string" } }, required: ["subject"], type: "object" };
  const withSchema = buildAnthropicRequest(
    { format: { name: "email", schema, strict: true, type: "json_schema" }, input: "x", instructions: "Base.", maxOutputTokens: 10 },
    "m",
  );
  assert.match(withSchema.system, /^Base\./);
  assert.ok(withSchema.system.includes(JSON.stringify(schema)), "the schema travels in the system prompt");
  assert.match(withSchema.system, /ONLY one JSON object/);
  assert.match(jsonInstructionFor({ type: "json_object" }) ?? "", /valid JSON object/);
  assert.equal(jsonInstructionFor({ type: "text" }), null);
  assert.equal(jsonInstructionFor(undefined), null);

  const multimodal = buildAnthropicRequest(
    {
      input: [
        { content: [{ text: "Policy text", type: "input_text" }], role: "developer" },
        {
          content: [
            { text: "Read this CV", type: "input_text" },
            { image_url: "data:image/png;base64,AAAA", type: "input_image" },
            { file_data: "data:application/pdf;base64,BBBB", filename: "cv.pdf", type: "input_file" },
          ],
          role: "user",
        },
        { content: [{ text: "And this too", type: "input_text" }], role: "user" },
      ],
      instructions: "Extract fields.",
      maxOutputTokens: 5,
    },
    "m",
  );
  assert.equal(multimodal.system, "Extract fields.\n\nPolicy text", "developer and system items join the system prompt");
  assert.equal(multimodal.messages.length, 1, "consecutive user items merge into one turn");
  assert.deepEqual(multimodal.messages[0].content, [
    { text: "Read this CV", type: "text" },
    { source: { data: "AAAA", media_type: "image/png", type: "base64" }, type: "image" },
    { source: { data: "BBBB", media_type: "application/pdf", type: "base64" }, title: "cv.pdf", type: "document" },
    { text: "And this too", type: "text" },
  ]);

  const remoteImage = buildAnthropicRequest(
    { input: [{ content: [{ image_url: "https://example.com/a.png", type: "input_image" }], role: "user" }], instructions: "i", maxOutputTokens: 1 },
    "m",
  );
  assert.deepEqual(remoteImage.messages[0].content, [{ source: { type: "url", url: "https://example.com/a.png" }, type: "image" }]);

  assert.throws(
    () => buildAnthropicRequest({ input: [{ content: [{ type: "input_audio" }], role: "user" }], instructions: "i", maxOutputTokens: 1 }, "m"),
    AnthropicRequestError,
    "a part the adapter cannot send is refused, never dropped",
  );
  assert.throws(
    () => buildAnthropicRequest({ input: [{ content: [{ file_data: "data:text/plain;base64,QQ==", type: "input_file" }], role: "user" }], instructions: "i", maxOutputTokens: 1 }, "m"),
    AnthropicRequestError,
  );
  assert.throws(() => buildAnthropicRequest({ input: [], instructions: "i", maxOutputTokens: 1 }, "m"), AnthropicRequestError, "no user content");
  assert.throws(() => buildAnthropicRequest({ input: 42, instructions: "i", maxOutputTokens: 1 }, "m"), AnthropicRequestError);
}

function replyCleaningTests() {
  assert.equal(cleanJsonReply('{"a":1}'), '{"a":1}');
  assert.equal(cleanJsonReply('```json\n{"a":1}\n```'), '{"a":1}', "a markdown fence is stripped");
  assert.equal(cleanJsonReply('Here you go:\n{"a":{"b":2}}\nHope that helps.'), '{"a":{"b":2}}', "prose around the object is cut");
  assert.equal(cleanJsonReply("no json at all"), "no json at all", "a reply with no object is handed back for the caller to refuse");
  assert.equal(cleanJsonReply('{"a":'), '{"a":', "a truncated object is not repaired");
}

function errorCodeTests() {
  assert.equal(anthropicErrorCodeFor(401, "{}"), "auth_failed");
  assert.equal(anthropicErrorCodeFor(403, "{}"), "auth_failed");
  assert.equal(anthropicErrorCodeFor(402, "{}"), "quota_exceeded");
  assert.equal(
    anthropicErrorCodeFor(400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
    "quota_exceeded",
    "out of credit arrives as a 400 here",
  );
  assert.equal(anthropicErrorCodeFor(400, '{"error":{"message":"max_tokens is required"}}'), "failed", "an ordinary 400 is not a dead account");
  assert.equal(anthropicErrorCodeFor(429, '{"error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}'), "rate_limited");
  assert.equal(anthropicErrorCodeFor(429, '{"error":{"message":"You have reached your specified API usage limits."}}'), "quota_exceeded");
  assert.equal(anthropicErrorCodeFor(529, "overloaded"), "failed");
  assert.equal(anthropicErrorCodeFor(500, ""), "failed");
}

async function callTests() {
  let seen: { body: Record<string, unknown>; headers: Record<string, string>; url: string } | null = null;
  const ok = await callAnthropicMessages({
    apiKey: TEST_KEY,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      seen = {
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
        url: String(url),
      };
      return jsonResponse(
        {
          content: [
            { text: '```json\n{"subject":', type: "text" },
            { type: "thinking" },
            { text: '"Hi"}\n```', type: "text" },
          ],
          model: "claude-sonnet-5-5-20260101",
          usage: { input_tokens: 11, output_tokens: 7 },
        },
        200,
        { "request-id": "req_123" },
      );
    }) as typeof fetch,
    format: { schema: { type: "object" }, type: "json_schema" },
    input: "hello",
    instructions: "Be brief.",
    maxOutputTokens: 100,
    maxRetries: 0,
    model: "claude-sonnet-5-5",
    timeoutMs: 5_000,
  });
  assert.equal(ok.outputText, '{"subject":"Hi"}', "text blocks join and the fenced JSON is cleaned");
  assert.equal(ok.inputTokens, 11);
  assert.equal(ok.outputTokens, 7);
  assert.equal(ok.requestId, "req_123");
  assert.equal(ok.model, "claude-sonnet-5-5-20260101");
  assert.ok(seen, "the request reached the injected fetch");
  const request = seen as unknown as { body: Record<string, unknown>; headers: Record<string, string>; url: string };
  assert.equal(request.url, ANTHROPIC_MESSAGES_URL);
  assert.equal(request.headers["x-api-key"], TEST_KEY);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(Object.keys(request.body).sort(), ["max_tokens", "messages", "model", "system"]);

  const plainText = await callAnthropicMessages({
    apiKey: TEST_KEY,
    fetchImpl: (async () => jsonResponse({ content: [{ text: "```not json```", type: "text" }] })) as typeof fetch,
    input: "hello",
    instructions: "i",
    maxOutputTokens: 5,
    maxRetries: 0,
    model: "m",
    timeoutMs: 5_000,
  });
  assert.equal(plainText.outputText, "```not json```", "a plain-text call is returned untouched");

  const failing = (status: number, body: unknown) => () =>
    callAnthropicMessages({
      apiKey: TEST_KEY,
      fetchImpl: (async () => jsonResponse(body, status)) as typeof fetch,
      input: "hello",
      instructions: "i",
      maxOutputTokens: 5,
      maxRetries: 0,
      model: "m",
      timeoutMs: 5_000,
    });
  await expectRequestError(failing(401, { error: { message: "invalid x-api-key" } }), "auth_failed");
  await expectRequestError(failing(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } }), "quota_exceeded");
  await expectRequestError(failing(429, { error: { message: "slow down" } }), "rate_limited");
  await expectRequestError(failing(529, { error: { message: "Overloaded" } }), "failed");

  await expectRequestError(
    () =>
      callAnthropicMessages({
        apiKey: TEST_KEY,
        fetchImpl: (async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }) as typeof fetch,
        input: "hello",
        instructions: "i",
        maxOutputTokens: 5,
        maxRetries: 0,
        model: "m",
        timeoutMs: 5_000,
      }),
    "timeout",
  );

  let calls = 0;
  const retried = await callAnthropicMessages({
    apiKey: TEST_KEY,
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ error: { message: "busy" } }, 529) : jsonResponse({ content: [{ text: "ok", type: "text" }] });
    }) as typeof fetch,
    input: "hello",
    instructions: "i",
    maxOutputTokens: 5,
    maxRetries: 1,
    model: "m",
    timeoutMs: 5_000,
  });
  assert.equal(retried.outputText, "ok");
  assert.equal(calls, 2, "a 529 is retried once when the budget allows it");

  calls = 0;
  await expectRequestError(
    () =>
      callAnthropicMessages({
        apiKey: TEST_KEY,
        fetchImpl: (async () => {
          calls += 1;
          return jsonResponse({ error: { message: "Your credit balance is too low" } }, 429);
        }) as typeof fetch,
        input: "hello",
        instructions: "i",
        maxOutputTokens: 5,
        maxRetries: 3,
        model: "m",
        timeoutMs: 5_000,
      }),
    "quota_exceeded",
  );
  assert.equal(calls, 1, "an out-of-credit answer is never retried");

  await expectRequestError(
    () =>
      callAnthropicMessages({
        apiKey: "   ",
        fetchImpl: (async () => jsonResponse({})) as typeof fetch,
        input: "hello",
        instructions: "i",
        maxOutputTokens: 5,
        maxRetries: 0,
        model: "m",
        timeoutMs: 5_000,
      }),
    "failed",
  );
}

function wiringTests() {
  const client = readFileSync("src/lib/ai/openai-client.ts", "utf8");
  const entry = client.slice(client.indexOf("export async function createOpenAiResponseText"));
  assert.match(entry, /planAiProviders\(\)/, "the shared entry point asks the plan which provider answers");
  assert.match(entry, /runAnthropicResponse\(params, requestedModel\)/);
  assert.match(entry, /runOpenAiResponse\(params, requestedModel\)/);
  assert.match(
    entry,
    /shouldFailOverToNextProvider\(failure\.code\)\) throw failure/,
    "only a dead account fails over; any other error is thrown from the provider that gave it",
  );
  assert.match(entry, /noteOpenAiUnavailable\(\)/, "a dead OpenAI account is remembered so the next call skips it");

  const normalizer = client.slice(client.indexOf("export function normalizeOpenAiError"), client.indexOf("function openAiClient"));
  assert.match(normalizer, /const outOfCredit = isOpenAiOutOfCredit\(code, typeFrom\(error\)\);/, "out of credit is read from the code AND the type");
  assert.equal(
    normalizer.split('outOfCredit ? "quota_exceeded" : "rate_limited"').length - 1,
    2,
    "both 429 branches (the SDK's RateLimitError and a bare 429) ask it",
  );
  assert.doesNotMatch(normalizer, /code === "insufficient_quota"/, "never the code alone again");

  const anthropicRun = client.slice(client.indexOf("async function runAnthropicResponse"), client.indexOf("function normalizeAnthropicError"));
  assert.match(anthropicRun, /recordAiCall\(\{[\s\S]*status: "success"/, "an Anthropic success lands on the AI telemetry board");
  assert.match(anthropicRun, /recordAiCall\(\{[\s\S]*status: "error"/, "an Anthropic failure raises the same alarm as an OpenAI one");

  const shapeRules = readFileSync("scripts/secret-shape-rules.mjs", "utf8");
  assert.match(shapeRules, /name: "ANTHROPIC_API_KEY"/, "the new key has a shape rule before any key is pasted");
}

export async function runAiProviderFailoverTests() {
  planningTests();
  modelTests();
  requestShapeTests();
  replyCleaningTests();
  errorCodeTests();
  await callTests();
  wiringTests();
}
