import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ANTHROPIC_FAST_MODEL, ANTHROPIC_MESSAGES_URL, ANTHROPIC_STRONG_MODEL } from "@/lib/ai/anthropic-fallback.ts";
import {
  isOpenAiUnavailable,
  noteOpenAiUnavailable,
  OPENAI_UNAVAILABLE_WINDOW_MS,
  resetOpenAiAvailability,
} from "@/lib/ai/openai-client.ts";
import {
  aiChatJson,
  DEFAULT_AI_MODELS,
  firstSalesAiModel,
  hasAiProvider,
  planSalesAi,
  runWithSalesAiFailover,
  SalesAiError,
  salesAiFailureCodeFor,
} from "@/lib/sales/ai/provider.ts";
import { explainHeaderMismatch } from "../src/lib/sales/normalizer/ai-explain.ts";
import { aiSuggest, aiSuggestModel, hasAiKey, type AiCandidate, type AiUnknown } from "../src/lib/sales/normalizer/ai-suggest.ts";
import { hasWeeklyVerifyAi, judgeWithAi } from "../src/lib/sales/weekly/ai-verify.ts";
import { stripComments } from "./support/comment-strip.ts";

// The OpenAI account failed to recharge (2026-10-18) and the shared AI call fell over to Anthropic, but the
// three sales AI paths make their own raw calls and stayed dark. They now plan their providers in
// src/lib/sales/ai/provider.ts. Nothing here reaches the network: the suite runs with production
// credentials, so every scenario clears the provider variables first and routes fetch through a mock that
// refuses any address it was not told about.

const OPENAI_KEY = "sk-test-openai-key-0000000000";
const CLAUDE_KEY = "sk-ant-test-key-for-unit-tests-0001";

const ENV_KEYS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_PROVIDER",
  "AI_SUGGEST_RETRY_BASE_MS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_FAST_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_STRONG_MODEL",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENROUTER_API_KEY",
] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetOpenAiAvailability();
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetOpenAiAvailability();
  };
}

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status });
}

const openAiQuota = () => json(429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
const openAiRateLimited = () => json(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } });
const openAiRejected = () => json(401, { error: { message: "Incorrect API key provided" } });
const openAiBroken = () => json(500, { error: { message: "The server had an error" } });
const openAiOk = (content: string) => json(200, { choices: [{ message: { content } }], usage: { completion_tokens: 4, prompt_tokens: 3 } });
const claudeOk = (text: string) =>
  json(200, { content: [{ text, type: "text" }], model: "claude-answered", usage: { input_tokens: 5, output_tokens: 6 } });
const claudeRejected = () => json(401, { error: { message: "invalid x-api-key", type: "authentication_error" } });
const claudeOutOfCredit = () =>
  json(400, { error: { message: "Your credit balance is too low to access the Anthropic API.", type: "invalid_request_error" } });

type Seen = { body: Record<string, unknown>; headers: Record<string, string>; url: string };

function installFetch(routes: { anthropic?: () => Response; openai?: () => Response }) {
  const saved = globalThis.fetch;
  const calls = { anthropic: 0, openai: 0 };
  const anthropicSeen: Seen[] = [];
  const openAiSeen: Seen[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const seen = { body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers: (init?.headers ?? {}) as Record<string, string>, url };
    if (url === ANTHROPIC_MESSAGES_URL) {
      calls.anthropic += 1;
      anthropicSeen.push(seen);
      assert.ok(routes.anthropic, "this scenario must not reach Anthropic");
      return routes.anthropic();
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      calls.openai += 1;
      openAiSeen.push(seen);
      assert.ok(routes.openai, "this scenario must not reach OpenAI");
      return routes.openai();
    }
    throw new Error(`unexpected network call to ${url}`);
  }) as typeof fetch;
  return { anthropicSeen, calls, openAiSeen, restore: () => { globalThis.fetch = saved; } };
}

const candidates: AiCandidate[] = [{ code: "LA001", label: "Lacto Advanced 1" }];
const unknowns: AiUnknown[] = [{ raw: "Lacto Adv 1" }];
const matchJson = JSON.stringify({ matches: [{ code: "LA001", id: 1 }] });
const expectedMatch = [{ code: "LA001", confidence: undefined, raw: "Lacto Adv 1" }];

