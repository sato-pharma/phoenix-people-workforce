/**
 * Phoenix Inspect — the OAuth 2.1 RESOURCE-SERVER half of the Streamable HTTP door (mcp-http.mjs).
 *
 * It checks bearer tokens and says where to get one; it does not issue them. Pure functions and a token
 * verifier, no I/O except the optional JWKS fetch. Tested in tests/phoenix-inspect-mcp-http.test.ts.
 *
 * Ported, not imported, from infra/phoenix-mcp (a separate, undeployed package with its own lockfile):
 *   - protectedResourceMetadataUrl, sameResource and bearerChallenge: the MCP SDK's
 *     getOAuthProtectedResourceMetadataUrl and requireBearerAuth, exactly as infra/phoenix-mcp/src/server.mts
 *     wires them in front of its /mcp (resource-metadata link in every 401).
 *   - protectedResourceMetadata: the RFC 9728 document the SDK's mcpAuthRouter serves for server.mts
 *     (resource, authorization_servers, scopes_supported, resource_name).
 *   - httpsUrl and refusePrivilegedEnv: infra/phoenix-mcp/src/config.mts (an https URL with no credentials,
 *     query or fragment; refuse to start beside an unrelated privileged key, because the repo's
 *     .env.local points at production).
 *   - The owner rule: infra/phoenix-mcp/src/policy.mts `Authorizer.verify` — admit exactly the configured
 *     subject(s); a role or name inside the token never widens it. The subjects come from the environment,
 *     never from Git (the repository is public).
 *   - createJwtVerifier's checks: infra/phoenix-mcp/src/oauth.mts `createIdentityProvider` (exact issuer and
 *     audience, RS256/ES256 only, required sub/exp/iat, the azp/client pin, a bounded token age; a JWKS
 *     address must be https on the issuer's own origin, fetched with a 5 s timeout and no redirects).
 *   - The access token's audience is this server's resource URL: oauth.mts binds every grant to
 *     `resource` and refuses any other (`Incorrect resource`).
 * NOT ported: the authorization-server half of oauth.mts (authorize, upstream OIDC callback, consent page,
 * token, refresh rotation, revoke). It needs an upstream OpenID provider, its SQLite state store
 * (state.mts) and the live Phoenix identity source (live-authorization.mts, an approval-gated endpoint
 * that does not exist). docs/phoenix-intelligence/CHATGPT_MCP_CONNECTION_READINESS.md §3 lists what is
 * still needed.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";

/** The one scope a token needs here. Not the data service's `phoenix:read`: the two never share tokens. */
export const INSPECT_SCOPE = "phoenix-inspect:read";
export const LOOPBACK_HOSTNAMES = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
/** infra/phoenix-mcp/src/config.mts: none of these is needed here, and any of them means the wrong env. */
export const PRIVILEGED_ENV = Object.freeze(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "PHOENIX_AUTH_SECRET", "DATABASE_URL"]);
const ALGORITHMS = Object.freeze(["ES256", "RS256", "HS256"]);
const MAX_TOKEN_LENGTH = 8_192;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;

/** A token that is missing, malformed or not acceptable. `reason` goes to the audit log, never to the client. */
export class TokenError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`access token refused: ${reason}`);
    this.name = "TokenError";
    this.reason = reason;
  }
}

/**
 * An https URL with no credentials, query or fragment (config.mts). Throws otherwise.
 * @param {string} value
 * @param {string} label what it is, for the message
 * @returns {URL}
 */
