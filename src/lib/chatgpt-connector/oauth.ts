/**
 * The ChatGPT connector's sign-in (OAuth 2.1 authorization server), inside Phoenix.
 *
 * The flow ChatGPT runs, end to end:
 *   1. It reads /.well-known/oauth-protected-resource and /.well-known/oauth-authorization-server.
 *   2. It registers itself (RFC 7591) — accepted ONLY for ChatGPT's own return addresses. A registration
 *      opens nothing by itself.
 *   3. It sends the person to /connector/authorize. That page needs a real Phoenix sign-in (password,
 *      plus the authenticator code for a Super Admin), and only the owner's and the CEO's seats may
 *      approve (CONNECTOR_ROLES). The person presses "Allow".
 *   4. Phoenix hands back a one-minute code bound to the PKCE S256 challenge; ChatGPT exchanges it for
 *      an access token (1 hour) and a refresh token (30 days). Both are random, stored only as SHA-256
 *      fingerprints, and work ONLY on /api/mcp — never as a Phoenix session.
 *   5. A refresh token is good once; presenting a spent one revokes its whole family (a stolen copy
 *      and the real one cannot both live).
 *
 * Every call to /api/mcp re-reads the account live (identity.ts): deactivated, departed, role changed,
 * password changed or "signed out everywhere" (session_version) — each ends ChatGPT's access at once.
 *
 * Nothing here prints a token. Tested in tests/chatgpt-connector-oauth.test.ts against an in-memory
 * store; the Supabase store is oauth-store.ts.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { systemDeployment } from "@/config/system-settings";

import { CONNECTOR_ROLES, type ConnectorRole } from "./types";

export const CONNECTOR_SCOPE = "phoenix:read";
export const ACCESS_TOKEN_SECONDS = 3_600;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 3_600;
export const CODE_SECONDS = 120;
const MAX_REDIRECTS = 5;

/** ChatGPT's two documented callbacks: the stable one and the per-connector one. */
const CHATGPT_REDIRECTS = Object.freeze([
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/,
]);

export function isChatGptRedirect(uri: unknown): uri is string {
  return typeof uri === "string" && CHATGPT_REDIRECTS.some((pattern) => pattern.test(uri));
}

/**
 * The per-connector callback ids Phoenix accepts on a NEW registration, from PHOENIX_CHATGPT_CALLBACK_IDS
 * (comma separated; ChatGPT's own form shows the id). Registration is open, so anyone's own connector callback
 * would otherwise register and could be put in front of the owner on the Allow page. The stable callback needs no id.
 */