function planningTests() {
  const openAi = { OPENAI_API_KEY: OPENAI_KEY };
  const claude = { ANTHROPIC_API_KEY: CLAUDE_KEY };
  const both = { ...openAi, ...claude };
  const suggestModels = { generic: "gpt-4o", groq: "llama-3.3-70b-versatile", openai: "gpt-4o", openrouter: "openai/gpt-4o" };
  const shape = (plan: ReturnType<typeof planSalesAi>) => plan.map((leg) => leg.kind);

  const today = planSalesAi(DEFAULT_AI_MODELS, openAi, 0);
  assert.deepEqual(shape(today), ["chat"], "today's environment, OpenAI alone, is unchanged");
  assert.equal(today[0].kind === "chat" && today[0].provider.name, "openai");
  assert.equal(today[0].kind === "chat" && today[0].provider.model, "gpt-4o-mini");
  assert.deepEqual(planSalesAi(DEFAULT_AI_MODELS, {}, 0), [], "no key at all plans nothing, so the callers degrade to a no-op");

  assert.deepEqual(planSalesAi(DEFAULT_AI_MODELS, claude, 0), [{ kind: "anthropic", model: ANTHROPIC_FAST_MODEL }]);
  assert.deepEqual(
    planSalesAi(suggestModels, claude, 0),
    [{ kind: "anthropic", model: ANTHROPIC_STRONG_MODEL }],
    "ai-suggest's gpt-4o tier is Claude's strong model",
  );

  assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, both, 0)), ["chat", "anthropic"], "OpenAI first, Claude as the second resort");
  const overridden = planSalesAi(DEFAULT_AI_MODELS, { ...both, AI_MODEL: "gpt-5.4-nano" }, 0);
  assert.equal(overridden[0].kind === "chat" && overridden[0].provider.model, "gpt-5.4-nano", "AI_MODEL still overrides the OpenAI side");
  assert.deepEqual(overridden[1], { kind: "anthropic", model: ANTHROPIC_FAST_MODEL }, "and is not Claude's model");
  assert.deepEqual(
    planSalesAi(DEFAULT_AI_MODELS, { ...claude, ANTHROPIC_MODEL: "claude-x" }, 0),
    [{ kind: "anthropic", model: "claude-x" }],
    "ANTHROPIC_MODEL forces one Claude model",
  );

  assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, { ...both, AI_PROVIDER: "openai" }, 0)), ["chat"]);
  assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, { ...both, AI_PROVIDER: "anthropic" }, 0)), ["anthropic"]);
  assert.deepEqual(planSalesAi(DEFAULT_AI_MODELS, { ...openAi, AI_PROVIDER: "anthropic" }, 0), [], "a pinned provider needs ITS key");
  assert.deepEqual(planSalesAi(DEFAULT_AI_MODELS, { ...claude, AI_PROVIDER: "openai" }, 0), []);

  noteOpenAiUnavailable(10_000);
  try {
    assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, both, 10_001)), ["anthropic", "chat"], "inside the window a call goes straight to Claude");
    assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, both, 10_000 + OPENAI_UNAVAILABLE_WINDOW_MS)), ["chat", "anthropic"], "the window closes by itself");
    assert.deepEqual(
      shape(planSalesAi(DEFAULT_AI_MODELS, { GROQ_API_KEY: "gsk-test-groq-key-0000000000", ...claude }, 10_001)),
      ["chat", "anthropic"],
      "the memory is about the OpenAI ACCOUNT, so it never reorders another OpenAI-compatible provider",
    );
  } finally {
    resetOpenAiAvailability();
  }
  assert.deepEqual(shape(planSalesAi(DEFAULT_AI_MODELS, both, 10_001)), ["chat", "anthropic"], "a reset forgets it");

  assert.equal(salesAiFailureCodeFor(401, "{}"), "auth_failed");
  assert.equal(salesAiFailureCodeFor(403, "{}"), "auth_failed");
  assert.equal(salesAiFailureCodeFor(402, "{}"), "quota_exceeded", "OpenRouter says out of credit with a 402");
  assert.equal(salesAiFailureCodeFor(429, JSON.stringify({ error: { code: "insufficient_quota" } })), "quota_exceeded");
  assert.equal(salesAiFailureCodeFor(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } })), "rate_limited");
  assert.equal(salesAiFailureCodeFor(500, "{}"), "failed");
  assert.equal(salesAiFailureCodeFor(400, "{}"), "failed");
}

