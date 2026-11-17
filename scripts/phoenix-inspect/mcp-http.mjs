#!/usr/bin/env node
/**
 * Phoenix Inspect — the same nine MCP tools as mcp-server.mjs, over Streamable HTTP, behind OAuth.
 *
 *   node scripts/phoenix-inspect/mcp-http.mjs [--runner spare|local] [--port 8787] [--host 127.0.0.1]
 *        [--public-url https://<host>/mcp --trust-proxy [--allow-non-loopback]]
 *
 * Environment (names only; values never in Git — the repository is public):
 *   PHOENIX_INSPECT_MCP_OWNER_SUBJECTS  the token `sub` value(s) admitted, comma-separated (required)
 *   PHOENIX_INSPECT_MCP_ISSUER          the authorization server's issuer, https (required)
 *   PHOENIX_INSPECT_MCP_JWKS            its PUBLIC signing keys as a JWKS document, or
 *   PHOENIX_INSPECT_MCP_JWKS_URL        an https JWKS address on the issuer's origin (one is required)
 *   PHOENIX_INSPECT_MCP_CLIENT_ID       optional: the only OAuth client whose tokens are accepted
 *   PHOENIX_INSPECT_MCP_AUDIT_KEY       optional (32+ characters): keys the subject hash in the audit log
 *   PHOENIX_INSPECT_MCP_PUBLIC_URL      the same as --public-url
 *   PHOENIX_INSPECT_TARGET_ORIGIN       optional; staging is the only value accepted (production refuses to start)
 * The built-in sign-in (the Secure MCP Tunnel route; loopback only; connect-chatgpt.ps1 sets these):
 *   PHOENIX_INSPECT_GOOGLE_CLIENT_FILE  a Google OAuth client JSON (Desktop app); selects the built-in
 *                                       authorization server instead of an external issuer
 *   PHOENIX_INSPECT_MCP_OWNER_SUBJECTS  then holds the owner's Google address(es)
 *   PHOENIX_INSPECT_MCP_STATE_DIR       optional; clients, grants and the signing key
 *                                       (default %LOCALAPPDATA%/PhoenixInspect/oauth)
 *   PHOENIX_INSPECT_MCP_TUNNEL_ID       optional; a resource URL through that tunnel is also accepted
 *   --revoke-all                        the kill switch: every token it issued stops at once
 *
 * What it is (the MCP authorization spec's RESOURCE SERVER, nothing more):
 *   - POST /mcp: the MCP SDK's StreamableHTTPServerTransport, stateless, JSON responses, a fresh protocol
 *     server per request over ONE shared inspector (so 10 calls a minute and one capture at a time hold
 *     across requests). GET and DELETE on /mcp answer 405.
 *   - Every /mcp request needs `Authorization: Bearer <token>`: none or a bad one answers 401 with
 *     `WWW-Authenticate: Bearer … resource_metadata="…"`; a valid token without the scope, or for a subject
 *     that is not the owner, answers 403.
 *   - GET /.well-known/oauth-protected-resource (and …/mcp, RFC 9728 §3.1) names the resource and the
 *     authorization server. This process issues no tokens: lib/oauth.mjs says what was ported and what is not.
 *   - GET /healthz.
 * Network shape: binds 127.0.0.1 by default. A non-loopback bind needs --allow-non-loopback AND an https
 * --public-url. X-Forwarded-Proto/-Host are read only with --trust-proxy (which needs --public-url), and a
 * request for the public name must arrive as https through that proxy. The Host header (port-agnostic,
 * as the SDK's hostHeaderValidation) and any Origin header (exactly, as infra/phoenix-mcp/src/server.mts)
 * are checked on every route against DNS rebinding. Metadata addresses come from configuration, never from
 * a request header; http is advertised only on loopback.
 * Staging only: it refuses to start if the target origin is the production host (lib/safety.mjs
 * assertTargetOrigin, lib/fence.mjs PRODUCTION_HOSTS), and the explorer refuses production again.
 * Audit: artifacts/phoenix-inspection/mcp-http-audit.jsonl, one line per HTTP request: route, rpc method,
 * tool and validated ids, outcome, refusal reason, http status, ms, and a keyed hash of the subject. Never a
 * token, a header, a cookie, a raw subject or a refused call's input.
 * Nothing here is deployed or exposed; docs/phoenix-intelligence/CHATGPT_MCP_DEPLOYMENT_RUNBOOK.md.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cairoStamp } from "./explore.mjs";
import { STAGING_ORIGIN } from "./lib/fence.mjs";
import {
  INSPECT_SCOPE,
  LOOPBACK_HOSTNAMES,
  TokenError,
  bearerChallenge,
  createJwtVerifier,
  httpsUrl,
  isLoopbackHostname,
  keysFromJwks,
  parseOwnerSubjects,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  refusePrivilegedEnv,
  sameResource,
  subjectHash,
} from "./lib/oauth.mjs";
import { createAuthorizationServer, googleClientFromJson, parseOwnerEmails, revokeAllGrants } from "./lib/authorization-server.mjs";
import { assertTargetOrigin } from "./lib/safety.mjs";
import { REPO_ROOT, buildMcpServer, createInspector, localRunner, spareRunner } from "./mcp-server.mjs";
import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

// A flag this script does not know is refused before anything runs (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "mcp-http",
  entry: import.meta.url,
  known: ["--runner", "--port", "--host", "--public-url", "--allow-non-loopback", "--trust-proxy", "--revoke-all"],
  hints: [
    "node scripts/phoenix-inspect/mcp-http.mjs [--runner spare|local] [--port 8787] [--host 127.0.0.1] [--public-url https://<host>/mcp --trust-proxy [--allow-non-loopback]]",
    "node scripts/phoenix-inspect/mcp-http.mjs --revoke-all",
  ],
});

const LOOPBACK_BINDS = Object.freeze(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 16 * 1024;
const METADATA_PATHS = Object.freeze(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]);
const UNAVAILABLE = "The access token is invalid or expired";
/** The built-in authorization server's routes (lib/authorization-server.mjs), by path. */
const AUTH_ROUTES = Object.freeze({
  "/.well-known/oauth-authorization-server": "oauth-metadata",
  "/register": "register",
  "/authorize": "authorize",
  "/oauth/google/callback": "google-callback",
  "/token": "token",
  "/revoke": "revoke",
  "/jwks": "jwks",
});
/**
 * The OpenAI Secure MCP Tunnel's limits: a 120-second deadline including queue time and a 10 MiB envelope
 * (developers.openai.com/api/docs/guides/secure-mcp-tunnels). Behind the built-in authorization server
 * the door is for the tunnel, so one call captures ONE page, stops hard at 90 seconds, returns one
 * screenshot, and the serialized result stays under 9 MiB.
 */
