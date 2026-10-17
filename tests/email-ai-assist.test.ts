import assert from "node:assert/strict";

import { AiAssistError, draftEmailWithAi, type AiDraftRequest } from "@/lib/email/ai-assist.ts";

type CapturedOpenAiCall = {
  body: Record<string, unknown>;
  url: string;
};

const baseInput: AiDraftRequest = {
  current: {
    bodyHtml: "<p>Existing body</p>",
    closingText: "Regards,",
    greeting: "Dear {{employeeName}},",
    previewText: "Existing preview",
    subject: "Existing subject",
  },
  instruction: "Write a formal probation reminder email.",
  mode: "email_template",
  templateName: "Probation Reminder",
  variables: [
    { label: "Employee Name", sampleValue: "Mona Ali", token: "employeeName" },
    { label: "Job Title", sampleValue: "Medical Rep", token: "jobTitle" },
  ],
};

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function installEnv() {
  const saved = {
    emailModel: process.env.OPENAI_EMAIL_MODEL,
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  };
  process.env.OPENAI_API_KEY = "sk-test-key-for-unit-tests";
  delete process.env.OPENAI_EMAIL_MODEL;
  delete process.env.OPENAI_MODEL;
  return () => {
    restoreEnv("OPENAI_API_KEY", saved.key);
    restoreEnv("OPENAI_EMAIL_MODEL", saved.emailModel);
    restoreEnv("OPENAI_MODEL", saved.model);
  };
}

function responsePayload(outputText: string) {
  return {
    created_at: Math.floor(Date.now() / 1000),
    id: "resp_test",
    model: "gpt-5.4-nano",
    object: "response",
    output: [
      {
        content: [{ annotations: [], text: outputText, type: "output_text" }],
        id: "msg_test",
        role: "assistant",
        status: "completed",
        type: "message",
      },
    ],
    output_text: outputText,
    status: "completed",
  };
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit) {
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return String(raw ?? "");
}

function installFetchResponse(status: number, payload: unknown) {
  const savedFetch = globalThis.fetch;
  const calls: CapturedOpenAiCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await requestBody(input, init);
    calls.push({
      body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    });
    return new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_unit_test",
        "x-should-retry": "false",
      },
      status,
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = savedFetch;
    },
  };
}

function installFetchThrow(error: Error) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = savedFetch;
  };
}

function muteConsoleError() {
  const saved = console.error;
  console.error = () => {};
  return () => {
    console.error = saved;
  };
}

async function expectAiError(action: () => Promise<unknown>, code: AiAssistError["code"], message: RegExp) {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.ok(error instanceof AiAssistError);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      return true;
    },
  );
}

export async function runEmailAiAssistTests() {
  {
    const savedKey = process.env.OPENAI_API_KEY;
    // Anthropic is a second provider since 2026-10-18, so "no AI configured" now means NEITHER key — a
    // developer's .env.local holding ANTHROPIC_API_KEY must not turn this into a live call.
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_not_configured", /not configured/i);
    } finally {
      restoreEnv("OPENAI_API_KEY", savedKey);
      restoreEnv("ANTHROPIC_API_KEY", savedAnthropicKey);
    }
  }

  {
    const restoreEnvValues = installEnv();
    const draft = {
      bodyHtml:
        '<p onclick="alert(1)">Hello {{employeeName}} {{unknownToken}}</p><script>alert(1)</script><img src="http://bad.example/x.png">',
      closingText: "Best regards, {{unknownToken}}",
      greeting: "Dear {{employeeName}},",
      previewText: "Probation reminder for {{employeeName}}",
      subject: "Probation update for {{employeeName}} {{unknownToken}}",
    };
    const fetchMock = installFetchResponse(200, responsePayload(JSON.stringify(draft)));
    try {
      const result = await draftEmailWithAi(baseInput);
      assert.deepEqual(Object.keys(result.draft).sort(), [
        "bodyHtml",
        "closingText",
        "greeting",
        "previewText",
        "subject",
      ]);
      assert.equal(result.draft.greeting, "Dear {{employeeName}},");
      assert.match(result.draft.bodyHtml, /Hello \{\{employeeName\}\}/);
      assert.doesNotMatch(result.draft.bodyHtml, /script|onclick|unknownToken|http:\/\/bad/i);
      assert.doesNotMatch(result.draft.subject, /unknownToken/);
      assert.ok(
        result.warnings.some((warning) => warning.includes("Removed unknown variable {{unknownToken}}")),
        "unknown placeholders should be stripped with a warning",
      );

      const call = fetchMock.calls[0];
      assert.ok(call, "OpenAI should be called once");
      assert.match(call.url, /\/responses$/);
      assert.equal(call.body.model, "gpt-5.4");
      assert.equal(call.body.max_output_tokens, 8_000);
      assert.deepEqual(call.body.reasoning, { effort: "medium" });
      assert.equal((call.body.text as { format?: { strict?: boolean; type?: string } }).format?.type, "json_schema");
      assert.equal((call.body.text as { format?: { strict?: boolean } }).format?.strict, true);
      assert.match(String(call.body.instructions), /STRICT RULES/);
      assert.doesNotMatch(String(call.body.instructions), /Current draft as JSON/);
      assert.match(String(call.body.input), /Current draft as JSON/);
      assert.match(String(call.body.input), /\{\{employeeName\}\}/);
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchResponse(
      200,
      responsePayload(JSON.stringify({ bodyHtml: "<p>Updated body</p>", subject: "Updated subject" })),
    );
    try {
      const result = await draftEmailWithAi(baseInput);
      assert.equal(result.draft.subject, "Updated subject");
      assert.equal(result.draft.previewText, baseInput.current.previewText, "omitted fields should keep current values");
      assert.equal(result.draft.closingText, baseInput.current.closingText);
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  for (const [status, expectedMessage] of [
    [401, /rejected the API key/i],
    [403, /rejected the API key/i],
    [500, /returned 500/i],
  ] as const) {
    const restoreEnvValues = installEnv();
    const restoreConsole = muteConsoleError();
    const fetchMock = installFetchResponse(status, {
      error: { code: "server_error", message: `status ${status} failed for sk-leakysecret123456` },
    });
    try {
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_failed", expectedMessage);
    } finally {
      fetchMock.restore();
      restoreConsole();
      restoreEnvValues();
    }
  }

  {
    const restoreEnvValues = installEnv();
    const restoreConsole = muteConsoleError();
    const fetchMock = installFetchResponse(429, {
      error: { code: "insufficient_quota", message: "quota exceeded" },
    });
    try {
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_rate_limited", /out of credit/i);
    } finally {
      fetchMock.restore();
      restoreConsole();
      restoreEnvValues();
    }
  }

  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchResponse(200, responsePayload("not json"));
    try {
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_failed", /expected format/i);
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  {
    const restoreEnvValues = installEnv();
    const fetchMock = installFetchResponse(
      200,
      responsePayload(
        JSON.stringify({ bodyHtml: "", closingText: "", greeting: "", previewText: "", subject: "" }),
      ),
    );
    try {
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_failed", /did not contain any email fields/i);
    } finally {
      fetchMock.restore();
      restoreEnvValues();
    }
  }

  {
    const restoreEnvValues = installEnv();
    const restoreConsole = muteConsoleError();
    const restoreFetch = installFetchThrow(new Error("network unavailable"));
    try {
      await expectAiError(() => draftEmailWithAi(baseInput), "ai_failed", /Could not reach the AI service/i);
    } finally {
      restoreFetch();
      restoreConsole();
      restoreEnvValues();
    }
  }
}
