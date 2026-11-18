/**
 * Phoenix Inspect — the OAuth 2.1 AUTHORIZATION-SERVER half of the Streamable HTTP door, built for the
 * OpenAI Secure MCP Tunnel. lib/oauth.mjs stays the resource-server half; this file issues what it verifies.
 *
 * Why it exists: ChatGPT appends RFC 8707 `resource` to both the authorize and the token request
 * (developers.openai.com/plugins/build/auth), and Google refuses that parameter, so ChatGPT cannot use
 * Google directly. The tunnel's supported topology (`tunnel-client dev mcp-stub`, sample_mcp_with_dcr) is a
 * LOCAL authorization server on the MCP server's own loopback origin: PRMD names it, the tunnel-client reads
 * its metadata, the registration, token and revocation endpoints travel through the tunnel's OAuth shim, and
 * the browser is sent straight to `authorization_endpoint` — a loopback address, so only a browser on THIS
 * laptop can finish a sign-in. Inside that sign-in the owner proves who he is with Google.
 *
 *   ChatGPT ──DCR /register──► here (via tunnel)        browser ──/authorize──► here (loopback)
 *   browser ──► Google (openid email, PKCE) ──► here /oauth/google/callback: Google's id_token, fetched
 *   directly from Google's token endpoint over TLS (OIDC Core 3.1.3.7: TLS stands in for the signature),
 *   must say email_verified and an OWNER address; then our one-time code goes back to ChatGPT's redirect.
 *   ChatGPT ──/token (PKCE)──► here (via tunnel): an ES256 access token, one hour, audience = the local
 *   resource, `sid` = the grant; a rotated refresh token, 30 days, stored only as a hash.
 *
 * Revocation is immediate: the verifier refuses a token whose grant is revoked or gone, and /revoke or
 * `revokeAll()` revokes. Pending sign-ins and codes live in memory (a restart only cancels a sign-in in
 * progress); registered clients, grants and the signing key live in `stateDir`, outside the repository
 * (the repository is public). Nothing here prints a token, a secret or a raw address.
 * Tested in tests/phoenix-inspect-authorization-server.test.ts.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { INSPECT_SCOPE, TokenError, createJwtVerifier, keyFromJwk, sameResource } from "./oauth.mjs";

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
/** ChatGPT's two documented callbacks: the stable one and the per-connector one. */
const CHATGPT_REDIRECTS = Object.freeze([/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/]);
export const ACCESS_TOKEN_SECONDS = 3_600;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 3_600;
const PENDING_SECONDS = 600;
const CODE_SECONDS = 300;
const MAX_CLIENTS = 10;
const MAX_GRANTS = 20;
const MAX_PENDING = 20;

