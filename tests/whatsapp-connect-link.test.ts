import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WHATSAPP_CONNECT_LINK_TTL_SECONDS,
  issueWhatsAppConnectLink,
  readWhatsAppConnectLink,
} from "../src/lib/recruitment/inbound/whatsapp-connect-link.ts";

const { POST: exchangePost } = await import("../app/api/whatsapp/embedded-signup/exchange/route.ts");

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE-TIME WHATSAPP CONNECT LINK (S01, F-PLT-008; owner's choice, 13 Nov 2026).
//
//   1. A ticket is signed with PHOENIX_AUTH_SECRET in its own domain, names who made it, and lives
//      30 minutes; an altered, expired or foreign ticket reads as nothing, and with no secret nothing
//      mints or verifies.
//   2. The exchange route finishes a connection only for a live ticket, spends it BEFORE Meta is
//      called, and refuses a second use, a missing ticket and a store that cannot answer — none of
//      which reaches Meta.
//   3. Only a Super Admin can make one: the route asserts the recruitment update grant and the system
//      scope, the panel is shown on the same condition, and the registry names the route.
//
// No network: the database's rate-limit RPC and Meta's Graph API are a stubbed `fetch`.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "http://whatsapp-connect-link-test.invalid";
const TEST_SECRET = "test-only-whatsapp-connect-link-secret-0000000000";
const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PHOENIX_AUTH_SECRET", "WHATSAPP_APP_SECRET"] as const;

type Store = "working" | "down";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

async function withStubs(store: Store, run: (graphCalls: string[]) => Promise<void>) {
  const graphCalls: string[] = [];
  // A real counter per bucket, so "one use" is the database's answer, not the stub's.
  const buckets = new Map<string, number>();
  const savedFetch = globalThis.fetch;
  const env = process.env as Record<string, string | undefined>;
  const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  env.PHOENIX_AUTH_SECRET = TEST_SECRET;
  env.WHATSAPP_APP_SECRET = "test-only-not-an-app-secret";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === SUPABASE_URL && url.pathname.endsWith("/rpc/api_rate_limit_consume")) {
      if (store === "down") return json({ code: "XX000", details: null, hint: null, message: "connection reset by peer" }, 500);
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_bucket_key: string; p_limit: number };
      const used = (buckets.get(body.p_bucket_key) ?? 0) + 1;
      buckets.set(body.p_bucket_key, used);
      return json([{ allowed: used <= body.p_limit, retry_after_seconds: used <= body.p_limit ? null : 60 }]);
    }
    if (url.origin === "https://graph.facebook.com") {
      graphCalls.push(url.pathname);
      if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: "test-only-business-token" });
      return json({ success: true });
    }
    throw new Error(`unexpected fetch ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  try {
    await run(graphCalls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete env[name];
      else env[name] = savedEnv[name];
    }
  }
}

let addressCounter = 0;
function exchangeRequest(body: Record<string, unknown>): Request {
  addressCounter += 1;
  return new Request("https://phoenix-hr.satopharma.com/api/whatsapp/embedded-signup/exchange", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${addressCounter}` },
    method: "POST",
  });
}

async function answer(response: Response): Promise<{ status: number; error: string | undefined }> {
  const body = (await response.json()) as { error?: string };
  return { error: body.error, status: response.status };
}

