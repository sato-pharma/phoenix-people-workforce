import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_STRONG_MODEL,
  AnthropicRequestError,
  anthropicEffortFor,
  anthropicErrorCodeFor,
  anthropicOutputFormatFor,
  buildAnthropicRequest,
  callAnthropicMessages,
  cleanJsonReply,
  isEchoedSchema,
  isOptionalFieldRefusal,
  jsonInstructionFor,
  resetAnthropicPlainOnlyMemory,
  resolveAnthropicModel,
  schemaForAnthropic,
} from "@/lib/ai/anthropic-fallback.ts";
import {
  AI_FAILOVER_MIN_LEG_MS,
  failoverLegTimeoutMs,
  hasAiApiKey,
  isOpenAiOutOfCredit,
  isOpenAiUnavailable,
  noteOpenAiAvailable,
  noteOpenAiUnavailable,
  OPENAI_UNAVAILABLE_MAX_WINDOW_MS,
  OPENAI_UNAVAILABLE_WINDOW_MS,
  openAiUnavailableWindowMs,
  planAiProviders,
  resetOpenAiAvailability,
  resolveAiProviderMode,
  shouldFailOverToNextProvider,
} from "@/lib/ai/openai-client.ts";

// The second AI provider (2026-10-18): the OpenAI account failed to recharge, and every AI feature calls
// ONE function. These tests never reach the network — the adapter takes its fetch as a parameter, and the
// suite runs with production credentials, so nothing here may build a real client.

const TEST_KEY = "sk-ant-test-key-for-unit-tests-0001";

