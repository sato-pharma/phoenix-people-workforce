import assert from "node:assert/strict";

import {
  normalizeOpenAiError,
  OPENAI_EMAIL_DEFAULT_MODEL,
  OPENAI_EMAIL_TIMEOUT_MS,
  OPENAI_MAX_RETRIES,
  OPENAI_ROUTE_BUDGET_MS,
  resolveOpenAiEmailModel,
  sanitizeOpenAiLogMessage,
} from "@/lib/ai/openai-client.ts";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

export function runOpenAiClientTests() {
  const savedEmailModel = process.env.OPENAI_EMAIL_MODEL;
  const savedModel = process.env.OPENAI_MODEL;
  try {
    delete process.env.OPENAI_EMAIL_MODEL;
    delete process.env.OPENAI_MODEL;
    assert.equal(resolveOpenAiEmailModel(), OPENAI_EMAIL_DEFAULT_MODEL);

    process.env.OPENAI_MODEL = " gpt-5.4-mini ";
    assert.equal(resolveOpenAiEmailModel(), "gpt-5.4-mini");

    process.env.OPENAI_EMAIL_MODEL = " gpt-5.5 ";
    assert.equal(resolveOpenAiEmailModel(), "gpt-5.5");
  } finally {
    restoreEnv("OPENAI_EMAIL_MODEL", savedEmailModel);
    restoreEnv("OPENAI_MODEL", savedModel);
  }

  const unsafe = "OpenAI failed with Authorization: Bearer sk-testsecret1234567890 and key sk-anothersecret123";
  const sanitized = sanitizeOpenAiLogMessage(unsafe);
  assert.doesNotMatch(sanitized, /sk-testsecret|sk-anothersecret/, "API keys must be redacted from logs");
  assert.match(sanitized, /Bearer \*\*\*/, "authorization bearer values must be redacted");

  const savedConsoleError = console.error;
  const logged: string[] = [];
  try {
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    normalizeOpenAiError(new Error("network failed for Bearer sk-sensitivevalue123456"), "unit-test");
  } finally {
    console.error = savedConsoleError;
  }
  assert.equal(logged.length, 1, "normalization should log a server-side diagnostic once");
  assert.doesNotMatch(logged[0] ?? "", /sk-sensitivevalue/, "normalized diagnostics must not leak API keys");

  assert.ok(OPENAI_MAX_RETRIES >= 0 && OPENAI_MAX_RETRIES <= 1, "OpenAI retries must stay low for route latency");
  assert.ok(OPENAI_EMAIL_TIMEOUT_MS > 0 && OPENAI_EMAIL_TIMEOUT_MS <= 30_000, "OpenAI timeout must be bounded");
  assert.ok(
    OPENAI_EMAIL_TIMEOUT_MS * (OPENAI_MAX_RETRIES + 1) <= OPENAI_ROUTE_BUDGET_MS,
    "timeout plus one retry must fit inside the 60-second API route budget",
  );
}