const random = (bytes = 32) => randomBytes(bytes).toString("base64url");
const digest = (value) => createHash("sha256").update(String(value)).digest("base64url");
const sameSecret = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/** An OAuth error, answered as JSON (token, register, revoke) or on a redirect (authorize). */
export class OAuthError extends Error {
  /** @param {string} code RFC 6749 error code @param {number} [status] */
  constructor(code, status = 400) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

/** @param {string} uri */
export function isChatGptRedirect(uri) {
  return typeof uri === "string" && CHATGPT_REDIRECTS.some((pattern) => pattern.test(uri));
}

/**
 * The owner addresses: Google email(s), comma-separated, lower-cased. Fails closed when empty.
 * @param {string|undefined} value
 */
export function parseOwnerEmails(value) {
  const emails = String(value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (emails.length === 0) throw new Error("refused: no owner address is configured (PHOENIX_INSPECT_MCP_OWNER_SUBJECTS)");
  for (const email of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("refused: an owner address is malformed");
  return new Set(emails);
}

/**
 * A Google OAuth client from the JSON file Google Cloud Console downloads ("installed" for a Desktop app,
 * "web" for a Web application). The file stays outside the repository.
 * @param {string} text
 */
export function googleClientFromJson(text) {
  const parsed = JSON.parse(String(text));
  const entry = parsed?.installed ?? parsed?.web;
  if (!entry || typeof entry.client_id !== "string" || typeof entry.client_secret !== "string") {
    throw new Error("refused: the Google client file holds no client_id and client_secret");
  }
  if (!entry.client_id.endsWith(".apps.googleusercontent.com")) throw new Error("refused: that is not a Google OAuth client id");
  return { clientId: entry.client_id, clientSecret: entry.client_secret };
}

/** The payload of a JWT, unverified (used only for Google's id_token received directly over TLS). */
function jwtClaims(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function loadState(file) {
  const empty = { version: 1, clients: [], grants: [] };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { version: 1, clients: Array.isArray(parsed.clients) ? parsed.clients : [], grants: Array.isArray(parsed.grants) ? parsed.grants : [] };
  } catch {
    return empty;
  }
}

function loadSigningKey(file) {
  if (existsSync(file)) return createPrivateKey(readFileSync(file, "utf8"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return privateKey;
}

/**
 * @param {{
 *   issuer: string, resource: string, stateDir: string,
 *   google: { clientId: string, clientSecret: string }, ownerEmails: Set<string>|string[],
 *   tunnelId?: string|null, now?: () => number,
 *   fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>,
 * }} options
 */
export function createAuthorizationServer({ issuer, resource, stateDir, google, ownerEmails, tunnelId = null, now = () => Date.now(), fetchImpl = fetch }) {
  const issuerUrl = new URL(issuer);
  if (issuerUrl.origin !== issuer.replace(/\/$/, "")) throw new Error("the issuer must be a bare origin");
  if (!google?.clientId || !google?.clientSecret) throw new Error("a Google OAuth client is required");
  const owners = new Set([...(ownerEmails ?? [])].map((item) => String(item).toLowerCase()));
  if (owners.size === 0) throw new Error("refused: no owner address is configured");
  if (tunnelId !== null && !/^tunnel_[a-z0-9_]{32,48}$/.test(tunnelId)) throw new Error("refused: the tunnel id is malformed");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "oauth-state.json");
  const privateKey = loadSigningKey(path.join(stateDir, "signing-key.pem"));
  const publicJwk = { ...createPublicKey(privateKey).export({ format: "jwk" }), alg: "ES256", use: "sig" };
  const kid = digest(JSON.stringify([publicJwk.x, publicJwk.y])).slice(0, 16);
  publicJwk.kid = kid;
  const googleRedirect = `${issuer}/oauth/google/callback`;
  const seconds = () => Math.floor(now() / 1000);

  let state = loadState(stateFile);
  let stateStamp = "";
  /**
   * Re-reads the state file when another process (the revoke command) changed it, so a mutation here
   * never writes back a grant that was revoked meanwhile, and the verifier sees a revocation at once.
   */
  function freshState() {
    try {
      const text = readFileSync(stateFile, "utf8");
      if (text !== stateStamp) {
        stateStamp = text;
        state = loadState(stateFile);
      }
    } catch {
      /* no file yet: nothing issued */
    }
    return state;
  }
  const save = () => {
    const temp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, stateFile);
  };
  /** @type {Map<string, Record<string, any>>} Google state → the ChatGPT request it serves */
  const pending = new Map();
  /** @type {Map<string, Record<string, any>>} code hash → what it may be exchanged for */
  const codes = new Map();

  const sweep = () => {
    const t = seconds();
    for (const [key, value] of pending) if (value.expiresAt <= t) pending.delete(key);
    for (const [key, value] of codes) if (value.expiresAt <= t) codes.delete(key);
  };

  /** A requested resource is ours: the loopback resource, or the tunnel's rewrite of it for THIS tunnel. */
  function acceptResource(value) {
    if (value === undefined || value === null || value === "") return true;
    if (sameResource(value, resource)) return true;
    if (!tunnelId) return false;
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" && !url.username && !url.password && url.href.includes(tunnelId);
    } catch {
      return false;
    }
  }

  function metadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      jwks_uri: `${issuer}/jwks`,
      scopes_supported: [INSPECT_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** RFC 7591 dynamic client registration, ChatGPT redirect URIs only. */
  function register(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(isChatGptRedirect)) throw new OAuthError("invalid_redirect_uri");
    const method = body.token_endpoint_auth_method ?? "client_secret_post";
    if (!["none", "client_secret_post"].includes(method)) throw new OAuthError("invalid_client_metadata");
    const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || grants.some((item) => !["authorization_code", "refresh_token"].includes(item))) throw new OAuthError("invalid_client_metadata");
    const clientId = `pi_${random(18)}`;
    const secret = method === "none" ? null : random(32);
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "client";
    state.clients.push({ clientId, method, secretHash: secret ? digest(secret) : null, redirectUris: uris, name, createdAt: seconds() });
    state.clients = state.clients.slice(-MAX_CLIENTS);
    save();
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: seconds(),
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: name,
      scope: INSPECT_SCOPE,
    };
  }

