import assert from "node:assert/strict";

import { aiSuggest, type AiCandidate, type AiUnknown } from "../src/lib/sales/normalizer/ai-suggest.ts";

// Regression for audit finding M9: generate() (the low-level chat-completions call inside
// aiSuggest) previously made exactly one attempt per batch and gave up immediately on ANY 429,
// including a transient per-minute rate limit that clears on its own within a few seconds. The
// caller had to notice the failure and manually re-click "AI suggest". generate() now retries a
// transient (non-quota) 429 automatically with exponential backoff before giving up. This is a
// real behavioral test (mocked fetch, real setTimeout delays) rather than a source-text assertion,
// since aiSuggest/generate depend only on fetch + process.env and are directly testable.

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function installEnv() {
  const saved = {
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
    base: process.env.AI_BASE_URL,
    retryBaseMs: process.env.AI_SUGGEST_RETRY_BASE_MS,
  };
  process.env.OPENAI_API_KEY = "sk-test-key-for-unit-tests";
  // Collapse the exponential-backoff base from its 1s production default to a few ms so this test
  // doesn't burn real wall-clock time (a full 3-retry exhaustion would otherwise take 1s+2s+4s=7s).
  process.env.AI_SUGGEST_RETRY_BASE_MS = "5";
  delete process.env.OPENAI_MODEL;
  delete process.env.AI_BASE_URL;
  return () => {
    restoreEnv("OPENAI_API_KEY", saved.key);
    restoreEnv("OPENAI_MODEL", saved.model);
    restoreEnv("AI_BASE_URL", saved.base);
    restoreEnv("AI_SUGGEST_RETRY_BASE_MS", saved.retryBaseMs);
  };
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status });
}

// Queues a sequence of canned responses, one per fetch call; the last entry repeats if fetch is
// called more times than the queue has entries. Returns the call count and a restore function.
function installFetchQueue(responses: Response[]) {
  const savedFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    const response = responses[Math.min(callCount, responses.length - 1)];
    callCount += 1;
    return response;
  }) as typeof fetch;
  return {
    callCount: () => callCount,
    restore: () => {
      globalThis.fetch = savedFetch;
    },
  };
}

const candidates: AiCandidate[] = [{ code: "LA001", label: "Lacto Advanced 1" }];
const unknowns: AiUnknown[] = [{ raw: "Lacto Adv 1" }];
const successPayload = { choices: [{ message: { content: JSON.stringify({ matches: [{ id: 1, code: "LA001" }] }) } }] };
const rateLimitedBody = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Too many requests" } });
const quotaExhaustedBody = JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } });

export async function runSosAiSuggestRetryTests() {
  // Transient rate limit: fails twice, then succeeds. aiSuggest should retry automatically and
  // return the successful match, without the caller having to re-invoke anything.
  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchQueue([
      new Response(rateLimitedBody, { status: 429 }),
      new Response(rateLimitedBody, { status: 429 }),
      jsonResponse(200, successPayload),
    ]);
    try {
      const result = await aiSuggest("product", unknowns, candidates);
      assert.deepEqual(result, [{ code: "LA001", raw: "Lacto Adv 1", confidence: undefined }]);
      assert.equal(fetchMock.callCount(), 3, "two rate-limited attempts were retried before the third succeeded");
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  // Quota exhausted is NOT retried — retrying a billing problem never helps, so it should fail
  // immediately (a single fetch call) with the billing-specific message.
  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchQueue([new Response(quotaExhaustedBody, { status: 429 })]);
    try {
      await assert.rejects(
        () => aiSuggest("product", unknowns, candidates),
        /out of credit \/ quota.*billing problem.*waiting will NOT help/,
      );
      assert.equal(fetchMock.callCount(), 1, "a quota-exhausted 429 must never be retried");
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  // Sustained rate limiting (never recovers within the retry budget) still eventually surfaces
  // the rate-limit error, after retrying — not a silent empty result.
  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchQueue([new Response(rateLimitedBody, { status: 429 })]);
    try {
      await assert.rejects(
        () => aiSuggest("product", unknowns, candidates),
        /AI is rate-limited right now/,
      );
      assert.equal(fetchMock.callCount(), 4, "3 retries were attempted (4 total calls) before giving up");
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }
}