export function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} is not a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an https URL without credentials, query or fragment`);
  }
  return url;
}

/** @param {string} hostname as URL.hostname gives it (IPv6 in brackets) */
export function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.includes(String(hostname).toLowerCase());
}

/**
 * Refuses to run beside an unrelated privileged key (config.mts).
 * @param {Record<string, string|undefined>} env
 */
export function refusePrivilegedEnv(env) {
  const present = PRIVILEGED_ENV.filter((name) => env[name]);
  if (present.length > 0) throw new Error(`refused: remove unrelated privileged environment variable(s): ${present.join(", ")}`);
}

/**
 * RFC 9728 §3.1: the metadata address with the well-known segment inserted before the resource's path
 * (the SDK's getOAuthProtectedResourceMetadataUrl).
 * @param {string} resource
 */
export function protectedResourceMetadataUrl(resource) {
  const url = new URL(resource);
  const path = url.pathname && url.pathname !== "/" ? url.pathname : "";
  return new URL(`/.well-known/oauth-protected-resource${path}`, url).href;
}

/** The SDK bearerAuth comparison: the same string once a fragment and one trailing slash are dropped. */
function comparableResource(value) {
  const text = String(value);
  const hash = text.indexOf("#");
  return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, "");
}

/**
 * @param {unknown} reported
 * @param {string} expected
 */
export function sameResource(reported, expected) {
  if (!reported) return false;
  return comparableResource(reported) === comparableResource(expected);
}

/**
 * The RFC 9728 protected-resource metadata document.
 * @param {{ resource: string, authorizationServer: string, scopes?: string[], resourceName?: string }} options
 */
export function protectedResourceMetadata({ resource, authorizationServer, scopes = [INSPECT_SCOPE], resourceName = "Phoenix Inspect (staging, read-only)" }) {
  return {
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: resourceName,
  };
}

/**
 * The WWW-Authenticate value of a 401 or 403. RFC 6750 §3.1: a request that carried no token gets no
 * error code. Descriptions are fixed strings; nothing from the request is echoed.
 * @param {{ resourceMetadataUrl: string, scope?: string, error?: "invalid_token"|"invalid_request"|"insufficient_scope", description?: string }} options
 */
export function bearerChallenge({ resourceMetadataUrl, scope = INSPECT_SCOPE, error, description }) {
  const quote = (value) => `"${String(value).replace(/["\\]/g, "")}"`;
  const parts = [];
  if (error) parts.push(`error=${quote(error)}`);
  if (error && description) parts.push(`error_description=${quote(description)}`);
  parts.push(`scope=${quote(scope)}`, `resource_metadata=${quote(resourceMetadataUrl)}`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * The owner subjects from one environment value, comma-separated. Fails closed: none, or a malformed one,
 * refuses to start.
 * @param {string|undefined} value
 * @returns {Set<string>}
 */
export function parseOwnerSubjects(value) {
  const subjects = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (subjects.length === 0) throw new Error("refused: no owner subject is configured (PHOENIX_INSPECT_MCP_OWNER_SUBJECTS)");
  if (subjects.length > 5) throw new Error("refused: at most five owner subjects");
  for (const subject of subjects) {
    if (subject.length > 255 || /\s/.test(subject)) throw new Error("refused: an owner subject is malformed");
  }
  return new Set(subjects);
}

/**
 * A short keyed hash of a subject, for the audit log: the raw subject is never written.
 * @param {string} key
 * @param {string} subject
 */
export function subjectHash(key, subject) {
  return createHmac("sha256", key).update(String(subject)).digest("hex").slice(0, 16);
}

/**
 * @typedef {{ kid?: string, alg: string, key: import("node:crypto").KeyObject }} VerificationKey
 */

/**
 * A PUBLIC JSON Web Key as a verification key. Refuses a private key (`d`) and a shared secret (`oct`):
 * this server must never hold anything that could mint a token.
 * @param {Record<string, unknown>} jwk
 * @returns {VerificationKey}
 */
export function keyFromJwk(jwk) {
  if (!jwk || typeof jwk !== "object") throw new Error("a JWK must be an object");
  if ("d" in jwk || jwk.kty === "oct") throw new Error("refused: a JWKS here holds public keys only");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Error("refused: a JWK not meant for signatures");
  const alg = typeof jwk.alg === "string" ? jwk.alg : jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : jwk.kty === "RSA" ? "RS256" : null;
  if (alg !== "ES256" && alg !== "RS256") throw new Error("refused: only ES256 and RS256 keys are accepted");
  const key = createPublicKey({ key: /** @type {import("node:crypto").JsonWebKey} */ (jwk), format: "jwk" });
  checkKey({ alg, key });
  return { kid: typeof jwk.kid === "string" ? jwk.kid : undefined, alg, key };
}

/** @param {VerificationKey} entry */
function checkKey({ alg, key }) {
  if (alg === "ES256" && !(key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1")) {
    throw new Error("an ES256 key must be a P-256 public key");
  }
  if (alg === "RS256" && !(key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048)) {
    throw new Error("an RS256 key must be an RSA public key of at least 2048 bits");
  }
  if (alg === "HS256" && !(key.type === "secret" && (key.symmetricKeySize ?? 0) >= 32)) {
    throw new Error("an HS256 key must be a secret of at least 32 bytes");
  }
  if ((alg === "ES256" || alg === "RS256") && key.type !== "public") throw new Error("refused: a verification key must be public");
}

/**
 * @param {string} text a JWKS document
 * @returns {VerificationKey[]}
 */
export function keysFromJwks(text) {
  const parsed = JSON.parse(String(text));
  const list = Array.isArray(parsed?.keys) ? parsed.keys : null;
  if (!list || list.length === 0 || list.length > 20) throw new Error("a JWKS needs 1 to 20 keys");
  return list.map((jwk) => keyFromJwk(jwk));
}

function decodeSegment(segment, what) {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new TokenError("malformed");
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(what);
    return value;
  } catch {
    throw new TokenError("malformed");
  }
}

function signatureMatches({ alg, key }, data, signature) {
  if (alg === "ES256") return signature.length === 64 && verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  if (alg === "RS256") return verifySignature("sha256", data, key, signature);
  if (alg === "HS256") {
    const expected = createHmac("sha256", key).update(data).digest();
    return signature.length === expected.length && timingSafeEqual(signature, expected);
  }
  return false;
}

/**
 * Fetches a JWKS from an https address on the issuer's origin, caches it ten minutes, refetches early
 * for an unknown key id at most every 30 s. Any failure fails closed (no token verifies).
 */
function remoteKeySet(jwksUrl, issuer, fetchImpl, now) {
  const url = httpsUrl(jwksUrl, "the JWKS address");
  if (url.origin !== new URL(issuer).origin) throw new Error("refused: the JWKS address must be on the issuer's own origin");
  let cache = null;
  let fetchedAt = 0;
  let lastTry = -Infinity;
  return async (kid) => {
    const fresh = cache && now() - fetchedAt < JWKS_TTL_MS;
    if (fresh && (kid === undefined || cache.some((entry) => entry.kid === kid))) return cache;
    if (now() - lastTry < JWKS_COOLDOWN_MS) {
      if (cache) return cache;
      throw new Error("the signing keys are unavailable");
    }
    lastTry = now();
    const response = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("the signing keys are unavailable");
    const body = await response.text();
    if (body.length > 64_000) throw new Error("the signing keys are unavailable");
    cache = keysFromJwks(body);
    fetchedAt = now();
    return cache;
  };
}

/**
 * Verifies a JWT access token for THIS resource. Signature (the key's own algorithm only, so `none` and
 * an HS256-with-the-public-key forgery both fail), then: exact issuer, audience = this server's resource
 * URL, exp in the future, iat present and not in the future, a bounded lifetime, nbf, sub, and the client
 * pin when one is configured. Scope, owner and resource are checked again by the HTTP layer, so a
 * different verifier (for example an opaque-token store) gets the same rules.
 *
 * @param {{ issuer: string, audience: string, keys?: VerificationKey[], jwksUrl?: string|null, clientId?: string|null, maxLifetimeSeconds?: number, now?: () => number, fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean, text: () => Promise<string> }> }} options
 * @returns {{ verifyAccessToken: (token: string) => Promise<{ subject: string, scopes: string[], expiresAt: number, resource: string, clientId: string|null }> }}
 */
export function createJwtVerifier({ issuer, audience, keys = [], jwksUrl = null, clientId = null, maxLifetimeSeconds = 3_600, now = () => Date.now(), fetchImpl = fetch }) {
  if (!issuer || !audience) throw new Error("a verifier needs an issuer and an audience");
  for (const entry of keys) {
    if (!ALGORITHMS.includes(entry.alg)) throw new Error(`unsupported key algorithm ${entry.alg}`);
    checkKey(entry);
  }
  if (keys.length === 0 && !jwksUrl) throw new Error("a verifier needs keys or a JWKS address");
  const remote = jwksUrl ? remoteKeySet(jwksUrl, issuer, fetchImpl, now) : null;

  return {
    async verifyAccessToken(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new TokenError("malformed");
      const parts = token.split(".");
      if (parts.length !== 3) throw new TokenError("malformed");
      const header = decodeSegment(parts[0], "header");
      const claims = decodeSegment(parts[1], "claims");
      if (header.crit !== undefined) throw new TokenError("unsupported-header");
      if (typeof header.alg !== "string" || !ALGORITHMS.includes(header.alg)) throw new TokenError("unsupported-algorithm");
      if (header.typ !== undefined && !["jwt", "at+jwt", "application/at+jwt"].includes(String(header.typ).toLowerCase())) {
        throw new TokenError("unsupported-type");
      }
      const kid = typeof header.kid === "string" ? header.kid : undefined;
      const pool = remote ? [...keys, ...(await remote(kid))] : keys;
      const candidates = pool.filter((entry) => entry.alg === header.alg && (kid === undefined || entry.kid === undefined || entry.kid === kid));
      if (candidates.length === 0) throw new TokenError("unknown-key");
      if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new TokenError("malformed");
      const data = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
      const signature = Buffer.from(parts[2], "base64url");
      if (!candidates.some((entry) => signatureMatches(entry, data, signature))) throw new TokenError("bad-signature");

      const nowSeconds = now() / 1000;
      if (claims.iss !== issuer) throw new TokenError("wrong-issuer");
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.some((value) => typeof value === "string" && sameResource(value, audience))) throw new TokenError("wrong-audience");
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new TokenError("no-expiry");
      if (claims.exp <= nowSeconds) throw new TokenError("expired");
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) throw new TokenError("no-issued-at");
      if (claims.iat > nowSeconds + 60) throw new TokenError("issued-in-future");
      if (claims.exp - claims.iat > maxLifetimeSeconds) throw new TokenError("lifetime-too-long");
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowSeconds + 5)) throw new TokenError("not-yet-valid");
      if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw new TokenError("no-subject");
      const tokenClient = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null;
      if (clientId) {
        // oauth.mts: with several audiences the authorized party must be ours; any azp present must be ours.
        if (tokenClient !== clientId) throw new TokenError("wrong-client");
        if (claims.azp !== undefined && claims.azp !== clientId) throw new TokenError("wrong-client");
      }
      const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : Array.isArray(claims.scp) ? claims.scp.filter((item) => typeof item === "string") : [];
      return { subject: claims.sub, scopes, expiresAt: claims.exp, resource: audience, clientId: tokenClient };
    },
  };
}