function gateTests() {
  let restore = withEnv({ ANTHROPIC_API_KEY: CLAUDE_KEY });
  try {
    assert.equal(hasAiProvider(), true, "an Anthropic key alone keeps the sales AI switched on");
    assert.equal(hasAiKey(), true, "the normalizer's button and routes");
    assert.equal(hasWeeklyVerifyAi(), true, "the weekly verify screen's AI label");
    assert.equal(aiSuggestModel(), ANTHROPIC_STRONG_MODEL);
    assert.equal(firstSalesAiModel(), ANTHROPIC_FAST_MODEL);
  } finally {
    restore();
  }

  restore = withEnv({});
  try {
    assert.equal(hasAiProvider(), false);
    assert.equal(hasAiKey(), false);
    assert.equal(hasWeeklyVerifyAi(), false);
    assert.equal(aiSuggestModel(), null);
  } finally {
    restore();
  }

  restore = withEnv({ OPENAI_API_KEY: OPENAI_KEY });
  try {
    assert.equal(aiSuggestModel(), "gpt-4o", "OpenAI alone is exactly today's answer");
    noteOpenAiUnavailable();
    assert.equal(aiSuggestModel(), "gpt-4o", "the memory means nothing without a Claude key to go to");
  } finally {
    restore();
  }
}

async function suggestTests() {
  const both = { ANTHROPIC_API_KEY: CLAUDE_KEY, OPENAI_API_KEY: OPENAI_KEY };

  // OpenAI out of credit: Claude answers, once, and the next call skips OpenAI altogether.
  let restoreEnv = withEnv(both);
  let net = installFetch({ anthropic: () => claudeOk(matchJson), openai: openAiQuota });
  try {
    assert.deepEqual(await aiSuggest("product", unknowns, candidates), expectedMatch);
    assert.deepEqual(net.calls, { anthropic: 1, openai: 1 }, "one failed OpenAI attempt, never retried, then Claude");
    const sent = net.anthropicSeen[0];
    assert.equal(sent.headers["x-api-key"], CLAUDE_KEY);
    assert.equal(sent.body.model, ANTHROPIC_STRONG_MODEL, "ai-suggest's name matching asks Claude's strong model");
    assert.match(String(sent.body.system), /You match a pharmaceutical distributor's raw product names/, "the same system prompt");
    assert.match(String(sent.body.system), /ONLY one valid JSON object/, "JSON is asked for in the system prompt");
    assert.match(JSON.stringify(sent.body.messages), /Official list \(code \| name\)/, "the same user prompt");
    assert.ok(Object.keys(sent.body).every((key) => ["max_tokens", "messages", "model", "system"].includes(key)), "no optional field is sent");
    assert.equal(isOpenAiUnavailable(), true, "the failure is remembered");
    assert.equal(aiSuggestModel(), ANTHROPIC_STRONG_MODEL, "so cached answers are filed under the model that answers");

    assert.deepEqual(await aiSuggest("product", unknowns, candidates), expectedMatch);
    assert.deepEqual(net.calls, { anthropic: 2, openai: 1 }, "the second call goes straight to Claude");
  } finally {
    net.restore();
    restoreEnv();
  }

  // A rejected key fails over the same way, and a fenced reply is cleaned before it is parsed.
  restoreEnv = withEnv(both);
  net = installFetch({ anthropic: () => claudeOk(`\`\`\`json\n${matchJson}\n\`\`\``), openai: openAiRejected });
  try {
    assert.deepEqual(await aiSuggest("product", unknowns, candidates), expectedMatch);
    assert.deepEqual(net.calls, { anthropic: 1, openai: 1 });
  } finally {
    net.restore();
    restoreEnv();
  }

  // Claude is the only provider configured.
  restoreEnv = withEnv({ ANTHROPIC_API_KEY: CLAUDE_KEY });
  net = installFetch({ anthropic: () => claudeOk(matchJson) });
  try {
    assert.deepEqual(await aiSuggest("territory", unknowns, candidates), expectedMatch);
    assert.deepEqual(net.calls, { anthropic: 1, openai: 0 });
  } finally {
    net.restore();
    restoreEnv();
  }

  // A busy OpenAI stays with OpenAI: after its retries it surfaces the rate-limit message, with no Claude call
  // and nothing remembered, because waiting helps and a second provider is not needed.
  restoreEnv = withEnv({ ...both, AI_SUGGEST_RETRY_BASE_MS: "5" });
  net = installFetch({ openai: openAiRateLimited });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /AI is rate-limited right now/);
    assert.deepEqual(net.calls, { anthropic: 0, openai: 4 }, "three retries, then give up on OpenAI alone");
    assert.equal(isOpenAiUnavailable(), false);
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv(both);
  net = installFetch({ openai: openAiBroken });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /AI request failed \(HTTP 500\)/);
    assert.deepEqual(net.calls, { anthropic: 0, openai: 1 }, "an ordinary server error is not a dead account");
  } finally {
    net.restore();
    restoreEnv();
  }

  // Both accounts dead: the user is told what to fix, in the same words whichever provider answered last.
  restoreEnv = withEnv(both);
  net = installFetch({ anthropic: claudeRejected, openai: openAiQuota });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /AI key was rejected \(401\)/);
    assert.deepEqual(net.calls, { anthropic: 1, openai: 1 });
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv(both);
  net = installFetch({ anthropic: claudeOutOfCredit, openai: openAiQuota });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /out of credit \/ quota.*billing problem.*waiting will NOT help/);
  } finally {
    net.restore();
    restoreEnv();
  }

  // Unchanged: no Claude key means the out-of-credit message, one call, and nothing remembered.
  restoreEnv = withEnv({ OPENAI_API_KEY: OPENAI_KEY });
  net = installFetch({ openai: openAiQuota });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /out of credit \/ quota/);
    assert.deepEqual(net.calls, { anthropic: 0, openai: 1 });
    assert.equal(isOpenAiUnavailable(), false, "nothing is remembered when there is nowhere else to go");
  } finally {
    net.restore();
    restoreEnv();
  }

  // Pinned to OpenAI: the operator asked for it, so there is no failover.
  restoreEnv = withEnv({ ...both, AI_PROVIDER: "openai" });
  net = installFetch({ openai: openAiQuota });
  try {
    await assert.rejects(() => aiSuggest("product", unknowns, candidates), /out of credit \/ quota/);
    assert.deepEqual(net.calls, { anthropic: 0, openai: 1 });
  } finally {
    net.restore();
    restoreEnv();
  }

  // Nothing configured: a quiet empty answer and no request at all.
  restoreEnv = withEnv({});
  net = installFetch({});
  try {
    assert.deepEqual(await aiSuggest("product", unknowns, candidates), []);
    assert.deepEqual(net.calls, { anthropic: 0, openai: 0 });
  } finally {
    net.restore();
    restoreEnv();
  }
}

