import assert from "node:assert/strict";

const { POST } = await import("../app/api/integrations/telegram/webhook/route.ts");

// ─────────────────────────────────────────────────────────────────────────────
// THE TELEGRAM WEBHOOK ALWAYS REQUIRES ITS SECRET (S01, F-COM-014).
//
// With no NOTIFICATION_WEBHOOK_SECRET the webhook refuses every update in every environment,
// development included — a local server reads the production database. With a secret, an update
// without the matching header is refused. Neither refusal reaches the database or Telegram.
//
// No network: `fetch` throws if anything tries to leave.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_NAMES = ["NODE_ENV", "NOTIFICATION_WEBHOOK_SECRET"] as const;

async function withEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>, run: (calls: string[]) => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  const savedFetch = globalThis.fetch;
  const calls: string[] = [];
  for (const name of ENV_NAMES) {
    if (values[name] === undefined) delete env[name];
    else env[name] = values[name];
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
  }
}

function update(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/integrations/telegram/webhook", {
    body: JSON.stringify({ message: { chat: { id: 1 }, text: "/start test-only-token" } }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

async function answer(response: Response) {
  const body = (await response.json()) as { error?: string };
  return { error: body.error, status: response.status };
}

export async function runTelegramWebhookSecretTests(): Promise<void> {
  for (const nodeEnv of ["development", "test", "production"]) {
    await withEnv({ NODE_ENV: nodeEnv, NOTIFICATION_WEBHOOK_SECRET: undefined }, async (calls) => {
      assert.deepEqual(
        await answer(await POST(update())),
        { error: "telegram_webhook_secret_missing", status: 500 },
        `🔴 with no secret an unsigned update is refused (NODE_ENV=${nodeEnv})`,
      );
      assert.equal(calls.length, 0, "a refused update reaches nothing");
    });
  }

  await withEnv({ NODE_ENV: "development", NOTIFICATION_WEBHOOK_SECRET: "test-only-webhook-secret" }, async (calls) => {
    assert.deepEqual(await answer(await POST(update())), { error: "telegram_webhook_forbidden", status: 403 }, "🔴 no header, no update");
    assert.deepEqual(
      await answer(await POST(update({ "x-telegram-bot-api-secret-token": "wrong" }))),
      { error: "telegram_webhook_forbidden", status: 403 },
      "🔴 a wrong header, no update",
    );
    assert.equal(calls.length, 0, "a refused update reaches nothing");
  });
}