export async function runWhatsAppConnectLinkTests(): Promise<void> {
  // ── 1. The ticket ──────────────────────────────────────────────────────────────────────────
  await withStubs("working", async () => {
    const now = 1_800_000_000;
    const issued = issueWhatsAppConnectLink("B-10", now);
    assert.ok(issued, "with a secret, a ticket is made");
    assert.equal(issued.expiresAt, now + WHATSAPP_CONNECT_LINK_TTL_SECONDS);
    assert.equal(WHATSAPP_CONNECT_LINK_TTL_SECONDS, 30 * 60, "a link lives 30 minutes, as the owner was told");
    const link = readWhatsAppConnectLink(issued.ticket, now + 60);
    assert.ok(link, "a live ticket reads");
    assert.equal(link.madeBy, "B-10");
    assert.ok(link.nonce.length >= 16);
    assert.notEqual(issueWhatsAppConnectLink("B-10", now)?.ticket, issued.ticket, "every ticket is new");

    assert.equal(readWhatsAppConnectLink(issued.ticket, issued.expiresAt + 1), null, "🔴 an expired ticket reads as nothing");
    const [encoded, signature] = issued.ticket.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, n: "x".repeat(22), by: "B-10", exp: now + 999_999 }), "utf8").toString("base64url");
    assert.equal(readWhatsAppConnectLink(`${forgedPayload}.${signature}`, now), null, "🔴 a payload signed for another ticket reads as nothing");
    assert.equal(readWhatsAppConnectLink(`${encoded}.${"A".repeat(signature!.length)}`, now), null, "🔴 a forged signature reads as nothing");
    for (const junk of [undefined, null, "", "abc", `${issued.ticket}.extra`, 42, "a".repeat(600)]) {
      assert.equal(readWhatsAppConnectLink(junk, now), null, `${String(junk).slice(0, 20)} is not a ticket`);
    }

    // Domain-separated: the same secret signing another label must not make a connect ticket.
    const { createHmac } = await import("node:crypto");
    const foreign = `${encoded}.${createHmac("sha256", TEST_SECRET).update(`error-screenshot.v1\n${encoded}`).digest("base64url")}`;
    assert.equal(readWhatsAppConnectLink(foreign, now), null, "🔴 another signer's ticket is not a connect link");

    delete process.env.PHOENIX_AUTH_SECRET;
    assert.equal(issueWhatsAppConnectLink("B-10", now), null, "with no secret nothing mints");
    assert.equal(readWhatsAppConnectLink(issued.ticket, now), null, "with no secret nothing verifies");
  });

  // ── 2. The exchange route ──────────────────────────────────────────────────────────────────
  await withStubs("working", async (graphCalls) => {
    const issued = issueWhatsAppConnectLink("B-10");
    assert.ok(issued);

    assert.deepEqual(await answer(await exchangePost(exchangeRequest({ code: "meta-code" }))), { error: "link_invalid", status: 403 }, "🔴 no link, no connection");
    assert.deepEqual(await answer(await exchangePost(exchangeRequest({ code: "meta-code", link: "forged.ticket" }))), { error: "link_invalid", status: 403 });
    assert.equal(graphCalls.length, 0, "🔴 a missing or forged link never reaches Meta");

    assert.deepEqual(await answer(await exchangePost(exchangeRequest({ code: "meta-code", link: issued.ticket, wabaId: "123" }))), { error: undefined, status: 200 }, "a live link connects");
    assert.equal(graphCalls.length, 2, "the code was exchanged and the account subscribed");

    assert.deepEqual(
      await answer(await exchangePost(exchangeRequest({ code: "another-code", link: issued.ticket, wabaId: "456" }))),
      { error: "link_used", status: 403 },
      "🔴 a link connects once — a second use is refused",
    );
    assert.equal(graphCalls.length, 2, "🔴 the second use never reaches Meta");
  });

  await withStubs("down", async (graphCalls) => {
    const issued = issueWhatsAppConnectLink("B-10");
    assert.ok(issued);
    assert.deepEqual(
      await answer(await exchangePost(exchangeRequest({ code: "meta-code", link: issued.ticket }))),
      { error: "link_unavailable", status: 503 },
      "🔴 when the store cannot say whether the link was used, the connection is refused",
    );
    assert.equal(graphCalls.length, 0);
  });

  // ── 3. Only a Super Admin makes one ────────────────────────────────────────────────────────
  const mint = read("../app/api/recruitment/intake/whatsapp-connect-link/route.ts");
  const assertAt = mint.indexOf('requireRecruitmentAccess(request, "recruitment", "update")');
  const scopeAt = mint.indexOf('if (access.scope !== "system")');
  const issueAt = mint.indexOf("issueWhatsAppConnectLink(");
  assert.ok(assertAt > -1 && scopeAt > assertAt && issueAt > scopeAt, "🔴 the permission and the system scope are checked before a link is made");
  assert.ok(mint.indexOf("assertSameOriginMutation(request)") < assertAt, "a cross-site request is refused first");
  const page = read("../app/(admin)/recruitment/intake-health/page.tsx");
  assert.match(page, /access\.scope === "system" \? <WhatsAppConnectLinkPanel \/> : null/, "the panel shows to a Super Admin only");
  const registry = read("../src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes('pattern: "/api/recruitment/intake/whatsapp-connect-link", permission: { resource: "recruitment", action: "update" }'),
    "the link route is registered with the update grant",
  );
  const connectPage = read("../app/whatsapp-connect/page.tsx");
  assert.match(connectPage, /link: readConnectLink\(\)\?\.ticket/, "the phone page sends the link it was opened with");
  assert.match(connectPage, /window\.location\.hash/, "the link travels in the #fragment, which no server log sees");
}