  const clientById = (clientId) => state.clients.find((item) => item.clientId === clientId) ?? null;

  /** Client authentication at /token and /revoke. */
  function authenticate(params) {
    const client = clientById(params.client_id);
    if (!client) throw new OAuthError("invalid_client", 401);
    if (client.method === "client_secret_post") {
      if (typeof params.client_secret !== "string" || !sameSecret(digest(params.client_secret), client.secretHash)) throw new OAuthError("invalid_client", 401);
    }
    return client;
  }

  /**
   * GET /authorize. Returns where to send the browser. A bad client or redirect URI throws (shown as a
   * page, never redirected); any other fault goes back to the redirect URI as an error.
   * @param {URLSearchParams} query
   */
  function authorize(query) {
    sweep();
    const client = clientById(query.get("client_id"));
    const redirectUri = query.get("redirect_uri");
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request");
    const back = (error) => redirectWith(redirectUri, { error, state: query.get("state"), iss: issuer });
    if (query.get("response_type") !== "code") return back("unsupported_response_type");
    const challenge = query.get("code_challenge");
    if (query.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back("invalid_request");
    if (!acceptResource(query.get("resource"))) return back("invalid_target");
    const scopes = String(query.get("scope") ?? INSPECT_SCOPE).split(" ").filter(Boolean);
    if (scopes.some((item) => item !== INSPECT_SCOPE)) return back("invalid_scope");
    if (pending.size >= MAX_PENDING) return back("temporarily_unavailable");
    const googleState = random();
    const verifier = random(48);
    const nonce = random();
    pending.set(googleState, {
      clientId: client.clientId,
      redirectUri,
      state: query.get("state"),
      challenge,
      verifier,
      nonce,
      expiresAt: seconds() + PENDING_SECONDS,
    });
    const url = new URL(GOOGLE_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: googleRedirect,
      response_type: "code",
      scope: "openid email",
      state: googleState,
      nonce,
      code_challenge: digest(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.href;
  }

  /**
   * GET /oauth/google/callback. Returns where to send the browser (ChatGPT's redirect URI), or throws
   * when the sign-in it answers is unknown or expired.
   * @param {URLSearchParams} query
   */
  async function googleCallback(query) {
    sweep();
    const entry = pending.get(query.get("state") ?? "");
    if (!entry) throw new OAuthError("invalid_request");
    pending.delete(query.get("state"));
    const back = (params) => redirectWith(entry.redirectUri, { ...params, state: entry.state, iss: issuer });
    if (query.get("error") || !query.get("code")) return { location: back({ error: "access_denied" }), outcome: "google-declined" };
    let claims;
    try {
      const response = await fetchImpl(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: query.get("code"),
          redirect_uri: googleRedirect,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          code_verifier: entry.verifier,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`google token ${response.status}`);
      const body = await response.json();
      claims = jwtClaims(body.id_token);
    } catch {
      return { location: back({ error: "server_error" }), outcome: "google-exchange-failed" };
    }
    const t = seconds();
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
    const valid =
      GOOGLE_ISSUERS.includes(claims.iss) &&
      (claims.aud === google.clientId || (Array.isArray(claims.aud) && claims.aud.includes(google.clientId))) &&
      typeof claims.exp === "number" && claims.exp > t &&
      claims.nonce === entry.nonce &&
      claims.email_verified === true;
    if (!valid) return { location: back({ error: "access_denied" }), outcome: "google-identity-invalid" };
    if (!owners.has(email)) return { location: back({ error: "access_denied" }), outcome: "not-owner" };
    const code = random();
    codes.set(digest(code), { clientId: entry.clientId, redirectUri: entry.redirectUri, challenge: entry.challenge, subject: email, expiresAt: t + CODE_SECONDS });
    return { location: back({ code }), outcome: "ok" };
  }

  function accessToken(grant) {
    const t = seconds();
    const header = { alg: "ES256", typ: "at+jwt", kid };
    const claims = { iss: issuer, aud: resource, sub: grant.subject, scope: INSPECT_SCOPE, client_id: grant.clientId, sid: grant.id, jti: random(12), iat: t, exp: t + ACCESS_TOKEN_SECONDS };
    const data = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${data}.${sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  }

  function issue(grant) {
    const refresh = random(32);
    grant.refreshHash = digest(refresh);
    grant.refreshExpiresAt = seconds() + REFRESH_TOKEN_SECONDS;
    save();
    return { access_token: accessToken(grant), token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh, scope: INSPECT_SCOPE };
  }

  /** POST /token. @param {Record<string, string>} params */
  function token(params) {
    sweep();
    const client = authenticate(params);
    if (!acceptResource(params.resource)) throw new OAuthError("invalid_target");
    if (params.grant_type === "authorization_code") {
      const key = digest(params.code ?? "");
      const entry = codes.get(key);
      codes.delete(key); // one use, even when it fails
      if (!entry || entry.clientId !== client.clientId || entry.redirectUri !== params.redirect_uri) throw new OAuthError("invalid_grant");
      if (typeof params.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier) || digest(params.code_verifier) !== entry.challenge) {
        throw new OAuthError("invalid_grant");
      }
      const grant = { id: `g_${random(12)}`, subject: entry.subject, clientId: client.clientId, createdAt: seconds(), revokedAt: null, refreshHash: null, refreshExpiresAt: 0, spentRefreshHashes: [] };
      state.grants.push(grant);
      // Keep every live grant; drop the oldest revoked or expired ones past the cap.
      while (state.grants.length > MAX_GRANTS) {
        // The new grant is born with refreshExpiresAt 0 (issue() sets it next), so it must never count as expired here.
        const dead = state.grants.findIndex((item) => item !== grant && (item.revokedAt || item.refreshExpiresAt <= seconds()));
        state.grants.splice(dead === -1 ? 0 : dead, 1);
      }
      return issue(grant);
    }
    if (params.grant_type === "refresh_token") {
      const hash = digest(params.refresh_token ?? "");
      const reused = state.grants.find((item) => item.spentRefreshHashes?.includes(hash));
      if (reused) {
        // A rotated-out refresh token presented again: someone holds a copy. Revoke the whole grant.
        reused.revokedAt = seconds();
        save();
        throw new OAuthError("invalid_grant");
      }
      const grant = state.grants.find((item) => item.refreshHash === hash);
      if (!grant || grant.revokedAt || grant.clientId !== client.clientId || grant.refreshExpiresAt <= seconds() || !owners.has(grant.subject)) throw new OAuthError("invalid_grant");
      grant.spentRefreshHashes = [...(grant.spentRefreshHashes ?? []), hash].slice(-10);
      return issue(grant);
    }
    throw new OAuthError("unsupported_grant_type");
  }

  /** POST /revoke (RFC 7009): a refresh or access token; unknown tokens are not an error. */
  function revoke(params) {
    const client = authenticate(params);
    const value = String(params.token ?? "");
    const hash = digest(value);
    let grant = state.grants.find((item) => item.refreshHash === hash);
    if (!grant && value.split(".").length === 3) {
      try {
        const sid = jwtClaims(value).sid;
        grant = state.grants.find((item) => item.id === sid);
      } catch {
        grant = undefined;
      }
    }
    if (grant && grant.clientId === client.clientId && !grant.revokedAt) {
      grant.revokedAt = seconds();
      save();
    }
  }

  const jwt = createJwtVerifier({ issuer, audience: resource, keys: [keyFromJwk(publicJwk)], maxLifetimeSeconds: ACCESS_TOKEN_SECONDS, now });
  const verifier = {
    async verifyAccessToken(value) {
      const verified = await jwt.verifyAccessToken(value);
      const sid = jwtClaims(value).sid;
      const grant = freshState().grants.find((item) => item.id === sid);
      if (!grant) throw new TokenError("unknown-grant");
      if (grant.revokedAt) throw new TokenError("revoked");
      return verified;
    },
  };

  return { metadata, register: (body) => (freshState(), register(body)), authorize, googleCallback, token: (params) => (freshState(), token(params)), revoke: (params) => (freshState(), revoke(params)), verifier, jwks: () => ({ keys: [publicJwk] }), googleRedirect };
}

/**
 * The owner's kill switch, from another process: revokes every grant in `stateDir`. The running server
 * re-reads the file on the next request, so every issued access and refresh token stops at once.
 * @param {string} stateDir @param {() => number} [now]
 * @returns {number} how many grants were live
 */
export function revokeAllGrants(stateDir, now = () => Date.now()) {
  const stateFile = path.join(stateDir, "oauth-state.json");
  const state = loadState(stateFile);
  let count = 0;
  for (const grant of state.grants) {
    if (!grant.revokedAt) {
      grant.revokedAt = Math.floor(now() / 1000);
      count += 1;
    }
  }
  if (existsSync(stateFile)) writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return count;
}

/** A redirect URI with parameters added (nulls dropped). */
function redirectWith(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
  return url.href;
}
