/**
 * The HTTP glue shared by the connector's routes: the production OAuth service (Supabase store +
 * live account check), OAuth-shaped JSON errors, the form body reader and the per-address limits on
 * the three public doors (register, token, revoke). Every answer carries `Cache-Control: no-store`.
 */
import { NextResponse } from "next/server";

import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { logError } from "@/lib/observability/log";

import { checkConnectorSubject } from "./identity";
import { createConnectorOAuth, OAuthError, type ConnectorOAuth } from "./oauth";
import { createSupabaseConnectorStore } from "./oauth-store";

let service: ConnectorOAuth | null = null;
export function connectorOAuth(): ConnectorOAuth {
  service ??= createConnectorOAuth({ store: createSupabaseConnectorStore(), checkSubject: checkConnectorSubject });
  return service;
}

export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** An OAuthError as RFC 6749 JSON; anything else as a generic server_error (logged, never echoed). */
export function oauthErrorResponse(error: unknown, event: string) {
  if (error instanceof OAuthError) {
    return oauthJson({ error: error.code, error_description: error.description }, error.status);
  }
  if (isApiRateLimitError(error)) {
    return oauthJson(
      { error: "temporarily_unavailable", error_description: "Too many requests. Try again shortly." },
      429,
      { "Retry-After": String((error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60) },
    );
  }
  logError("ChatGPT connector sign-in step failed", { labels: { event }, error });
  return oauthJson({ error: "server_error", error_description: "Phoenix could not complete this step. Try again." }, 500);
}

/** Token and revoke take application/x-www-form-urlencoded (RFC 6749); JSON is accepted too. */
export async function readOAuthForm(request: Request): Promise<Record<string, string | undefined>> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (text.length > 16_384) throw new OAuthError("invalid_request", "The request body is too large.");
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    } catch {
      throw new OAuthError("invalid_request", "The body is not valid JSON.");
    }
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

/** Per-address limit on a public door; fails closed when the limiter cannot be read. */
export async function limitConnectorDoor(request: Request, scope: string, limit: number, windowMs: number) {
  await assertApiRateLimit({ identifier: rateLimitIdentity({ request }), limit, scope: `chatgpt-connector:${scope}`, windowMs });
}