function configuredCallbackIds(): ReadonlySet<string> {
  return new Set(
    String(process.env.PHOENIX_CHATGPT_CALLBACK_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/**
 * PHOENIX_CHATGPT_CLIENT_IDS (comma separated): once it names at least one client, ONLY those registered clients
 * may reach the Allow page. Registration cannot keep a stranger out — the stable ChatGPT callback is every
 * ChatGPT user's, and a client registered before the callback rule still exists — so this is the owner's lock on
 * who may be put in front of him: the id of his own connection is in the audit row written when he pressed Allow.
 * Unset (the default) leaves every registered client able to reach Allow, as before.
 */
function configuredClientIds(): ReadonlySet<string> {
  return new Set(
    String(process.env.PHOENIX_CHATGPT_CLIENT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function registrableRedirect(uri: unknown, callbackIds: ReadonlySet<string>): boolean {
  if (!isChatGptRedirect(uri)) return false;
  const perConnector = /^https:\/\/chatgpt\.com\/connector\/oauth\/([A-Za-z0-9_-]{1,128})$/.exec(uri);
  return !perConnector || callbackIds.has(perConnector[1]);
}

/**
 * Phoenix's own public address. Never taken from a request header (a forged Host would otherwise name
 * the issuer). APP_URL is set on every Railway environment; production falls back to its known domain.
 */
export function connectorOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.PHOENIX_CONNECTOR_ORIGIN ?? env.APP_URL ?? env.PHOENIX_APP_URL ?? "").trim();
  const value = configured || systemDeployment.productionUrl;
  const url = new URL(value);
  return url.origin;
}

export function connectorUrls(origin = connectorOrigin()) {
  return {
    issuer: origin,
    resource: `${origin}/api/mcp`,
    authorize: `${origin}/connector/authorize`,
    token: `${origin}/api/connector/oauth/token`,
    register: `${origin}/api/connector/oauth/register`,
    revoke: `${origin}/api/connector/oauth/revoke`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource`,
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(origin = connectorOrigin()) {
  const urls = connectorUrls(origin);
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [CONNECTOR_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 protected-resource metadata for /api/mcp. */
export function protectedResourceMetadata(origin = connectorOrigin()) {
  const urls = connectorUrls(origin);
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [CONNECTOR_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Phoenix Workforce",
  };
}

/** The WWW-Authenticate challenge a refused /api/mcp call carries, so ChatGPT finds the sign-in. */
export function bearerChallenge(error?: "invalid_token" | "insufficient_scope", origin = connectorOrigin()) {
  const parts = [`resource_metadata="${connectorUrls(origin).resourceMetadata}"`, `scope="${CONNECTOR_SCOPE}"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** A resource URL matches ours when it names the same origin and path (a trailing slash is tolerated). */
export function sameResource(candidate: unknown, resource: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    const a = new URL(candidate);
    const b = new URL(resource);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "") && !a.search && !a.hash;
  } catch {
    return false;
  }
}

export const fingerprint = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function newClientId() {
  return `phxcl_${random(18)}`;
}
export function newCode() {
  return `phxcd_${random(32)}`;
}
export function newAccessToken() {
  return `phxat_${random(32)}`;
}
export function newRefreshToken() {
  return `phxrt_${random(32)}`;
}

/** PKCE S256: base64url(SHA-256(verifier)) must equal the challenge. Constant-time compare. */
export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export function isConnectorRole(role: unknown): role is ConnectorRole {
  return typeof role === "string" && (CONNECTOR_ROLES as readonly string[]).includes(role);
}

/** An OAuth error answered as JSON ({ error, error_description }). */
export class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;

  // Plain fields, not parameter properties: the test runner strips types only and refuses those.
  constructor(code: string, description: string, status = 400) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------------
// The store: what the service needs from the database. oauth-store.ts is the Supabase one.
// ---------------------------------------------------------------------------------------------------

export type ClientRow = { client_id: string; client_name: string | null; redirect_uris: string[] };

export type GrantSubject = {
  loginId: string;
  hrId: string | null;
  role: ConnectorRole;
  sessionVersion: number;
};

export type CodeRow = GrantSubject & {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
};

export type TokenRow = GrantSubject & {
  tokenHash: string;
  kind: "access" | "refresh";
  familyId: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};

export interface ConnectorOAuthStore {
  insertClient(row: ClientRow): Promise<void>;
  getClient(clientId: string): Promise<ClientRow | null>;
  insertCode(codeHash: string, row: CodeRow, expiresAt: string): Promise<void>;
  /** Marks the code used and returns it — only if unused and unexpired, in ONE statement (the race). */
  consumeCode(codeHash: string, nowIso: string): Promise<CodeRow | null>;
  insertTokens(rows: Array<Omit<TokenRow, "usedAt" | "revokedAt">>): Promise<void>;
  findToken(tokenHash: string): Promise<TokenRow | null>;
  /** Marks a refresh token spent — only if unspent, unrevoked and unexpired, in ONE statement. */
  spendRefreshToken(tokenHash: string, nowIso: string): Promise<TokenRow | null>;
  revokeFamily(familyId: string, reason: string, nowIso: string): Promise<void>;
}

/** The live account check (identity.ts reads app_auth_users and employees). */
export type LiveSubjectCheck = (subject: GrantSubject) => Promise<{ ok: true } | { ok: false; reason: string }>;

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export function createConnectorOAuth(options: {
  store: ConnectorOAuthStore;
  checkSubject: LiveSubjectCheck;
  origin?: string;
  now?: () => number;
  /** Per-connector callback ids a new registration may name. Default: PHOENIX_CHATGPT_CALLBACK_IDS. */
  callbackIds?: ReadonlySet<string>;
  /** Registered clients allowed to reach the Allow page; empty means all. Default: PHOENIX_CHATGPT_CLIENT_IDS. */
  clientIds?: ReadonlySet<string>;
}) {
  const { store, checkSubject } = options;
  const now = options.now ?? (() => Date.now());
  const urls = connectorUrls(options.origin ?? connectorOrigin());
  const iso = (ms: number) => new Date(ms).toISOString();

  /** RFC 7591 dynamic registration, ChatGPT's return addresses only. */
  async function register(body: unknown) {
    const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
    const callbackIds = options.callbackIds ?? configuredCallbackIds();
    if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECTS || !redirectUris.every((uri) => registrableRedirect(uri, callbackIds))) {
      throw new OAuthError("invalid_redirect_uri", "Only ChatGPT's own return addresses can register, and a per-connector address only when its id is listed in PHOENIX_CHATGPT_CALLBACK_IDS.");
    }
    const authMethod = input.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") throw new OAuthError("invalid_client_metadata", "Public clients only (token_endpoint_auth_method none).");
    const grantTypes = Array.isArray(input.grant_types) ? input.grant_types : ["authorization_code", "refresh_token"];
    if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token are supported.");
    }
    const clientName = typeof input.client_name === "string" ? input.client_name.slice(0, 120) : null;
    const row: ClientRow = { client_id: newClientId(), client_name: clientName, redirect_uris: redirectUris as string[] };
    await store.insertClient(row);
    return {
      client_id: row.client_id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: clientName ?? undefined,
      redirect_uris: row.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CONNECTOR_SCOPE,
    };
  }

  /**
   * Validates an authorize request (the page calls this before showing "Allow", and the approve route
   * again before minting a code). Returns the cleaned request or throws an OAuthError with a reason a
   * person can read.
   */
  async function validateAuthorizeRequest(params: Record<string, string | undefined>) {
    if (params.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
    const clientId = params.client_id ?? "";
    const client = clientId ? await store.getClient(clientId) : null;
    if (!client) throw new OAuthError("invalid_client", "This ChatGPT connection is not registered. Remove it in ChatGPT and add it again.");
    const pinnedClients = options.clientIds ?? configuredClientIds();
    if (pinnedClients.size > 0 && !pinnedClients.has(clientId)) {
      throw new OAuthError("invalid_client", "This ChatGPT connection is not one that Phoenix has been told to accept. Ask the owner to list it in PHOENIX_CHATGPT_CLIENT_IDS, or remove it in ChatGPT and add it again.");
    }
    const redirectUri = params.redirect_uri ?? "";
    if (!client.redirect_uris.includes(redirectUri) || !isChatGptRedirect(redirectUri)) {
      throw new OAuthError("invalid_request", "The return address does not match the registered connection.");
    }
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge ?? "")) {
      throw new OAuthError("invalid_request", "PKCE S256 is required.");
    }
    const resource = params.resource ?? urls.resource;
    if (!sameResource(resource, urls.resource)) throw new OAuthError("invalid_target", "This sign-in is for Phoenix's own address only.");
    const requested = (params.scope ?? CONNECTOR_SCOPE).split(/\s+/).filter(Boolean);
    if (requested.some((scope) => scope !== CONNECTOR_SCOPE)) throw new OAuthError("invalid_scope", `Only ${CONNECTOR_SCOPE} is offered.`);
    return {
      clientId,
      clientName: client.client_name,
      redirectUri,
      codeChallenge: params.code_challenge as string,
      resource: urls.resource,
      scope: CONNECTOR_SCOPE,
      state: params.state ?? null,
    };
  }

  /** After "Allow": mint the one-time code. Returns the address to send the browser to. */
  async function approve(request: Awaited<ReturnType<typeof validateAuthorizeRequest>>, subject: GrantSubject) {
    if (!isConnectorRole(subject.role)) throw new OAuthError("access_denied", "Only the owner and the CEO can connect ChatGPT.", 403);
    const live = await checkSubject(subject);
    if (!live.ok) throw new OAuthError("access_denied", live.reason, 403);
    const code = newCode();
    await store.insertCode(
      fingerprint(code),
      { ...subject, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, resource: request.resource, scope: request.scope },
      iso(now() + CODE_SECONDS * 1000),
    );
    const target = new URL(request.redirectUri);
    target.searchParams.set("code", code);
    if (request.state) target.searchParams.set("state", request.state);
    target.searchParams.set("iss", urls.issuer);
    return target.toString();
  }

  /** "Cancel": send the browser back to ChatGPT with access_denied. */
  function deny(request: Awaited<ReturnType<typeof validateAuthorizeRequest>>) {
    const target = new URL(request.redirectUri);
    target.searchParams.set("error", "access_denied");
    if (request.state) target.searchParams.set("state", request.state);
    target.searchParams.set("iss", urls.issuer);
    return target.toString();
  }

  async function mintPair(subject: GrantSubject, clientId: string, familyId: string): Promise<TokenResponse> {
    const access = newAccessToken();
    const refresh = newRefreshToken();
    const base = { ...subject, familyId, clientId, resource: urls.resource, scope: CONNECTOR_SCOPE };
    await store.insertTokens([
      { ...base, tokenHash: fingerprint(access), kind: "access", expiresAt: iso(now() + ACCESS_TOKEN_SECONDS * 1000) },
      { ...base, tokenHash: fingerprint(refresh), kind: "refresh", expiresAt: iso(now() + REFRESH_TOKEN_SECONDS * 1000) },
    ]);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: CONNECTOR_SCOPE };
  }

  /** The token endpoint (form-encoded body already parsed into a record). */
  async function token(form: Record<string, string | undefined>): Promise<TokenResponse> {
    const grantType = form.grant_type;
    const clientId = form.client_id ?? "";
    if (grantType === "authorization_code") {
      const codeValue = form.code ?? "";
      if (!codeValue) throw new OAuthError("invalid_request", "code is required.");
      const code = await store.consumeCode(fingerprint(codeValue), iso(now()));
      if (!code) throw new OAuthError("invalid_grant", "The code is unknown, used or expired.");
      if (code.clientId !== clientId) throw new OAuthError("invalid_grant", "The code was issued to another client.");
      if ((form.redirect_uri ?? "") !== code.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match.");
      if (!pkceMatches(form.code_verifier, code.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed.");
      if (form.resource && !sameResource(form.resource, urls.resource)) throw new OAuthError("invalid_target", "Wrong resource.");
      const live = await checkSubject(code);
      if (!live.ok) throw new OAuthError("invalid_grant", live.reason);
      return mintPair(code, code.clientId, randomUUID());
    }
    if (grantType === "refresh_token") {
      const presented = form.refresh_token ?? "";
      if (!presented) throw new OAuthError("invalid_request", "refresh_token is required.");
      const hash = fingerprint(presented);
      const known = await store.findToken(hash);
      const usable =
        known !== null &&
        known.kind === "refresh" &&
        !known.usedAt &&
        !known.revokedAt &&
        Date.parse(known.expiresAt) > now();
      if (!known || !usable) {
        // Unknown, expired, revoked — or a REPLAY of a spent one. A replay revokes the family.
        if (known && known.kind === "refresh" && known.usedAt) await store.revokeFamily(known.familyId, "refresh_replay", iso(now()));
        throw new OAuthError("invalid_grant", "The refresh token is unknown, used, revoked or expired.");
      }
      if (known.clientId !== clientId) {
        await store.revokeFamily(known.familyId, "refresh_wrong_client", iso(now()));
        throw new OAuthError("invalid_grant", "The refresh token was issued to another client.");
      }
      const live = await checkSubject(known);
      if (!live.ok) {
        await store.revokeFamily(known.familyId, "account_check_failed", iso(now()));
        throw new OAuthError("invalid_grant", live.reason);
      }
      // The new pair is written BEFORE the presented token is spent: a failed write leaves it unspent, so
      // ChatGPT's retry refreshes normally instead of reading as a replay that revokes the family. The spend
      // is still the one statement that decides a race — the loser revokes the family, new pair included.
      const pair = await mintPair(known, known.clientId, known.familyId);
      const spent = await store.spendRefreshToken(hash, iso(now()));
      if (!spent) {
        await store.revokeFamily(known.familyId, "refresh_replay", iso(now()));
        throw new OAuthError("invalid_grant", "The refresh token is unknown, used, revoked or expired.");
      }
      return pair;
    }
    throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }

  /** RFC 7009: always 200; a known token's whole family is revoked. */
  async function revoke(form: Record<string, string | undefined>) {
    const presented = form.token ?? "";
    if (!presented) return;
    const known = await store.findToken(fingerprint(presented));
    if (known) await store.revokeFamily(known.familyId, "revoked_by_client", iso(now()));
  }

  /**
   * Checks a bearer on /api/mcp. Returns the subject, or null when the token is unknown, expired,
   * revoked, not an access token, or for another resource. The caller then runs the live account check.
   */
  async function verifyAccessToken(bearer: string | null): Promise<TokenRow | null> {
    if (!bearer || !bearer.startsWith("phxat_") || bearer.length > 200) return null;
    const row = await store.findToken(fingerprint(bearer));
    if (!row || row.kind !== "access" || row.revokedAt) return null;
    if (Date.parse(row.expiresAt) <= now()) return null;
    if (!sameResource(row.resource, urls.resource) || row.scope !== CONNECTOR_SCOPE) return null;
    if (!isConnectorRole(row.role)) return null;
    return row;
  }

  return { urls, register, validateAuthorizeRequest, approve, deny, token, revoke, verifyAccessToken };
}

export type ConnectorOAuth = ReturnType<typeof createConnectorOAuth>;

/** The Bearer value of an Authorization header, or null. */
export function bearerFrom(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ""));
  return match ? match[1] : null;
}