export const TUNNEL_CALL_LIMITS = Object.freeze({ pages: 1, minutes: 1.5 });
export const TUNNEL_IMAGE_LIMITS = Object.freeze({ count: 1, bytes: 6 * 1024 * 1024 });
export const TUNNEL_MAX_RESULT_BYTES = 9 * 1024 * 1024;

/**
 * @typedef {{ subject: string, scopes: string[], expiresAt: number, resource?: string|URL|null, clientId?: string|null }} VerifiedToken
 * @typedef {{ verifyAccessToken: (token: string) => Promise<VerifiedToken> }} TokenVerifier
 */

/** The first value of a forwarded header ("a, b" or a repeated header). */
function firstOf(value) {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const first = String(raw).split(",")[0].trim();
  return first || undefined;
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Starts the HTTP door. Every refusal of a bad configuration happens BEFORE the port is opened.
 * `verifier` may be a function of the resource URL, so the token audience is always this server's own
 * resource (the port is only known after listening).
 * @param {{
 *   runner: (options: Record<string, unknown>) => Promise<{ outDir: string, manifest: Record<string, unknown> }>,
 *   verifier?: TokenVerifier | ((resource: string) => TokenVerifier),
 *   ownerSubjects: string[] | Set<string>,
 *   authorizationServer?: string,
 *   authorization?: ((context: { issuer: string, resource: string }) => ReturnType<typeof import("./lib/authorization-server.mjs").createAuthorizationServer>) | null,
 *   host?: string, port?: number, publicUrl?: string|null, allowNonLoopback?: boolean, trustProxy?: boolean,
 *   targetOrigin?: string, auditFile?: string|null, auditKey?: string, requestsPerMinute?: number, maxInflight?: number,
 *   repoRoot?: string, now?: () => number, imageLimits?: { count?: number, bytes?: number },
 *   callLimits?: { pages?: number, minutes?: number }, maxResultBytes?: number|null
 * }} options
 * `authorization` builds the built-in authorization server once the port is known (issuer = this loopback
 * origin); it replaces `verifier` and `authorizationServer`, is loopback-only, and brings the tunnel's
 * per-call limits unless `callLimits`, `imageLimits` or `maxResultBytes` say otherwise.
 * @returns {Promise<{ url: string, port: number, resource: string, metadataUrl: string, close: () => Promise<void> }>}
 */
export async function startHttpServer(options) {
  const {
    runner,
    verifier,
    ownerSubjects,
    authorizationServer,
    authorization = null,
    host = "127.0.0.1",
    port = 0,
    publicUrl = null,
    allowNonLoopback = false,
    trustProxy = false,
    targetOrigin = STAGING_ORIGIN,
    auditFile,
    auditKey = randomBytes(32).toString("hex"),
    requestsPerMinute = 120,
    maxInflight = 4,
    repoRoot = REPO_ROOT,
    now = () => Date.now(),
    imageLimits = authorization ? TUNNEL_IMAGE_LIMITS : undefined,
    callLimits = authorization ? TUNNEL_CALL_LIMITS : undefined,
    maxResultBytes = authorization ? TUNNEL_MAX_RESULT_BYTES : null,
  } = options;

  // Staging only: the production host refuses to start (and the explorer refuses it again per run).
  assertTargetOrigin(targetOrigin);
  if (typeof runner !== "function") throw new Error("a runner is required");
  const owners = parseOwnerSubjects([...(ownerSubjects ?? [])].join(","));
  if (authorization) {
    if (typeof authorization !== "function") throw new Error("authorization must build the authorization server");
    // The built-in authorization server's browser leg is a loopback address: it serves this laptop only.
    if (publicUrl || trustProxy || allowNonLoopback) throw new Error("refused: the built-in authorization server is loopback-only (no --public-url, --trust-proxy or --allow-non-loopback)");
  } else {
    if (!verifier || (typeof verifier !== "function" && typeof verifier.verifyAccessToken !== "function")) throw new Error("a token verifier is required");
    httpsUrl(authorizationServer, "the authorization server");
  }
  const publicResource = publicUrl ? httpsUrl(publicUrl, "the public URL") : null;
  if (publicResource && publicResource.pathname !== "/mcp") throw new Error("refused: the public URL must end in /mcp");
  if (!LOOPBACK_BINDS.includes(host) && !(allowNonLoopback && publicResource)) {
    throw new Error("refused: this server binds loopback only; a non-loopback bind needs --allow-non-loopback AND an https --public-url");
  }
  if (trustProxy && !publicResource) throw new Error("refused: --trust-proxy needs an https --public-url");

  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const inspector = createInspector({ runner, repoRoot, now, auditFile: null, imageLimits, callLimits, maxResultBytes });
  const auditPath = auditFile === undefined ? path.join(repoRoot, "artifacts", "phoenix-inspection", "mcp-http-audit.jsonl") : auditFile;
  function writeAudit(record) {
    if (!auditPath) return;
    try {
      mkdirSync(path.dirname(auditPath), { recursive: true });
      appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.error(`audit log not written: ${error.message}`);
    }
  }

  // Set once listening; the handler never runs before that.
  let resource = "";
  let metadataUrl = "";
  let metadata = {};
  let tokens = /** @type {TokenVerifier} */ ({ verifyAccessToken: async () => Promise.reject(new TokenError("not-ready")) });
  /** @type {ReturnType<typeof import("./lib/authorization-server.mjs").createAuthorizationServer> | null} */
  let auth = null;
  const allowedHostnames = new Set([...LOOPBACK_HOSTNAMES, ...(publicResource ? [publicResource.hostname.toLowerCase()] : [])]);
  const allowedOrigins = new Set(publicResource ? [publicResource.origin] : []);
  let windowStart = now();
  let windowCount = 0;
  let inflight = 0;

  async function handle(req, res) {
    const started = now();
    const url = new URL(req.url ?? "/", "http://request.invalid");
    const authRoute = auth ? (AUTH_ROUTES[url.pathname] ?? null) : null;
    const route = url.pathname === "/mcp" ? "mcp" : METADATA_PATHS.includes(url.pathname) ? "metadata" : url.pathname === "/healthz" ? "healthz" : (authRoute ?? "other");
    /** @type {Record<string, unknown>} */
    const record = { at: cairoStamp(new Date(started)).text, transport: "http", method: req.method, route, outcome: "refused" };
    let audited = false;
    res.once("close", () => {
      if (audited) return;
      audited = true;
      record.status = res.statusCode;
      record.ms = now() - started;
      writeAudit(record);
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status, body, headers = {}) => {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const refuse = (status, error, outcome, extra = {}) => {
      record.outcome = outcome;
      send(status, { error }, extra);
    };

    // 1. DNS rebinding: the Host (or, behind a trusted proxy, the forwarded host) must be ours.
    const hostname = hostnameOf(trustProxy ? (firstOf(req.headers["x-forwarded-host"]) ?? req.headers.host) : req.headers.host);
    if (!hostname || !allowedHostnames.has(hostname)) return refuse(403, "host_rejected", "host-rejected");
    // 2. The public name only over https, which only a trusted proxy can vouch for (this process speaks plain http).
    const proto = trustProxy ? (firstOf(req.headers["x-forwarded-proto"]) ?? "http") : "http";
    if (!isLoopbackHostname(hostname) && proto !== "https") return refuse(403, "https_required", "https-required");
    // 3. One global budget, enough for one owner; it trusts no forwarded address (infra/phoenix-mcp/src/server.mts).
    if (route !== "healthz") {
      if (now() - windowStart >= 60_000) {
        windowStart = now();
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > requestsPerMinute) return refuse(429, "rate_limited", "rate-limited", { "Retry-After": "60" });
    }
    // 4. An Origin, when a browser sends one, must be exactly ours.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return refuse(403, "origin_rejected", "origin-rejected");

    if (route === "healthz" && req.method === "GET") {
      record.outcome = "ok";
      return send(200, { status: "ok", service: "phoenix-inspect-mcp", target: "staging only" });
    }
    if (route === "metadata") {
      if (req.method !== "GET") return refuse(405, "method_not_allowed", "method-not-allowed", { Allow: "GET" });
      record.outcome = "ok";
      return send(200, metadata);
    }
    if (authRoute && auth) return handleAuth(authRoute, req, res, url, record, send, refuse);
    if (route !== "mcp") return refuse(404, "not_found", "not-found");
    if (req.method !== "POST") return refuse(405, "method_not_allowed", "method-not-allowed", { Allow: "POST" });

    // 5. The bearer token.
    const challenge = (error, description) => ({ "WWW-Authenticate": bearerChallenge({ resourceMetadataUrl: metadataUrl, error, description }) });
    const authorization = req.headers.authorization;
    if (!authorization) {
      record.reason = "missing";
      return refuse(401, "unauthorized", "unauthenticated", challenge());
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
    if (!match) {
      record.reason = "malformed-header";
      return refuse(401, "invalid_token", "unauthenticated", challenge("invalid_token", UNAVAILABLE));
    }
    let token;
    try {
      token = await tokens.verifyAccessToken(match[1]);
    } catch (error) {
      if (error instanceof TokenError) {
        record.reason = error.reason;
        return refuse(401, "invalid_token", "unauthenticated", challenge("invalid_token", UNAVAILABLE));
      }
      record.reason = "verifier-unavailable";
      return refuse(503, "temporarily_unavailable", "error", { "Retry-After": "30" });
    }
    // The same rules again whatever the verifier (the SDK's requireBearerAuth checks these too).
    const lapsed = typeof token?.expiresAt !== "number" || !Number.isFinite(token.expiresAt) || token.expiresAt * 1000 <= now();
    const elsewhere = token?.resource !== undefined && token?.resource !== null && !sameResource(String(token.resource), resource);
    if (lapsed || elsewhere || typeof token?.subject !== "string" || token.subject.length === 0) {
      record.reason = lapsed ? "expired" : elsewhere ? "wrong-resource" : "no-subject";
      return refuse(401, "invalid_token", "unauthenticated", challenge("invalid_token", UNAVAILABLE));
    }
    record.subject = subjectHash(auditKey, token.subject);
    if (!Array.isArray(token.scopes) || !token.scopes.includes(INSPECT_SCOPE)) {
      return refuse(403, "insufficient_scope", "insufficient-scope", challenge("insufficient_scope", "The token lacks the required scope"));
    }
    // 6. Owner only (infra/phoenix-mcp/src/policy.mts): the subject must be one the environment names.
    if (!owners.has(token.subject)) return refuse(403, "access_denied", "not-owner");

    if (inflight >= maxInflight) return refuse(429, "busy", "busy", { "Retry-After": "5" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return refuse(415, "unsupported_media_type", "bad-request");
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return refuse(error.status ?? 400, error.status === 413 ? "payload_too_large" : "invalid_request", "bad-request");
    }
    const messages = Array.isArray(body) ? body : [body];
    record.rpc = messages.slice(0, 5).map((message) => (typeof message?.method === "string" && /^[a-z][a-z/_]{0,63}$/i.test(message.method) ? message.method : "other"));

    inflight += 1;
    record.outcome = "ok";
    let server = null;
    let transport = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      inflight -= 1;
      void transport?.close();
      void server?.close();
    };
    res.once("close", cleanup);
    try {
      server = await buildMcpServer(inspector, {
        // Only the inspector's validated ids and outcome; a refused call's input never reaches the log.
        observe(call) {
          for (const key of ["tool", "module", "persona", "state", "viewport", "states"]) if (call[key] !== undefined && call[key] !== null) record[key] = call[key];
          record.outcome = call.outcome;
        },
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      record.outcome = "error";
      if (!res.headersSent) send(500, { error: "unavailable" });
    } finally {
      if (res.writableEnded) cleanup();
    }
  }

  /**
   * The built-in authorization server's routes. The audit line holds the route and outcome only: never a
   * code, token, secret, state, address or redirect.
   */
  async function handleAuth(name, req, res, url, record, send, refuse) {
    const { OAuthError } = await import("./lib/authorization-server.mjs");
    const page = (status, message) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(message);
    };
    const redirect = (location) => {
      res.statusCode = 302;
      res.setHeader("Location", location);
      res.end();
    };
    const expect = (method) => {
      if (req.method === method) return true;
      refuse(405, "method_not_allowed", "method-not-allowed", { Allow: method });
      return false;
    };
    try {
      if (name === "oauth-metadata" || name === "jwks") {
        if (!expect("GET")) return;
        record.outcome = "ok";
        return send(200, name === "jwks" ? auth.jwks() : auth.metadata());
      }
      if (name === "authorize") {
        if (!expect("GET")) return;
        const location = auth.authorize(url.searchParams);
        record.outcome = new URL(location).origin === "https://accounts.google.com" ? "to-google" : "returned-error";
        return redirect(location);
      }
      if (name === "google-callback") {
        if (!expect("GET")) return;
        const { location, outcome } = await auth.googleCallback(url.searchParams);
        record.outcome = outcome;
        return redirect(location);
      }
      if (!expect("POST")) return;
      if (name === "register") {
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return refuse(415, "invalid_client_metadata", "bad-request");
        const body = await readJsonBody(req);
        record.outcome = "ok";
        return send(201, auth.register(body));
      }
      if (!/^application\/x-www-form-urlencoded\b/i.test(String(req.headers["content-type"] ?? ""))) return refuse(415, "invalid_request", "bad-request");
      const params = Object.fromEntries(new URLSearchParams(await readTextBody(req)));
      if (name === "token") {
        record.grant = params.grant_type === "refresh_token" ? "refresh_token" : params.grant_type === "authorization_code" ? "authorization_code" : "other";
        const issued = auth.token(params);
        record.outcome = "ok";
        return send(200, issued, { Pragma: "no-cache" });
      }
      auth.revoke(params);
      record.outcome = "ok";
      return send(200, {});
    } catch (error) {
      if (error instanceof OAuthError) {
        record.reason = error.code;
        // A browser leg with a bad client or redirect is shown a page, never redirected anywhere.
        if (name === "authorize" || name === "google-callback") {
          record.outcome = "refused";
          return page(400, "This sign-in request is not valid or has expired. Start again from ChatGPT.");
        }
        return refuse(error.status, error.code, "refused");
      }
      if (error?.status) return refuse(error.status, error.status === 413 ? "payload_too_large" : "invalid_request", "bad-request");
      record.outcome = "error";
      return refuse(500, "server_error", "error");
    }
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  http.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      resolve(undefined);
    });
  });
  const address = http.address();
  const bound = typeof address === "object" && address ? address.port : port;
  const urlHost = host === "::1" ? "[::1]" : host;
  for (const loopback of ["127.0.0.1", "localhost", "[::1]"]) allowedOrigins.add(`http://${loopback}:${bound}`);
  resource = publicResource ? publicResource.href : `http://${urlHost}:${bound}/mcp`;
  metadataUrl = protectedResourceMetadataUrl(resource);
  if (authorization) {
    const issuer = `http://${urlHost}:${bound}`;
    try {
      auth = authorization({ issuer, resource });
    } catch (error) {
      await new Promise((resolve) => http.close(() => resolve(undefined)));
      throw error;
    }
    metadata = protectedResourceMetadata({ resource, authorizationServer: issuer });
    tokens = auth.verifier;
  } else {
    metadata = protectedResourceMetadata({ resource, authorizationServer });
    tokens = typeof verifier === "function" ? verifier(resource) : verifier;
  }

  return {
    url: `http://${urlHost}:${bound}`,
    port: bound,
    resource,
    metadataUrl,
    close: () =>
      new Promise((resolve) => {
        http.close(() => resolve(undefined));
        http.closeAllConnections();
      }),
  };
}

async function readJsonBody(req) {
  const text = await readTextBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("not JSON"), { status: 400 });
  }
}

function readTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!failed) reject(Object.assign(error, { status: 400 }));
    });
  });
}

/**
 * The CLI's configuration from flags and the environment. Fails closed on anything missing or unsafe.
 * @param {Record<string, string|undefined>} env
 * @param {string[]} [argv]
 */
export function configFromEnv(env, argv = []) {
  // Deliberately no dotenv loader: the repository's .env.local points at production (config.mts).
  refusePrivilegedEnv(env);
  const valueAfter = (index) => (index === -1 ? undefined : argv[index + 1]);
  const portText = valueAfter(argv.indexOf("--port")) ?? "8787";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be a port number");
  const host = valueAfter(argv.indexOf("--host")) ?? "127.0.0.1";
  const publicUrl = valueAfter(argv.indexOf("--public-url")) ?? env.PHOENIX_INSPECT_MCP_PUBLIC_URL ?? null;
  const askedRunner = valueAfter(argv.indexOf("--runner"));
  const spareReady = process.platform === "win32" && existsSync(path.join(os.homedir(), ".claude", "scripts", "spare-address.ps1"));
  const runnerMode = askedRunner ?? (spareReady ? "spare" : "local");
  if (!["spare", "local"].includes(runnerMode)) throw new Error("--runner must be spare or local");
  const targetOrigin = assertTargetOrigin(env.PHOENIX_INSPECT_TARGET_ORIGIN || STAGING_ORIGIN);
  const auditKey = env.PHOENIX_INSPECT_MCP_AUDIT_KEY;
  if (auditKey !== undefined && auditKey.length < 32) throw new Error("refused: PHOENIX_INSPECT_MCP_AUDIT_KEY must be at least 32 characters");
  const shared = {
    runnerMode,
    host,
    port,
    allowNonLoopback: argv.includes("--allow-non-loopback"),
    trustProxy: argv.includes("--trust-proxy"),
    targetOrigin,
    auditKey: auditKey ?? randomBytes(32).toString("hex"),
  };

  // The built-in authorization server (the Secure MCP Tunnel path): Google proves the owner.
  if (env.PHOENIX_INSPECT_GOOGLE_CLIENT_FILE) {
    if (env.PHOENIX_INSPECT_MCP_ISSUER || env.PHOENIX_INSPECT_MCP_JWKS || env.PHOENIX_INSPECT_MCP_JWKS_URL) {
      throw new Error("refused: set either PHOENIX_INSPECT_GOOGLE_CLIENT_FILE (built-in sign-in) or an external issuer, not both");
    }
    if (publicUrl) throw new Error("refused: the built-in authorization server is loopback-only (no --public-url)");
    const ownerEmails = parseOwnerEmails(env.PHOENIX_INSPECT_MCP_OWNER_SUBJECTS);
    const file = env.PHOENIX_INSPECT_GOOGLE_CLIENT_FILE;
    if (!existsSync(file)) throw new Error("refused: the Google client file named by PHOENIX_INSPECT_GOOGLE_CLIENT_FILE does not exist");
    const google = googleClientFromJson(readFileSync(file, "utf8"));
    const stateDir = env.PHOENIX_INSPECT_MCP_STATE_DIR || defaultStateDir(env);
    const tunnelId = env.PHOENIX_INSPECT_MCP_TUNNEL_ID || null;
    if (tunnelId !== null && !/^tunnel_[a-z0-9_]{32,48}$/.test(tunnelId)) throw new Error("refused: PHOENIX_INSPECT_MCP_TUNNEL_ID is malformed");
    return {
      ...shared,
      publicUrl: null,
      ownerSubjects: ownerEmails,
      stateDir,
      /** @param {{ issuer: string, resource: string }} context */
      authorization: ({ issuer, resource }) => createAuthorizationServer({ issuer, resource, stateDir, google, ownerEmails, tunnelId }),
    };
  }

  const ownerSubjects = parseOwnerSubjects(env.PHOENIX_INSPECT_MCP_OWNER_SUBJECTS);
  const issuer = env.PHOENIX_INSPECT_MCP_ISSUER;
  if (!issuer) throw new Error("refused: PHOENIX_INSPECT_MCP_ISSUER is not set");
  httpsUrl(issuer, "PHOENIX_INSPECT_MCP_ISSUER");
  const keys = env.PHOENIX_INSPECT_MCP_JWKS ? keysFromJwks(env.PHOENIX_INSPECT_MCP_JWKS) : [];
  const jwksUrl = env.PHOENIX_INSPECT_MCP_JWKS_URL || null;
  if (keys.length === 0 && !jwksUrl) throw new Error("refused: set PHOENIX_INSPECT_MCP_JWKS or PHOENIX_INSPECT_MCP_JWKS_URL");
  const clientId = env.PHOENIX_INSPECT_MCP_CLIENT_ID || null;
  // Build one verifier now so a bad JWKS address refuses before the port opens.
  createJwtVerifier({ issuer, audience: "https://check.invalid/mcp", keys, jwksUrl, clientId });
  return {
    ...shared,
    publicUrl,
    ownerSubjects,
    authorizationServer: issuer,
    /** @param {string} resource */
    verifier: (resource) => createJwtVerifier({ issuer, audience: resource, keys, jwksUrl, clientId }),
  };
}

/** Where the built-in authorization server keeps its clients, grants and signing key: outside the repository. */
export function defaultStateDir(env) {
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "PhoenixInspect", "oauth");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--revoke-all")) {
    // The owner's kill switch: every token the built-in authorization server issued stops at once.
    const stateDir = process.env.PHOENIX_INSPECT_MCP_STATE_DIR || defaultStateDir(process.env);
    const count = revokeAllGrants(stateDir);
    console.error(`revoked ${count} live sign-in(s); ChatGPT must sign in again`);
    return;
  }
  const config = configFromEnv(process.env, argv);
  const runner = config.runnerMode === "spare" ? spareRunner() : localRunner();
  const handle = await startHttpServer({ ...config, runner });
  console.error(`phoenix-inspect MCP ready (Streamable HTTP on ${handle.url}/mcp, resource ${handle.resource}, runner: ${config.runnerMode}, target: staging only)`);
  const stop = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