// What Anthropic answered the CV reader's 50-nullable-field schema with, on production 18 Oct 2026.
const CV_SCHEMA_REFUSAL = JSON.stringify({
  error: {
    message:
      "Schemas contains too many parameters with union types (50 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters.",
    type: "invalid_request_error",
  },
  type: "error",
});

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

  // 🔴 The wait DOUBLES while the account stays dead (18 Oct 2026: a fixed ten minutes walked every
  //    process back into the dead account six times an hour, each time with a user waiting on it).
  assert.deepEqual(
    [1, 2, 3, 4, 9].map((streak) => openAiUnavailableWindowMs(streak) / 60_000),
    [10, 20, 40, 60, 60],
    "ten minutes, doubling, capped at an hour",
  );
  assert.equal(OPENAI_UNAVAILABLE_MAX_WINDOW_MS, 60 * 60_000);
  try {
    let now = 0;
    noteOpenAiUnavailable(now);
    assert.equal(isOpenAiUnavailable(now + OPENAI_UNAVAILABLE_WINDOW_MS - 1), true);
    noteOpenAiUnavailable(now + 1_000);
    assert.equal(
      isOpenAiUnavailable(now + 1_000 + OPENAI_UNAVAILABLE_WINDOW_MS + 1),
      false,
      "a second failure INSIDE the window (calls that were already in flight) is not a new strike",
    );
    now += 1_000 + OPENAI_UNAVAILABLE_WINDOW_MS;
    noteOpenAiUnavailable(now);
    assert.equal(isOpenAiUnavailable(now + OPENAI_UNAVAILABLE_WINDOW_MS + 1), true, "dead again after the window: the wait doubles");
    assert.equal(isOpenAiUnavailable(now + 2 * OPENAI_UNAVAILABLE_WINDOW_MS), false);
    noteOpenAiAvailable();
    assert.equal(isOpenAiUnavailable(now + 1), false, "one answer from OpenAI ends the wait");
    noteOpenAiUnavailable(now);
    assert.equal(isOpenAiUnavailable(now + OPENAI_UNAVAILABLE_WINDOW_MS), false, "and the next dead answer starts from ten minutes again");
  } finally {
    resetOpenAiAvailability();
  }

  // The second provider gets what is LEFT of the caller's budget (the door budgets 8 s for the whole read).
  assert.equal(failoverLegTimeoutMs(8_000, 1_200), 6_800);
  assert.equal(failoverLegTimeoutMs(8_000, 8_000 - AI_FAILOVER_MIN_LEG_MS), AI_FAILOVER_MIN_LEG_MS);
  assert.equal(failoverLegTimeoutMs(8_000, 7_500), null, "too little left is not a call");

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
  assert.match(withSchema.system, /the data itself, never the schema/, "Haiku answered the signboard schema with the schema");
  assert.match(jsonInstructionFor({ type: "json_object" }) ?? "", /valid JSON object/);
  assert.equal(jsonInstructionFor({ type: "text" }), null);
  assert.equal(jsonInstructionFor(undefined), null);

  // 🔴 The caller's effort reaches Claude. Without it Claude thought at its own default while OpenAI was
  //    told "low": 3.5–3.8 s per signboard read on Haiku where low takes 2.2–2.4 s (measured 18 Oct 2026).
  assert.equal(anthropicEffortFor("low", "claude-haiku-5-5"), "low");
  assert.equal(anthropicEffortFor("minimal", "claude-sonnet-5-5"), "low");
  assert.equal(anthropicEffortFor(" Medium ", "claude-sonnet-5-5"), "medium");
  assert.equal(anthropicEffortFor("high", "claude-opus-5-5"), "high");
  assert.equal(anthropicEffortFor("xhigh", "claude-sonnet-5-5"), "high", "capped at the top level every effort model takes");
  assert.equal(anthropicEffortFor(undefined, "claude-sonnet-5-5"), null);
  assert.equal(anthropicEffortFor("turbo", "claude-sonnet-5-5"), null, "an unknown value sends nothing");
  assert.equal(anthropicEffortFor("low", "claude-haiku-4-5"), null, "Haiku 4.5 refuses effort, so it is never sent one");
  assert.equal(anthropicEffortFor("low", "m"), null);
  const withEffort = buildAnthropicRequest(
    { input: "x", instructions: "i", maxOutputTokens: 10, reasoningEffort: "medium" },
    "claude-haiku-5-5",
  );
  assert.deepEqual(withEffort.output_config, { effort: "medium" });

  // 🔴 A JSON Schema goes to Claude's own JSON outputs, and the prompt then carries no copy of it.
  const signSchema = {
    additionalProperties: false,
    properties: {
      format: { type: "string" },
      pattern: { maxLength: 40, pattern: "^[a-z]+$", type: "string" },
      signs: { items: { additionalProperties: false, properties: { email: { format: "email", type: "string" }, phone: { format: "phone", type: "string" } }, required: ["email", "phone"], type: "object" }, maxItems: 9, type: ["array", "null"] },
      score: { anyOf: [{ maximum: 100, minimum: 0, type: "integer" }, { type: "null" }] },
    },
    required: ["format", "pattern", "signs", "score"],
    strict: true,
    type: "object",
  };
  assert.deepEqual(schemaForAnthropic(signSchema), {
    additionalProperties: false,
    properties: {
      format: { type: "string" },
      pattern: { type: "string" },
      signs: { items: { additionalProperties: false, properties: { email: { format: "email", type: "string" }, phone: { type: "string" } }, required: ["email", "phone"], type: "object" }, type: ["array", "null"] },
      score: { anyOf: [{ type: "integer" }, { type: "null" }] },
    },
    required: ["format", "pattern", "signs", "score"],
    type: "object",
  }, "refused keywords are dropped at every depth; property NAMES that look like keywords are kept");
  const structured = buildAnthropicRequest(
    { format: { name: "signs", schema: signSchema, strict: true, type: "json_schema" }, input: "x", instructions: "Read signs.", maxOutputTokens: 10, reasoningEffort: "low" },
    "claude-sonnet-5-5",
  );
  assert.deepEqual(structured.output_config, { effort: "low", format: { schema: schemaForAnthropic(signSchema), type: "json_schema" } });
  assert.equal(structured.system, "Read signs.", "with JSON outputs the schema is not repeated in the prompt");
  assert.equal(anthropicOutputFormatFor({ type: "json_object" }, "claude-sonnet-5-5"), null, "json_object has no schema to constrain to");
  assert.equal(anthropicOutputFormatFor({ schema: signSchema, type: "json_schema" }, "claude-3-haiku"), null, "an older model keeps the prompt");
  const plainShape = buildAnthropicRequest(
    { format: { name: "signs", schema: signSchema, type: "json_schema" }, input: "x", instructions: "i", maxOutputTokens: 10, reasoningEffort: "low" },
    "claude-sonnet-5-5",
    { plain: true },
  );
  assert.equal(plainShape.output_config, undefined, "the plain resend carries no optional field");
  assert.ok(plainShape.system.includes(JSON.stringify(signSchema)), "and asks for the JSON in the prompt instead");

  assert.equal(isOptionalFieldRefusal(400, '{"error":{"message":"output_config.format.schema: unsupported"}}'), true);
  // The CV reader's refusal on production, 18 Oct 2026 13:56 Cairo: it names neither field nor the bare word.
  assert.equal(isOptionalFieldRefusal(400, CV_SCHEMA_REFUSAL), true, "a schema refused for its union types is resent plain");
  assert.equal(isOptionalFieldRefusal(400, '{"error":{"message":"image exceeds 10 MB maximum"}}'), false);
  assert.equal(isOptionalFieldRefusal(429, '{"error":{"message":"output_config"}}'), false, "only a 400 is a refusal of the request's shape");

  assert.equal(isEchoedSchema(JSON.stringify(signSchema), { schema: signSchema, type: "json_schema" }), true);
  assert.equal(isEchoedSchema('{"format":"a","pattern":"b","signs":[],"score":1}', { schema: signSchema, type: "json_schema" }), false);
  assert.equal(isEchoedSchema(JSON.stringify(signSchema), { type: "json_object" }), false);

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
  resetAnthropicPlainOnlyMemory();
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
  assert.deepEqual(Object.keys(request.body).sort(), ["max_tokens", "messages", "model", "output_config", "system"]);
  assert.deepEqual(request.body.output_config, { format: { schema: { type: "object" }, type: "json_schema" } }, "the schema goes to Claude's JSON outputs");

  // 🔴 A 400 that names an optional field is answered by ONE resend in the plain shape, and the pair is
  //    remembered so the next call does not pay for the refusal again.
  const sentBodies: Record<string, unknown>[] = [];
  const refusingFetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sentBodies.push(body);
    return body.output_config
      ? jsonResponse({ error: { message: "output_config.format.schema: this schema is not supported", type: "invalid_request_error" } }, 400)
      : jsonResponse({ content: [{ text: '{"subject":"Hi"}', type: "text" }] });
  }) as typeof fetch;
  const refusedCall = {
    apiKey: TEST_KEY,
    fetchImpl: refusingFetch,
    format: { name: "refused_schema", schema: { properties: { subject: { type: "string" } }, type: "object" }, type: "json_schema" },
    input: "hello",
    instructions: "Be brief.",
    maxOutputTokens: 100,
    maxRetries: 0,
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
    timeoutMs: 5_000,
  };
  const resent = await callAnthropicMessages(refusedCall);
  assert.equal(resent.outputText, '{"subject":"Hi"}', "the plain resend answers the call");
  assert.equal(sentBodies.length, 2);
  assert.deepEqual(sentBodies[0].output_config, { effort: "medium", format: { schema: { properties: { subject: { type: "string" } }, type: "object" }, type: "json_schema" } });
  assert.equal(sentBodies[1].output_config, undefined, "the resend carries no optional field");
  assert.match(String(sentBodies[1].system), /ONLY one JSON object/, "and asks for the JSON in the prompt");
  await callAnthropicMessages(refusedCall);
  assert.equal(sentBodies.length, 3, "the remembered pair is sent plain straight away");
  assert.equal(sentBodies[2].output_config, undefined);

  // A request refused in BOTH shapes is broken for another reason: it is not remembered.
  resetAnthropicPlainOnlyMemory();
  let refusedBoth = 0;
  await expectRequestError(
    () =>
      callAnthropicMessages({
        ...refusedCall,
        fetchImpl: (async () => {
          refusedBoth += 1;
          return jsonResponse({ error: { message: "output_config: invalid request" } }, 400);
        }) as typeof fetch,
      }),
    "failed",
  );
  assert.equal(refusedBoth, 2, "one plain resend, never a loop");
  assert.ok(buildAnthropicRequest(refusedCall, "claude-sonnet-5-5").output_config, "nothing was switched off for the process");
  resetAnthropicPlainOnlyMemory();

  // 🔴 The CV reader's refusal names no field: it must still be resent plain, or every CV read fails.
  const cvBodies: Record<string, unknown>[] = [];
  const cvRead = await callAnthropicMessages({
    ...refusedCall,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      cvBodies.push(body);
      return body.output_config
        ? new Response(CV_SCHEMA_REFUSAL, { headers: { "content-type": "application/json" }, status: 400 })
        : jsonResponse({ content: [{ text: '{"subject":"CV"}', type: "text" }] });
    }) as typeof fetch,
    format: { name: "cv_extraction", schema: { properties: { subject: { type: ["string", "null"] } }, type: "object" }, type: "json_schema" },
  });
  assert.equal(cvRead.outputText, '{"subject":"CV"}', "a schema refused for its union types still gets its answer");
  assert.equal(cvBodies.length, 2, "through one plain resend");
  assert.equal(cvBodies[1].output_config, undefined);
  resetAnthropicPlainOnlyMemory();

  // 🔴 Three answers that used to come back as an ordinary reply and were read as "the model found nothing".
  const answering = (reply: Record<string, unknown>, format: unknown) => () =>
    callAnthropicMessages({
      apiKey: TEST_KEY,
      fetchImpl: (async () => jsonResponse(reply)) as typeof fetch,
      format,
      input: "hello",
      instructions: "i",
      maxOutputTokens: 5,
      maxRetries: 0,
      model: "claude-haiku-5-5",
      timeoutMs: 5_000,
    });
  const echoFormat = { schema: { properties: { signs: { type: "array" } }, required: ["signs"], type: "object" }, type: "json_schema" };
  await expectRequestError(answering({ content: [], stop_reason: "refusal" }, undefined), "failed");
  await expectRequestError(answering({ content: [{ text: '{"signs":[{"te', type: "text" }], stop_reason: "max_tokens" }, echoFormat), "failed");
  await expectRequestError(answering({ content: [{ text: JSON.stringify(echoFormat.schema), type: "text" }], stop_reason: "end_turn" }, echoFormat), "failed");
  const cutPlain = await answering({ content: [{ text: "A short rep", type: "text" }], stop_reason: "max_tokens" }, undefined)();
  assert.equal(cutPlain.outputText, "A short rep", "a plain-text answer cut at max_tokens is still an answer");

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
  assert.match(entry, /runAnthropicResponse\(legParams, requestedModel\)/);
  assert.match(entry, /runOpenAiResponse\(legParams, requestedModel\)/);
  assert.match(
    entry,
    /failoverLegTimeoutMs\(budgetMs, Date\.now\(\) - startedAt\)[\s\S]*legParams = \{ \.\.\.params, timeoutMs: leftMs \}/,
    "the second provider is given what is left of the caller's budget, never a fresh one",
  );
  assert.match(entry, /if \(provider === "openai"\) noteOpenAiAvailable\(\);/, "an OpenAI answer ends the back-off");
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
  assert.match(anthropicRun, /reasoningEffort: params\.reasoning\?\.effort \?\? "low"/, "Claude is sent the effort OpenAI is sent");

  const salesProvider = readFileSync("src/lib/sales/ai/provider.ts", "utf8");
  assert.match(
    salesProvider,
    /if \(leg\.kind === "chat" && leg\.provider\.name === "openai"\) noteOpenAiAvailable\(\);/,
    "a sales call that OpenAI answers ends the back-off too",
  );

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