async function verifyTests() {
  const both = { ANTHROPIC_API_KEY: CLAUDE_KEY, OPENAI_API_KEY: OPENAI_KEY };
  const items = [{ columnIndex: 3, expectedHeaderHint: "Qty", id: 0, label: "Quantity", observedHeader: "الكمية", sheetRole: "sales" }];
  const verdict = JSON.stringify({ items: [{ id: 0, note: "same word", status: "match" }], summary: "The file lines up." });

  let restoreEnv = withEnv(both);
  let net = installFetch({ anthropic: () => claudeOk(verdict), openai: openAiQuota });
  try {
    const result = await judgeWithAi("Ibn Sina", items);
    assert.deepEqual(result.judgements, [{ id: 0, note: "same word", status: "match" }]);
    assert.equal(result.summary, "The file lines up.");
    assert.deepEqual(net.calls, { anthropic: 1, openai: 1 });
    assert.equal(net.anthropicSeen[0].body.model, ANTHROPIC_FAST_MODEL, "the weekly check is a small job, so the fast model");
    assert.equal(net.anthropicSeen[0].body.max_tokens, 2000);
    assert.match(JSON.stringify(net.anthropicSeen[0].body.messages), /الكمية/, "only the header text travels, as before");
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv(both);
  net = installFetch({ openai: () => openAiOk(verdict) });
  try {
    assert.equal((await judgeWithAi("Ibn Sina", items)).summary, "The file lines up.");
    assert.deepEqual(net.calls, { anthropic: 0, openai: 1 }, "a healthy OpenAI never touches Claude");
  } finally {
    net.restore();
    restoreEnv();
  }

  // When both fail it still throws, which verifyWeeklyUpload catches and turns into aiUsed=false.
  restoreEnv = withEnv(both);
  net = installFetch({ anthropic: claudeRejected, openai: openAiQuota });
  try {
    await assert.rejects(() => judgeWithAi("Ibn Sina", items), (error: unknown) => error instanceof SalesAiError && error.code === "auth_failed");
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv({});
  net = installFetch({});
  try {
    await assert.rejects(() => judgeWithAi("Ibn Sina", items), (error: unknown) => error instanceof SalesAiError && error.code === "not_configured");
    assert.deepEqual(net.calls, { anthropic: 0, openai: 0 });
  } finally {
    net.restore();
    restoreEnv();
  }
}

async function explainTests() {
  const input = { distributorName: "Ibn Sina", missingGroups: [{ expected: ["Quantity"], label: "Qty" }], observedHeaders: ["Quantity", "Item"] };
  const reply = JSON.stringify({ suggestions: [{ expected: "Qty", note: "same", suggestedHeader: "Quantity" }, { expected: "Qty", suggestedHeader: "Invented" }], summary: "Qty was renamed." });

  let restoreEnv = withEnv({ ANTHROPIC_API_KEY: CLAUDE_KEY, OPENAI_API_KEY: OPENAI_KEY });
  let net = installFetch({ anthropic: () => claudeOk(reply), openai: openAiRejected });
  try {
    const result = await explainHeaderMismatch(input);
    assert.equal(result.aiUsed, true);
    assert.equal(result.summary, "Qty was renamed.");
    assert.deepEqual(result.suggestions.map((s) => s.suggestedHeader), ["Quantity", null], "a header the file does not have is still refused");
    assert.deepEqual(net.calls, { anthropic: 1, openai: 1 });
    assert.equal(net.anthropicSeen[0].body.model, ANTHROPIC_FAST_MODEL);
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv({ ANTHROPIC_API_KEY: CLAUDE_KEY });
  net = installFetch({ anthropic: () => claudeOk('{"ok":true}') });
  try {
    assert.equal(await aiChatJson("Reply with JSON.", "Go."), '{"ok":true}');
  } finally {
    net.restore();
    restoreEnv();
  }

  restoreEnv = withEnv({});
  net = installFetch({});
  try {
    assert.equal((await explainHeaderMismatch(input)).aiUsed, false, "no provider, no call, the upload is never frozen");
    assert.deepEqual(net.calls, { anthropic: 0, openai: 0 });
  } finally {
    net.restore();
    restoreEnv();
  }
}

async function loopTests() {
  const restoreEnv = withEnv({ ANTHROPIC_API_KEY: CLAUDE_KEY, OPENAI_API_KEY: OPENAI_KEY });
  try {
    const visited: string[] = [];
    await assert.rejects(
      () => runWithSalesAiFailover(async (leg) => {
        visited.push(leg.kind);
        throw new SalesAiError("timeout", "slow");
      }),
      /slow/,
    );
    assert.deepEqual(visited, ["chat"], "a timeout stays with the provider that gave it");

    visited.length = 0;
    await assert.rejects(
      () => runWithSalesAiFailover(async (leg) => {
        visited.push(leg.kind);
        throw new TypeError("not an HTTP failure");
      }),
      /not an HTTP failure/,
    );
    assert.deepEqual(visited, ["chat"], "an error with no code is treated as an ordinary failure");

    visited.length = 0;
    const answer = await runWithSalesAiFailover(async (leg) => {
      visited.push(leg.kind);
      if (leg.kind === "chat") throw new SalesAiError("quota_exceeded", "empty");
      return "from claude";
    });
    assert.equal(answer, "from claude");
    assert.deepEqual(visited, ["chat", "anthropic"]);
    assert.equal(isOpenAiUnavailable(), true);
  } finally {
    restoreEnv();
  }
}

// A sales path that posts to /chat/completions on its own, or resolves an OpenAI-compatible provider
// itself, bypasses the failover without anything failing — it simply stays dark the next time OpenAI is out
// of credit. Every file under the sales code that talks to a chat endpoint must go through the loop.
function censusTests() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(`${root}src/lib/sales`);
  walk(`${root}app/api/sales`);
  assert.ok(files.length > 100, `the census must actually read the sales code (read ${files.length} files)`);

  const callers = files.filter((file) => stripComments(readFileSync(file, "utf8")).includes("/chat/completions"));
  assert.ok(callers.length >= 3, `the three known sales AI paths must be found (found ${callers.length})`);
  for (const file of callers) {
    assert.ok(
      stripComments(readFileSync(file, "utf8")).includes("runWithSalesAiFailover"),
      `${file.slice(root.length)} posts to a chat endpoint without runWithSalesAiFailover`,
    );
  }

  const resolvers = files.filter((file) => /\bresolveAiProvider\(/.test(stripComments(readFileSync(file, "utf8"))));
  assert.deepEqual(
    resolvers.map((file) => file.slice(root.length)),
    ["src/lib/sales/ai/provider.ts"],
    "only the planner resolves a provider; a path that does it itself skips the failover",
  );
}

export async function runSalesAiFailoverTests() {
  planningTests();
  gateTests();
  await suggestTests();
  await verifyTests();
  await explainTests();
  await loopTests();
  censusTests();
}
