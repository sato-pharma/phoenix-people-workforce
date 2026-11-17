import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";

import { createAuthorizationServer, googleClientFromJson, isChatGptRedirect, parseOwnerEmails, revokeAllGrants } from "../scripts/phoenix-inspect/lib/authorization-server.mjs";
import { INSPECT_SCOPE } from "../scripts/phoenix-inspect/lib/oauth.mjs";
import { TUNNEL_CALL_LIMITS, configFromEnv, startHttpServer } from "../scripts/phoenix-inspect/mcp-http.mjs";
import { createInspector } from "../scripts/phoenix-inspect/mcp-server.mjs";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: Record<string, unknown> | null };

// Made-up identities: the repository is public, so no real address, client or tunnel appears here.
const OWNER = "owner@example.test";
const STRANGER = "stranger@example.test";
const GOOGLE = { clientId: "000000000000-test.apps.googleusercontent.com", clientSecret: "test-google-secret-not-real" };
const TUNNEL = `tunnel_${"a".repeat(32)}`;
const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function raw(base: string, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(base);
    const req = request({ hostname: target.hostname, port: target.port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown> | null = null;
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

/**
 * Phoenix Visual Intelligence, the ChatGPT connection: the inspector's built-in authorization server —
 * the Secure MCP Tunnel's supported topology (a local authorization server on the MCP server's own
 * loopback origin) with Google as the owner's identity check. Driven end to end on an ephemeral loopback
 * port with a fake Google and a fake runner: no browser, no network beyond 127.0.0.1.
 * It proves: the metadata ChatGPT and the tunnel read; dynamic registration only for ChatGPT's redirect
 * URIs; the browser leg never forwards ChatGPT's `resource` to Google and never redirects to an
 * unregistered address; Google's identity must be verified, fresh, nonce-bound and an OWNER address;
 * codes are single-use and PKCE-bound; the access token opens exactly the nine tools; refresh rotates
 * and a replayed refresh token revokes the grant; the kill switch stops every token at once; one call
 * captures one page under a hard time limit and a result-size cap; the audit log holds no code, token,
 * secret or address.
 */
export async function runPhoenixInspectAuthorizationServerTests() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phoenix-inspect-as-"));
  const servers: { close: () => Promise<void> }[] = [];
  try {
    // ── 1. Pure helpers ──────────────────────────────────────────────────────────────────────────
    assert.ok(isChatGptRedirect(CHATGPT));
    assert.ok(isChatGptRedirect("https://chatgpt.com/connector/oauth/abc_DEF-123"));
    for (const bad of ["https://chatgpt.com.evil.test/connector_platform_oauth_redirect", "http://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/x/../../steal", "https://evil.test/cb"]) {
      assert.ok(!isChatGptRedirect(bad), `${bad} is not a ChatGPT redirect`);
    }
    assert.deepEqual([...parseOwnerEmails(" Owner@Example.test ")], [OWNER]);
    assert.throws(() => parseOwnerEmails(""), /no owner address/);
    assert.throws(() => parseOwnerEmails("not an email"), /malformed/);
    assert.deepEqual(googleClientFromJson(JSON.stringify({ installed: { client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret } })), GOOGLE);
    assert.throws(() => googleClientFromJson(JSON.stringify({ installed: { client_id: "x", client_secret: "y" } })), /not a Google OAuth client id/);
    assert.throws(() => googleClientFromJson("{}"), /no client_id/);

    // ── 2. Configuration ─────────────────────────────────────────────────────────────────────────
    const clientFile = path.join(dir, "google-client.json");
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret } }));
    const asEnv = { PHOENIX_INSPECT_MCP_OWNER_SUBJECTS: OWNER, PHOENIX_INSPECT_GOOGLE_CLIENT_FILE: clientFile, PHOENIX_INSPECT_MCP_STATE_DIR: path.join(dir, "config-state"), PHOENIX_INSPECT_MCP_TUNNEL_ID: TUNNEL };
    const config = configFromEnv(asEnv, ["--runner", "local"]);
    assert.ok("authorization" in config && typeof config.authorization === "function", "a Google client file selects the built-in authorization server");
    assert.deepEqual([...config.ownerSubjects], [OWNER]);
    assert.throws(() => configFromEnv({ ...asEnv, PHOENIX_INSPECT_MCP_ISSUER: "https://auth.example.test" }), /not both/);
    assert.throws(() => configFromEnv({ ...asEnv, PHOENIX_INSPECT_GOOGLE_CLIENT_FILE: path.join(dir, "absent.json") }), /does not exist/);
    assert.throws(() => configFromEnv({ ...asEnv, PHOENIX_INSPECT_MCP_TUNNEL_ID: "tunnel_x" }), /malformed/);
    assert.throws(() => configFromEnv(asEnv, ["--public-url", "https://inspect.example.test/mcp"]), /loopback-only/);
    assert.throws(() => configFromEnv({ ...asEnv, SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key" }), /privileged/);

    // ── 3. The server, with a fake Google ────────────────────────────────────────────────────────
    let googleIdentity: Record<string, unknown> = {};
    let googleFails = false;
    const googleCalls: Record<string, string>[] = [];
    const fakeGoogle = async (url: string, init: Record<string, unknown>) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      const params = Object.fromEntries(new URLSearchParams(String(init.body)));
      googleCalls.push(params);
      if (googleFails) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      const idToken = `${b64({ alg: "RS256" })}.${b64(googleIdentity)}.${randomBytes(16).toString("base64url")}`;
      return { ok: true, status: 200, json: async () => ({ access_token: "google-access-not-used", id_token: idToken }) };
    };
    const runs: Record<string, unknown>[] = [];
    // A real picture: the inspector re-encodes each one as a JPEG preview, so a file that only starts like a PNG is left out.
    const picture = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const runner = async (options: Record<string, unknown>) => {
      runs.push(options);
      const outDir = path.join(dir, "runs", String(options.runId));
      mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const shots = [0, 1, 2].map((i) => {
        writeFileSync(path.join(outDir, "shots", `${i}.png`), picture);
        return { id: `00${i}`, state: "summary", viewport: "desktop", outcome: "captured", image: `shots/${i}.png` };
      });
      return { outDir, manifest: { runId: options.runId, totals: { captured: 3 }, personas: ["ceo"], shots, denied: [], notRun: [] } };
    };
    const stateDir = path.join(dir, "state");
    const auditFile = path.join(dir, "audit.jsonl");
    const authorization = ({ issuer, resource }: { issuer: string; resource: string }) =>
      createAuthorizationServer({ issuer, resource, stateDir, google: GOOGLE, ownerEmails: new Set([OWNER]), tunnelId: TUNNEL, fetchImpl: fakeGoogle as never });
    await assert.rejects(startHttpServer({ runner, ownerSubjects: [OWNER], authorization, repoRoot: dir, auditFile, publicUrl: "https://inspect.example.test/mcp" }), /loopback-only/);
    const a = await startHttpServer({ runner, ownerSubjects: [OWNER], authorization, repoRoot: dir, auditFile });
    servers.push(a);
    const issuer = a.url;

    const prmd = await raw(a.url, "GET", "/.well-known/oauth-protected-resource/mcp", {});
    assert.deepEqual(prmd.json?.authorization_servers, [issuer], "PRMD names the built-in authorization server");
    const meta = await raw(a.url, "GET", "/.well-known/oauth-authorization-server", {});
    assert.equal(meta.status, 200);
    assert.equal(meta.json?.issuer, issuer);
    assert.deepEqual(meta.json?.code_challenge_methods_supported, ["S256"], "ChatGPT refuses a server without S256");
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint", "jwks_uri"]) {
      assert.ok(String(meta.json?.[key]).startsWith(`${issuer}/`), `${key} is on the loopback origin`);
    }
    const jwks = await raw(a.url, "GET", "/jwks", {});
    const keys = jwks.json?.keys as Record<string, unknown>[];
    assert.equal(keys.length, 1);
    assert.ok(!("d" in keys[0]), "the JWKS holds the public key only");

    // Dynamic registration: ChatGPT's redirect URIs only.
    const badRegistration = await raw(a.url, "POST", "/register", { "content-type": "application/json" }, JSON.stringify({ redirect_uris: ["https://evil.test/cb"] }));
    assert.equal(badRegistration.status, 400);
    assert.equal(badRegistration.json?.error, "invalid_redirect_uri");
    const registered = await raw(a.url, "POST", "/register", { "content-type": "application/json" }, JSON.stringify({ redirect_uris: [CHATGPT], client_name: "ChatGPT", token_endpoint_auth_method: "client_secret_post" }));
    assert.equal(registered.status, 201, registered.body);
    const clientId = String(registered.json?.client_id);
    const clientSecret = String(registered.json?.client_secret);
    assert.match(clientId, /^pi_/);
    assert.ok(clientSecret.length >= 40);

    // The browser leg.
    const authorize = (overrides: Record<string, string> = {}) => {
      const verifier = randomBytes(40).toString("base64url");
      const params = { response_type: "code", client_id: clientId, redirect_uri: CHATGPT, state: "chatgpt-state-1", code_challenge: s256(verifier), code_challenge_method: "S256", scope: INSPECT_SCOPE, resource: a.resource, ...overrides };
      return raw(a.url, "GET", `/authorize?${form(params)}`, {}).then((reply) => ({ reply, verifier }));
    };
    const unregistered = await authorize({ redirect_uri: "https://chatgpt.com/connector/oauth/other" });
    assert.equal(unregistered.reply.status, 400, "a redirect URI the client did not register gets a page");
    assert.equal(unregistered.reply.headers.location, undefined, "and is never redirected to");
    const unknownClient = await authorize({ client_id: "pi_nobody" });
    assert.equal(unknownClient.reply.status, 400);
    const plain = await authorize({ code_challenge_method: "plain" });
    assert.equal(new URL(String(plain.reply.headers.location)).searchParams.get("error"), "invalid_request", "PKCE plain is refused");
    const foreign = await authorize({ resource: "https://other.example.test/mcp" });
    assert.equal(new URL(String(foreign.reply.headers.location)).searchParams.get("error"), "invalid_target", "a foreign resource is refused");
    const wideScope = await authorize({ scope: `${INSPECT_SCOPE} admin` });
    assert.equal(new URL(String(wideScope.reply.headers.location)).searchParams.get("error"), "invalid_scope");
    const viaTunnel = await authorize({ resource: `https://tunnels.example.test/${TUNNEL}/mcp` });
    assert.equal(new URL(String(viaTunnel.reply.headers.location)).origin, "https://accounts.google.com", "the tunnel's rewrite of the resource is accepted");

    const signIn = async (identity: (nonce: string) => Record<string, unknown>) => {
      const { reply, verifier } = await authorize();
      assert.equal(reply.status, 302);
      const toGoogle = new URL(String(reply.headers.location));
      assert.equal(toGoogle.origin + toGoogle.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
      assert.equal(toGoogle.searchParams.get("client_id"), GOOGLE.clientId);
      assert.equal(toGoogle.searchParams.get("redirect_uri"), `${issuer}/oauth/google/callback`);
      assert.equal(toGoogle.searchParams.get("scope"), "openid email");
      assert.equal(toGoogle.searchParams.get("code_challenge_method"), "S256");
      assert.equal(toGoogle.searchParams.get("resource"), null, "ChatGPT's resource never reaches Google (Google refuses it)");
      assert.notEqual(toGoogle.searchParams.get("state"), "chatgpt-state-1", "Google gets its own state");
      googleIdentity = identity(String(toGoogle.searchParams.get("nonce")));
      const back = await raw(a.url, "GET", `/oauth/google/callback?${form({ state: String(toGoogle.searchParams.get("state")), code: "google-code-1" })}`, {});
      assert.equal(back.status, 302);
      const toChatGpt = new URL(String(back.headers.location));
      assert.equal(toChatGpt.origin + toChatGpt.pathname, CHATGPT);
      assert.equal(toChatGpt.searchParams.get("state"), "chatgpt-state-1");
      assert.equal(toChatGpt.searchParams.get("iss"), issuer, "RFC 9207 iss travels on the response");
      return { toChatGpt, verifier };
    };
    const seconds = () => Math.floor(Date.now() / 1000);
    const google = (nonce: string, extra: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: GOOGLE.clientId, sub: "1234567890", email: OWNER, email_verified: true, nonce, iat: seconds(), exp: seconds() + 300, ...extra });

    for (const [label, identity] of [
      ["someone who is not the owner", (nonce: string) => google(nonce, { email: STRANGER })],
      ["an unverified address", (nonce: string) => google(nonce, { email_verified: false })],
      ["another nonce", () => google("replayed-nonce")],
      ["another Google client", (nonce: string) => google(nonce, { aud: "999-other.apps.googleusercontent.com" })],
      ["an expired identity", (nonce: string) => google(nonce, { exp: seconds() - 10 })],
      ["another issuer", (nonce: string) => google(nonce, { iss: "https://evil.test" })],
    ] as const) {
      const { toChatGpt } = await signIn(identity);
      assert.equal(toChatGpt.searchParams.get("error"), "access_denied", `${label} is denied`);
      assert.equal(toChatGpt.searchParams.get("code"), null, label);
    }
    const lastExchange = googleCalls.at(-1) ?? {};
    assert.equal(lastExchange.client_secret, GOOGLE.clientSecret);
    assert.match(lastExchange.code_verifier ?? "", /^[A-Za-z0-9_-]{43,}$/, "the Google exchange is PKCE-bound");
    googleFails = true;
    const failed = await signIn((nonce) => google(nonce));
    assert.equal(failed.toChatGpt.searchParams.get("error"), "server_error");
    googleFails = false;
    const replayedState = await raw(a.url, "GET", `/oauth/google/callback?${form({ state: "made-up", code: "x" })}`, {});
    assert.equal(replayedState.status, 400, "an unknown sign-in is a page, not a redirect");

    // The token endpoint.
    const token = (params: Record<string, string>) => raw(a.url, "POST", "/token", FORM, form({ client_id: clientId, client_secret: clientSecret, resource: a.resource, ...params }));
    const first = await signIn((nonce) => google(nonce));
    const code1 = String(first.toChatGpt.searchParams.get("code"));
    const wrongVerifier = await token({ grant_type: "authorization_code", code: code1, redirect_uri: CHATGPT, code_verifier: randomBytes(40).toString("base64url") });
    assert.equal(wrongVerifier.json?.error, "invalid_grant", "a wrong PKCE verifier is refused");
    const reused = await token({ grant_type: "authorization_code", code: code1, redirect_uri: CHATGPT, code_verifier: first.verifier });
    assert.equal(reused.json?.error, "invalid_grant", "a code is spent even by a failed exchange");
    const second = await signIn((nonce) => google(nonce));
    const code2 = String(second.toChatGpt.searchParams.get("code"));
    const wrongSecret = await raw(a.url, "POST", "/token", FORM, form({ client_id: clientId, client_secret: "wrong", grant_type: "authorization_code", code: code2, redirect_uri: CHATGPT, code_verifier: second.verifier }));
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongSecret.json?.error, "invalid_client");
    const third = await signIn((nonce) => google(nonce));
    const issued = await token({ grant_type: "authorization_code", code: String(third.toChatGpt.searchParams.get("code")), redirect_uri: CHATGPT, code_verifier: third.verifier });
    assert.equal(issued.status, 200, issued.body);
    const access = String(issued.json?.access_token);
    const refresh = String(issued.json?.refresh_token);
    assert.equal(issued.json?.token_type, "Bearer");
    assert.equal(issued.json?.expires_in, 3600);
    const claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims.aud, a.resource, "the access token's audience is the local resource");
    assert.equal(claims.sub, OWNER);
    assert.equal(claims.scope, INSPECT_SCOPE);

    // The token opens exactly the nine tools; one call captures one page and returns one image.
    let rpc = 0;
    const mcp = (bearer: string, method: string, params: Record<string, unknown> = {}) =>
      raw(a.url, "POST", "/mcp", { ...MCP_HEADERS, authorization: `Bearer ${bearer}` }, JSON.stringify({ jsonrpc: "2.0", id: (rpc += 1), method, params }));
    const listed = await mcp(access, "tools/list");
    assert.equal(listed.status, 200, listed.body);
    assert.equal(((listed.json?.result as { tools: unknown[] }).tools).length, 9);
    const opened = await mcp(access, "tools/call", { name: "phoenix_open_module", arguments: { module: "kpi-reports", persona: "ceo" } });
    const openedResult = opened.json?.result as { isError?: boolean; content: { type: string }[] };
    assert.ok(!openedResult.isError, opened.body);
    assert.equal(openedResult.content.filter((item) => item.type === "image").length, 1, "through the tunnel one call returns one screenshot");
    assert.equal(runs.at(-1)?.maxMinutes, TUNNEL_CALL_LIMITS.minutes, "the runner gets the tunnel's time limit");
    assert.ok(runs.at(-1)?.signal instanceof AbortSignal, "and a signal that can stop it");
    const twoPages = await mcp(access, "tools/call", { name: "phoenix_capture_page", arguments: { module: "kpi-reports", persona: "ceo", states: ["summary"], viewports: ["desktop", "mobile"] } });
    assert.match(JSON.stringify(twoPages.json), /at most 1/, "two pages in one call are refused");

    // Refresh rotates; a replayed refresh token revokes the grant and its access tokens.
    const rotated = await token({ grant_type: "refresh_token", refresh_token: refresh });
    assert.equal(rotated.status, 200, rotated.body);
    assert.notEqual(rotated.json?.refresh_token, refresh);
    const rotatedAccess = String(rotated.json?.access_token);
    assert.equal((await mcp(rotatedAccess, "tools/list")).status, 200);
    const replay = await token({ grant_type: "refresh_token", refresh_token: refresh });
    assert.equal(replay.json?.error, "invalid_grant");
    const afterReplay = await mcp(rotatedAccess, "tools/list");
    assert.equal(afterReplay.status, 401, "a replayed refresh token revokes the whole grant at once");
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: String(rotated.json?.refresh_token) })).json?.error, "invalid_grant");

    // /revoke, and the kill switch from another process.
    const fourth = await signIn((nonce) => google(nonce));
    const issued4 = await token({ grant_type: "authorization_code", code: String(fourth.toChatGpt.searchParams.get("code")), redirect_uri: CHATGPT, code_verifier: fourth.verifier });
    const access4 = String(issued4.json?.access_token);
    assert.equal((await mcp(access4, "tools/list")).status, 200);
    const revoked = await raw(a.url, "POST", "/revoke", FORM, form({ client_id: clientId, client_secret: clientSecret, token: String(issued4.json?.refresh_token) }));
    assert.equal(revoked.status, 200);
    assert.equal((await mcp(access4, "tools/list")).status, 401, "a revoked grant's access token stops at once");
    const fifth = await signIn((nonce) => google(nonce));
    const issued5 = await token({ grant_type: "authorization_code", code: String(fifth.toChatGpt.searchParams.get("code")), redirect_uri: CHATGPT, code_verifier: fifth.verifier });
    const access5 = String(issued5.json?.access_token);
    assert.equal((await mcp(access5, "tools/list")).status, 200);
    assert.equal(revokeAllGrants(stateDir), 1, "the kill switch names the one live sign-in");
    assert.equal((await mcp(access5, "tools/list")).status, 401, "the kill switch stops every token without a restart");

    // ── 4. The audit log and the state file hold no secret ──────────────────────────────────────
    for (const server of servers.splice(0)) await server.close();
    const auditText = readFileSync(auditFile, "utf8");
    const stateText = readFileSync(path.join(stateDir, "oauth-state.json"), "utf8");
    for (const secret of [access, refresh, rotatedAccess, access4, access5, clientSecret, code1, code2, GOOGLE.clientSecret, "google-code-1", OWNER, STRANGER, "chatgpt-state-1", CHATGPT]) {
      assert.ok(!auditText.includes(secret), "the audit log holds no code, token, secret, state, redirect or address");
    }
    for (const secret of [access, refresh, clientSecret, GOOGLE.clientSecret]) assert.ok(!stateText.includes(secret), "the state file holds hashes, never a token or secret");
    const lines = auditText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.some((line) => line.route === "google-callback" && line.outcome === "not-owner"));
    assert.ok(lines.some((line) => line.route === "token" && line.reason === "invalid_grant"));
    assert.ok(lines.some((line) => line.route === "mcp" && line.reason === "revoked"));

    // ── 5. The hard time limit and the result-size cap ──────────────────────────────────────────
    let sawAbort = false;
    let release: () => void = () => {};
    const stuck = createInspector({
      runner: (options: Record<string, unknown>) =>
        new Promise((_, reject) => {
          const signal = options.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            sawAbort = true;
            release = () => reject(new Error("browser closed"));
          });
        }),
      repoRoot: dir,
      auditFile: null,
      callLimits: { pages: 1, minutes: 0.002 },
    });
    const late = (await stuck.call("phoenix_open_module", { module: "kpi-reports", persona: "ceo" })) as { isError?: boolean; content: { text?: string }[] };
    assert.equal(late.isError, true);
    assert.match(late.content[0].text ?? "", /stopped at its 0-second limit|stopped at its \d+-second limit/);
    assert.ok(sawAbort, "the runner is told to stop at the limit");
    const busy = (await stuck.call("phoenix_open_module", { module: "kpi-reports", persona: "ceo" })) as { isError?: boolean; content: { text?: string }[] };
    assert.match(busy.content[0].text ?? "", /another capture is already running/, "no second capture starts while the first is still stopping");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Three noise pictures whose JPEG previews are about 30 KB (about 40 KB each once base64-encoded)
    // against a 100 KB cap: one is dropped. Noise, because a flat picture compresses to almost nothing.
    const noise = () => sharp(randomBytes(260 * 260 * 3), { raw: { width: 260, height: 260, channels: 3 } }).png().toBuffer();
    const noisy = [await noise(), await noise(), await noise()];
    const bigRunner = async (options: Record<string, unknown>) => {
      const outDir = path.join(dir, "runs", `big-${String(options.runId)}`);
      mkdirSync(path.join(outDir, "shots"), { recursive: true });
      const shots = [0, 1, 2].map((i) => {
        writeFileSync(path.join(outDir, "shots", `${i}.png`), noisy[i]);
        return { id: `00${i}`, state: "summary", viewport: "desktop", outcome: "captured", image: `shots/${i}.png` };
      });
      return { outDir, manifest: { runId: options.runId, totals: { captured: 3 }, personas: ["ceo"], shots, denied: [], notRun: [] } };
    };
    const small = createInspector({ runner: bigRunner, repoRoot: dir, auditFile: null, maxResultBytes: 100_000 });
    const fitted = (await small.call("phoenix_open_module", { module: "kpi-reports", persona: "ceo" })) as { content: { type: string; text?: string }[] };
    assert.equal(fitted.content.filter((item) => item.type === "image").length, 2, "the last screenshot is dropped until the result fits");
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 100_000 + 2_000, "and the result is under the cap");
    assert.match(fitted.content.at(-1)?.text ?? "", /left out to fit/);
  } finally {
    for (const server of servers) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
