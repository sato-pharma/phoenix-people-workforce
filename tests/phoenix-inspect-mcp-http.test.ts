import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";

import { INSPECT_SCOPE, createJwtVerifier, keyFromJwk } from "../scripts/phoenix-inspect/lib/oauth.mjs";
import { STAGING_ORIGIN } from "../scripts/phoenix-inspect/lib/fence.mjs";
import { RUN_BOUNDS } from "../scripts/phoenix-inspect/lib/safety.mjs";
import { configFromEnv, startHttpServer } from "../scripts/phoenix-inspect/mcp-http.mjs";
import { MAX_IMAGES_PER_RESULT, PREVIEW } from "../scripts/phoenix-inspect/mcp-server.mjs";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { isError?: boolean; content: Content[]; structuredContent?: unknown };
type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: Record<string, unknown> | null };

const TOOLS = [
  "phoenix_list_portals_and_modules",
  "phoenix_list_module_pages",
  "phoenix_open_module",
  "phoenix_capture_page",
  "phoenix_inspect_ui_state",
  "phoenix_get_capture",
  "phoenix_get_component_map",
  "phoenix_get_visual_audit",
  "phoenix_get_implementation_plan",
];
// Made-up identities: the repository is public, so no real subject, name or address appears here.
const ISSUER = "https://auth.example.test";
const OWNER = "owner-subject-0001";
const STRANGER = "someone-else-0002";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** One HTTP request with full control of Host and Origin (fetch forbids some of them). */
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

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function es256(claims: Record<string, unknown>, key: KeyObject, header: Record<string, unknown> = { alg: "ES256", typ: "at+jwt", kid: "k1" }) {
  const data = `${encode(header)}.${encode(claims)}`;
  return `${data}.${sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/**
 * Phoenix Visual Intelligence: the Streamable HTTP door of the inspector MCP server is an OAuth resource
 * server for the OWNER only. Without a token it answers 401 with the RFC 9728 metadata link; an expired,
 * wrong-audience, wrong-issuer, foreign-signed, unsigned or algorithm-confused token is 401; a valid token
 * for anyone else is 403. The owner gets exactly the nine tools, masked JPEG previews beside
 * structuredContent, the same ids-only refusals as stdio, one capture at a time and the rate limits. It
 * refuses to start against production, on a public interface without an https URL, or with trust-proxy
 * and no public URL; it refuses a foreign Host or Origin; and its audit log holds no token or raw subject.
 * Driven with a fake runner on an ephemeral loopback port: no browser, no network beyond 127.0.0.1.
 */
export async function runPhoenixInspectMcpHttpTests() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "phoenix-inspect-mcp-http-"));
  const servers: { close: () => Promise<void> }[] = [];
  try {
    let clock = Date.parse("2026-11-14T18:00:00Z");
    const ownerPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const strangerPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = { ...ownerPair.publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
    const verificationKey = keyFromJwk(publicJwk);
    const verifierFor = (resource: string) => createJwtVerifier({ issuer: ISSUER, audience: resource, keys: [verificationKey], now: () => clock });

    const runs: Record<string, unknown>[] = [];
    let hold: Promise<void> | null = null;
    const picture = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const runner = async (options: Record<string, unknown>) => {
      runs.push(options);
      if (hold) await hold;
      const outDir = path.join(dir, "runs", String(options.runId));
      mkdirSync(path.join(outDir, "shots"), { recursive: true });
      // Listed first, so a missing check would pick them: a shot whose privacy check failed (its file left
      // behind) and a "captured" shot whose file is not a PNG.
      writeFileSync(path.join(outDir, "shots", "leaky.png"), Buffer.concat([PNG, Buffer.from("LEAKY-UNMASKED")]));
      writeFileSync(path.join(outDir, "shots", "notpng.png"), Buffer.from("aria: not a picture at all"));
      const shots: Record<string, unknown>[] = [
        { id: "leaky", state: "summary", viewport: "desktop", outcome: "deleted-privacy-check-failed", image: "shots/leaky.png" },
        { id: "notpng", state: "summary", viewport: "desktop", outcome: "captured", image: "shots/notpng.png" },
      ];
      for (let i = 0; i < 6; i += 1) {
        const image = `shots/${i}.png`;
        writeFileSync(path.join(outDir, image), picture);
        shots.push({ id: `00${i}`, state: "summary", viewport: "desktop", outcome: "captured", image, writesStopped: [], console: [] });
      }
      return { outDir, manifest: { runId: options.runId, totals: { captured: 6 }, personas: ["dm"], shots, denied: [], notRun: [] } };
    };
    const auditFile = path.join(dir, "http-audit.jsonl");
    const common = { runner, verifier: verifierFor, ownerSubjects: [OWNER], authorizationServer: ISSUER, repoRoot: dir, now: () => clock, auditFile };

    // ── 1. Refused before any port opens ─────────────────────────────────────────────────────────
    await assert.rejects(startHttpServer({ ...common, targetOrigin: "https://phoenix-hr.satopharma.com" }), /production host/);
    await assert.rejects(startHttpServer({ ...common, host: "0.0.0.0" }), /loopback only/);
    await assert.rejects(startHttpServer({ ...common, host: "0.0.0.0", allowNonLoopback: true }), /loopback only/, "the flag alone is not enough");
    await assert.rejects(startHttpServer({ ...common, host: "0.0.0.0", allowNonLoopback: true, publicUrl: "http://inspect.example.test/mcp" }), /https URL/);
    await assert.rejects(startHttpServer({ ...common, publicUrl: "https://inspect.example.test/other" }), /must end in \/mcp/);
    await assert.rejects(startHttpServer({ ...common, trustProxy: true }), /needs an https --public-url/);
    await assert.rejects(startHttpServer({ ...common, ownerSubjects: [] }), /no owner subject/);

    const goodEnv = { PHOENIX_INSPECT_MCP_OWNER_SUBJECTS: OWNER, PHOENIX_INSPECT_MCP_ISSUER: ISSUER, PHOENIX_INSPECT_MCP_JWKS: JSON.stringify({ keys: [publicJwk] }) };
    const config = configFromEnv(goodEnv, ["--runner", "local"]);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.targetOrigin, STAGING_ORIGIN);
    assert.deepEqual([...config.ownerSubjects], [OWNER]);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_TARGET_ORIGIN: "https://phoenix-hr.satopharma.com" }), /production host/);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_MCP_OWNER_SUBJECTS: "" }), /no owner subject/);
    assert.throws(() => configFromEnv({ ...goodEnv, SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key" }), /privileged/);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_MCP_JWKS: JSON.stringify({ keys: [{ ...ownerPair.privateKey.export({ format: "jwk" }), alg: "ES256" }] }) }), /public keys only/);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_MCP_JWKS: undefined, PHOENIX_INSPECT_MCP_JWKS_URL: "http://auth.example.test/jwks.json" }), /https URL/);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_MCP_JWKS: undefined, PHOENIX_INSPECT_MCP_JWKS_URL: "https://elsewhere.example.test/jwks.json" }), /issuer's own origin/);
    assert.throws(() => configFromEnv({ ...goodEnv, PHOENIX_INSPECT_MCP_JWKS: undefined }), /JWKS/);

    // ── 2. The loopback server ───────────────────────────────────────────────────────────────────
    const a = await startHttpServer(common);
    servers.push(a);
    assert.equal(a.resource, `http://127.0.0.1:${a.port}/mcp`);
    assert.equal(a.metadataUrl, `http://127.0.0.1:${a.port}/.well-known/oauth-protected-resource/mcp`);
    const issued: string[] = [];
    const seconds = () => Math.floor(clock / 1000);
    const token = (overrides: Record<string, unknown> = {}, key: KeyObject = ownerPair.privateKey, header?: Record<string, unknown>) => {
      const claims = { iss: ISSUER, aud: a.resource, sub: OWNER, scope: INSPECT_SCOPE, iat: seconds(), exp: seconds() + 300, ...overrides };
      const value = es256(claims, key, header);
      issued.push(value);
      return value;
    };
    let rpcId = 0;
    const mcp = (bearer: string | null, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}, base: string = a.url) =>
      raw(base, "POST", "/mcp", { ...MCP_HEADERS, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra }, JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }));
    const resultOf = (reply: Reply) => (reply.json?.result ?? null) as Result;

    for (const route of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const meta = await raw(a.url, "GET", route, {});
      assert.equal(meta.status, 200, `${route} is served`);
      assert.equal(meta.json?.resource, a.resource);
      assert.deepEqual(meta.json?.authorization_servers, [ISSUER]);
      assert.ok((meta.json?.scopes_supported as string[]).includes(INSPECT_SCOPE));
    }

    const bare = await mcp(null, "tools/list");
    assert.equal(bare.status, 401, "no token: 401");
    const bareChallenge = String(bare.headers["www-authenticate"] ?? "");
    assert.match(bareChallenge, /^Bearer /);
    assert.ok(bareChallenge.includes(`resource_metadata="${a.metadataUrl}"`), bareChallenge);
    assert.doesNotMatch(bareChallenge, /error=/, "a request without a token gets no error code (RFC 6750 section 3.1)");

    const now = seconds();
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ iss: ISSUER, aud: a.resource, sub: OWNER, scope: INSPECT_SCOPE, iat: now, exp: now + 300 })}.`;
    const publicPem = ownerPair.publicKey.export({ format: "pem", type: "spki" });
    const hsData = `${encode({ alg: "HS256", typ: "JWT", kid: "k1" })}.${encode({ iss: ISSUER, aud: a.resource, sub: OWNER, scope: INSPECT_SCOPE, iat: now, exp: now + 300 })}`;
    const confused = `${hsData}.${createHmac("sha256", publicPem).update(hsData).digest("base64url")}`;
    issued.push(unsigned, confused);
    const refusedTokens: [string, string, string][] = [
      ["an expired token", token({ iat: now - 600, exp: now - 1 }), "expired"],
      ["a token for another resource", token({ aud: "https://other.example.test/mcp" }), "wrong-audience"],
      ["a token from another issuer", token({ iss: "https://issuer.example.test" }), "wrong-issuer"],
      ["a token signed by another key", token({}, strangerPair.privateKey), "bad-signature"],
      ["an unsigned token (alg none)", unsigned, "unsupported-algorithm"],
      ["an HS256 token keyed with the public key", confused, "unknown-key"],
      ["a token living longer than an hour", token({ exp: now + 7_200 }), "lifetime-too-long"],
    ];
    for (const [label, value] of refusedTokens) {
      const reply = await mcp(value, "tools/list");
      assert.equal(reply.status, 401, `${label} is refused with 401`);
      const challenge = String(reply.headers["www-authenticate"] ?? "");
      assert.match(challenge, /error="invalid_token"/, label);
      assert.ok(challenge.includes(`resource_metadata="${a.metadataUrl}"`), label);
    }
    const wrongScheme = await raw(a.url, "POST", "/mcp", { ...MCP_HEADERS, authorization: `Basic ${Buffer.from("a:b").toString("base64")}` }, "{}");
    assert.equal(wrongScheme.status, 401);

    const stranger = await mcp(token({ sub: STRANGER }), "tools/list");
    assert.equal(stranger.status, 403, "a valid token for someone who is not the owner: 403");
    assert.equal(stranger.json?.error, "access_denied");
    const noScope = await mcp(token({ scope: "phoenix:read" }), "tools/list");
    assert.equal(noScope.status, 403, "the data service's scope does not open the inspector");
    assert.match(String(noScope.headers["www-authenticate"] ?? ""), /error="insufficient_scope"/);

    // The owner: exactly the nine tools, all read-only.
    const listed = await mcp(token(), "tools/list");
    assert.equal(listed.status, 200, listed.body);
    const tools = (listed.json?.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      TOOLS,
    );
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

    // A real MCP client over Streamable HTTP: list, then capture — masked JPEG previews and structuredContent.
    const client = new Client({ name: "phoenix-inspect-http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(a.resource), { requestInit: { headers: { Authorization: `Bearer ${token()}` } } }));
    try {
      const viaClient = await client.listTools();
      assert.deepEqual(viaClient.tools.map((tool) => tool.name).sort(), [...TOOLS].sort());
      const captured = (await client.callTool({ name: "phoenix_capture_page", arguments: { module: "kpi-reports", persona: "dm", states: ["summary"], viewports: ["desktop"] } })) as unknown as Result;
      assert.ok(!captured.isError, JSON.stringify(captured.content?.[0]));
      const images = captured.content.filter((item) => item.type === "image");
      assert.equal(images.length, MAX_IMAGES_PER_RESULT, "at most four images per result");
      for (const image of images) {
        assert.equal(image.mimeType, "image/jpeg", "a picture travels as a small JPEG preview");
        const bytes = Buffer.from(image.data ?? "", "base64");
        assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "the preview is a JPEG");
        assert.ok(!bytes.includes("LEAKY-UNMASKED"), "a shot whose privacy check failed is never sent");
      }
      assert.deepEqual(captured.structuredContent, JSON.parse(captured.content[0].text ?? "null"), "the summary also travels as structuredContent");
    } finally {
      await client.close();
    }
    assert.equal(runs.length, 1);

    // The ids-only refusals hold over HTTP.
    const urlAsId = resultOf(await mcp(token(), "tools/call", { name: "phoenix_open_module", arguments: { module: "https://phoenix-hr.satopharma.com/admin/kpis", persona: "ceo" } }));
    assert.equal(urlAsId.isError, true, "a URL where a module id belongs is refused");
    assert.match(urlAsId.content[0].text ?? "", /refused/);
    const urlKey = resultOf(await mcp(token(), "tools/call", { name: "phoenix_capture_page", arguments: { module: "kpi-reports", persona: "ceo", states: ["summary"], url: "https://phoenix-hr.satopharma.com/admin" } }));
    assert.equal(urlKey.isError, true);
    assert.match(urlKey.content[0].text ?? "", /unknown field "url"/);
    assert.equal(runs.length, 1, "no refused call reached the runner");

    // One capture at a time, across separate HTTP requests.
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const first = mcp(token(), "tools/call", { name: "phoenix_open_module", arguments: { module: "kpi-reports", persona: "ceo" } });
      for (let i = 0; i < 100 && runs.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(runs.length, 2, "the first capture reached the runner");
      const second = resultOf(await mcp(token(), "tools/call", { name: "phoenix_open_module", arguments: { module: "kpi-reports", persona: "sfe" } }));
      assert.equal(second.isError, true);
      assert.match(second.content[0].text ?? "", /another capture is already running/);
      release();
      assert.equal((await first).status, 200);
    } finally {
      release();
      hold = null;
    }

    // Ten tool calls a minute.
    clock += 61_000;
    for (let i = 0; i < RUN_BOUNDS.toolCallsPerMinute; i += 1) {
      assert.ok(!resultOf(await mcp(token(), "tools/call", { name: "phoenix_list_module_pages", arguments: { module: "kpi-reports" } })).isError);
    }
    const limited = resultOf(await mcp(token(), "tools/call", { name: "phoenix_list_module_pages", arguments: { module: "kpi-reports" } }));
    assert.equal(limited.isError, true);
    assert.match(limited.content[0].text ?? "", /calls in a minute/);

    // DNS rebinding and cross-site calls.
    const rebound = await raw(a.url, "GET", "/.well-known/oauth-protected-resource", { host: `attacker.example:${a.port}` });
    assert.equal(rebound.status, 403, "a foreign Host is refused");
    assert.equal(rebound.json?.error, "host_rejected");
    const forwarded = await raw(a.url, "GET", "/.well-known/oauth-protected-resource", { host: "attacker.example", "x-forwarded-host": "127.0.0.1", "x-forwarded-proto": "https" });
    assert.equal(forwarded.status, 403, "X-Forwarded-Host is ignored without --trust-proxy");
    const badOrigin = await mcp(token(), "tools/list", {}, { origin: "https://evil.example" });
    assert.equal(badOrigin.status, 403, "a foreign Origin is refused");
    assert.equal(badOrigin.json?.error, "origin_rejected");
    assert.equal((await mcp(token(), "tools/list", {}, { origin: "null" })).status, 403, "an opaque Origin is refused");
    assert.equal((await mcp(token(), "tools/list", {}, { origin: `http://127.0.0.1:${a.port}` })).status, 200, "the server's own loopback origin is accepted");
    const getMcp = await raw(a.url, "GET", "/mcp", { authorization: `Bearer ${token()}` });
    assert.equal(getMcp.status, 405);
    assert.equal(getMcp.headers.allow, "POST");
    assert.equal((await raw(a.url, "GET", "/healthz", {})).status, 200);

    // ── 3. Behind a trusted proxy with an https public address; a small budget; a byte cap ─────────
    const publicUrl = "https://inspect.example.test/mcp";
    // Every fake shot is the same small picture, so every preview is the same size: room for two and a half.
    const previewBytes = (await sharp(picture).jpeg({ quality: PREVIEW.quality, mozjpeg: true }).toBuffer()).length;
    const b = await startHttpServer({ ...common, publicUrl, trustProxy: true, requestsPerMinute: 5, imageLimits: { bytes: Math.floor(previewBytes * 2.5) } });
    servers.push(b);
    assert.equal(b.resource, publicUrl);
    assert.equal(b.metadataUrl, "https://inspect.example.test/.well-known/oauth-protected-resource/mcp");
    const viaProxy = { host: `127.0.0.1:${b.port}`, "x-forwarded-host": "inspect.example.test", "x-forwarded-proto": "https" };
    const publicMeta = await raw(b.url, "GET", "/.well-known/oauth-protected-resource", viaProxy);
    assert.equal(publicMeta.status, 200);
    assert.equal(publicMeta.json?.resource, publicUrl, "the metadata advertises the configured https address, never a request header");
    const publicBare = await mcp(null, "tools/list", {}, viaProxy, b.url);
    assert.equal(publicBare.status, 401);
    assert.ok(String(publicBare.headers["www-authenticate"] ?? "").includes(`resource_metadata="${b.metadataUrl}"`));
    const plainHttp = await raw(b.url, "GET", "/.well-known/oauth-protected-resource", { ...viaProxy, "x-forwarded-proto": "http" });
    assert.equal(plainHttp.status, 403, "the public name over plain http is refused");
    assert.equal(plainHttp.json?.error, "https_required");
    const publicToken = token({ aud: publicUrl });
    assert.equal((await mcp(token(), "tools/list", {}, viaProxy, b.url)).status, 401, "a token for the loopback resource does not open the public one");
    const capped = resultOf(await mcp(publicToken, "tools/call", { name: "phoenix_capture_page", arguments: { module: "kpi-reports", persona: "dm", states: ["summary"] } }, viaProxy, b.url));
    assert.ok(!capped.isError, JSON.stringify(capped.content?.[0]));
    assert.equal(capped.content.filter((item) => item.type === "image").length, 2, "the per-call byte cap holds (two previews fit, a third does not)");
    assert.equal((await raw(b.url, "GET", "/.well-known/oauth-protected-resource", viaProxy)).status, 200);
    const overBudget = await raw(b.url, "GET", "/.well-known/oauth-protected-resource", viaProxy);
    assert.equal(overBudget.status, 429, "the request budget answers 429");
    assert.equal(overBudget.headers["retry-after"], "60");

    // ── 4. The audit log ─────────────────────────────────────────────────────────────────────────
    for (const server of servers.splice(0)) await server.close();
    const auditText = readFileSync(auditFile, "utf8");
    const lines = auditText.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.length >= 40, `one line per request (${lines.length})`);
    for (const value of issued) {
      assert.ok(!auditText.includes(value) && !auditText.includes(value.split(".")[1]), "no token, nor its claims, is in the audit log");
    }
    assert.ok(!/Bearer|eyJ|authorization/i.test(auditText), "no header or encoded token is in the audit log");
    assert.ok(!auditText.includes(OWNER) && !auditText.includes(STRANGER), "no raw subject is in the audit log");
    assert.ok(!/satopharma|attacker\.example|evil\.example|inspect\.example/.test(auditText), "no refused input or request header is in the audit log");
    const reasons = new Set(lines.map((line) => line.reason).filter(Boolean));
    for (const [, , reason] of refusedTokens) assert.ok(reasons.has(reason), `the audit log names the refusal "${reason}"`);
    assert.ok(reasons.has("missing"));
    const capture = lines.find((line) => line.tool === "phoenix_capture_page" && line.outcome === "ok");
    assert.ok(capture, "the capture is audited");
    assert.equal(capture.persona, "dm");
    assert.equal(capture.status, 200);
    assert.match(String(capture.subject), /^[0-9a-f]{16}$/, "the subject is a keyed hash");
    assert.ok(lines.some((line) => line.outcome === "not-owner" && line.status === 403 && /^[0-9a-f]{16}$/.test(String(line.subject))));
    assert.ok(lines.some((line) => line.outcome === "busy") && lines.some((line) => line.outcome === "rate-limited" && line.status === 429));
    assert.ok(lines.some((line) => line.outcome === "origin-rejected") && lines.some((line) => line.outcome === "host-rejected"));
    assert.ok(lines.every((line) => typeof line.status === "number" && typeof line.ms === "number" && typeof line.at === "string"));
  } finally {
    for (const server of servers) await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
