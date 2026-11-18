/**
 * /api/mcp — the door ChatGPT's Phoenix connector talks through (Model Context Protocol, streamable
 * HTTP, stateless, JSON answers).
 *
 * No cookie here: the caller is ChatGPT holding a connector access token (src/lib/chatgpt-connector/).
 * Every request: the token is checked (known, unexpired, unrevoked, for this resource), then the
 * account behind it is re-read LIVE (still active, still the owner or the CEO, same session_version,
 * still employed) — any change answers 401 with the challenge that sends ChatGPT back to sign in.
 * The tools then run as that person with the same permission checks their own screens use.
 *
 * CSRF-exempt in proxy.ts (ChatGPT's servers send no Origin) and registered in the access registry.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { connectorAccessContext } from "@/lib/chatgpt-connector/identity";
import { connectorOAuth, NO_STORE } from "@/lib/chatgpt-connector/http";
import { bearerChallenge, bearerFrom, fingerprint } from "@/lib/chatgpt-connector/oauth";
import { touchAccessToken } from "@/lib/chatgpt-connector/oauth-store";
import { withKnownProtocolVersion } from "@/lib/chatgpt-connector/protocol-version";
import { buildConnectorServer } from "@/lib/chatgpt-connector/server";
import { afterResponse } from "@/lib/http/after-response";
import { logError } from "@/lib/observability/log";
import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function refuse(status: number, message: string, challenge?: "invalid_token") {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/json",
      ...(status === 401 ? { "WWW-Authenticate": bearerChallenge(challenge) } : {}),
    },
  });
}

export async function POST(request: Request) {
  const bearer = bearerFrom(request.headers.get("authorization"));
  if (!bearer) return refuse(401, "Sign in to Phoenix to use this connector.");

  let subject;
  try {
    subject = await connectorOAuth().verifyAccessToken(bearer);
  } catch (error) {
    logError("ChatGPT connector token check failed", { labels: { event: "chatgpt_connector_token_check_failed" }, error });
    return refuse(503, "Phoenix could not check the connection just now. Try again.");
  }
  if (!subject) return refuse(401, "The Phoenix connection expired or was removed. Sign in again.", "invalid_token");

  const access = await connectorAccessContext(subject);
  // An outage answers 503, like the rate-limit check below: a 401 invalid_token makes ChatGPT start a refresh.
  if (!access.ok) return access.unavailable ? refuse(503, access.reason) : refuse(401, access.reason, "invalid_token");

  try {
    await assertApiRateLimit({ identifier: subject.familyId, limit: 120, scope: "chatgpt-connector:mcp", windowMs: 60_000 });
  } catch (error) {
    if (isApiRateLimitError(error)) return refuse(429, "Too many questions in one minute. Wait a moment and ask again.");
    return refuse(503, "Phoenix could not check the connection just now. Try again.");
  }

  const tokenHash = fingerprint(bearer);
  await afterResponse("chatgpt_connector_touch", () => touchAccessToken(tokenHash));

  const server = buildConnectorServer(access.ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    // ChatGPT sends a protocol revision newer than the SDK knows (2026-07-28); see protocol-version.ts.
    const response = await transport.handleRequest(await withKnownProtocolVersion(request));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    // JSON mode: the answer is complete once handleRequest resolves, so the per-request server can go.
    await server.close().catch(() => undefined);
  }
}

/** Stateless server: no event stream to resume and no session to end. */
export async function GET() {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { ...NO_STORE, Allow: "POST", "Content-Type": "application/json" },
  });
}

export const DELETE = GET;
