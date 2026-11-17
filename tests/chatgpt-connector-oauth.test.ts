/**
 * The ChatGPT connector's sign-in and its fences (src/lib/chatgpt-connector/).
 *
 * Runs the real OAuth service against an in-memory store, so every refusal is the service's own:
 * only ChatGPT's return addresses can register, PKCE is required and checked, a code works once, a
 * replayed refresh token revokes the whole family, a token for another address is refused, and a live
 * account that changed (role, password, switched off, left) stops the connector. Then the pieces the
 * MCP route leans on: the audit row keeps no long text, a huge answer is cut with a note, a tool for
 * the other seat is refused, the server lists every tool read-only, and the PDF obeys the ink rule.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { createAccessContext } from "@/lib/auth/permissions";
import { connectorPdfHtml } from "@/lib/chatgpt-connector/files";
import { decideLiveSubject, type LiveAccount } from "@/lib/chatgpt-connector/identity";
import {
  bearerFrom,
  createConnectorOAuth,
  fingerprint,
  OAuthError,
  type ClientRow,
  type CodeRow,
  type ConnectorOAuthStore,
  type GrantSubject,
  type LiveSubjectCheck,
  type TokenRow,
} from "@/lib/chatgpt-connector/oauth";
import {
  auditableInput,
  buildConnectorServer,
  CONNECTOR_MAX_TEXT_CHARS,
  renderAnswer,
  runConnectorTool,
} from "@/lib/chatgpt-connector/server";
import { defineTool, ToolRefusal, type ConnectorTool } from "@/lib/chatgpt-connector/types";

const ORIGIN = "https://phoenix.example.test";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function memoryStore() {
  const clients = new Map<string, ClientRow>();
  const codes = new Map<string, { row: CodeRow; expiresAt: string; used: boolean }>();
  const tokens = new Map<string, TokenRow>();
  const store: ConnectorOAuthStore = {
    async insertClient(row) {
      clients.set(row.client_id, row);
    },
    async getClient(id) {
      return clients.get(id) ?? null;
    },
    async insertCode(hash, row, expiresAt) {
      codes.set(hash, { row, expiresAt, used: false });
    },
    async consumeCode(hash, nowIso) {
      const entry = codes.get(hash);
      if (!entry || entry.used || entry.expiresAt <= nowIso) return null;
      entry.used = true;
      return entry.row;
    },
    async insertTokens(rows) {
      for (const row of rows) tokens.set(row.tokenHash, { ...row, usedAt: null, revokedAt: null });
    },
    async findToken(hash) {
      return tokens.get(hash) ?? null;
    },
    async spendRefreshToken(hash, nowIso) {
      const row = tokens.get(hash);
      if (!row || row.kind !== "refresh" || row.usedAt || row.revokedAt || row.expiresAt <= nowIso) return null;
      row.usedAt = nowIso;
      return row;
    },
    async revokeFamily(familyId, _reason, nowIso) {
      for (const row of tokens.values()) if (row.familyId === familyId && !row.revokedAt) row.revokedAt = nowIso;
    },
  };
  return { store, tokens, codes };
}

const OWNER: GrantSubject = { loginId: "owner", hrId: "B-10", role: "Super Admin", sessionVersion: 3 };

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

async function expectOAuth(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof OAuthError && error.code === code);
}

async function connected(check: LiveSubjectCheck = async () => ({ ok: true })) {
  const memory = memoryStore();
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const oauth = createConnectorOAuth({ store: memory.store, checkSubject: (s) => check(s), origin: ORIGIN, now: () => clock });
  const client = await oauth.register({ client_name: "ChatGPT", redirect_uris: [REDIRECT] });
  const { verifier, challenge } = pkce();
  const request = await oauth.validateAuthorizeRequest({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource: `${ORIGIN}/api/mcp`,
  });
  const back = new URL(await oauth.approve(request, OWNER));
  const code = back.searchParams.get("code") ?? "";
  return { memory, oauth, client, verifier, challenge, code, back, tick: (ms: number) => (clock += ms) };
}

async function registrationAndAuthorize() {
  const memory = memoryStore();
  const oauth = createConnectorOAuth({ store: memory.store, checkSubject: async () => ({ ok: true }), origin: ORIGIN });

  // Only ChatGPT's own return addresses may register.
  await expectOAuth(oauth.register({ redirect_uris: ["https://evil.example/cb"] }), "invalid_redirect_uri");
  await expectOAuth(oauth.register({ redirect_uris: ["https://chatgpt.com.evil.example/connector_platform_oauth_redirect"] }), "invalid_redirect_uri");
  await expectOAuth(oauth.register({ redirect_uris: [] }), "invalid_redirect_uri");
  await expectOAuth(oauth.register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" }), "invalid_client_metadata");
  const ok = await oauth.register({ redirect_uris: [REDIRECT, "https://chatgpt.com/connector/oauth/abc_123"] });
  assert.match(ok.client_id, /^phxcl_/);
  assert.equal(ok.token_endpoint_auth_method, "none");

  const { challenge } = pkce();
  const base = { response_type: "code", client_id: ok.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, client_id: "phxcl_unknown" }), "invalid_client");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, redirect_uri: "https://chatgpt.com/connector/oauth/other" }), "invalid_request");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, code_challenge_method: "plain" }), "invalid_request");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, code_challenge: undefined }), "invalid_request");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, resource: "https://phoenix.example.test/api/other" }), "invalid_target");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, resource: "https://elsewhere.example/api/mcp" }), "invalid_target");
  await expectOAuth(oauth.validateAuthorizeRequest({ ...base, scope: "phoenix:read phoenix:write" }), "invalid_scope");
  const valid = await oauth.validateAuthorizeRequest({ ...base, resource: `${ORIGIN}/api/mcp/` });
  assert.equal(valid.resource, `${ORIGIN}/api/mcp`);

  // Only the two connector seats can approve, and Cancel answers access_denied to ChatGPT.
  await expectOAuth(oauth.approve(valid, { ...OWNER, role: "HR Manager" as never }), "access_denied");
  const denied = new URL(oauth.deny({ ...valid, state: "abc" }));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "abc");
  assert.equal(denied.searchParams.get("iss"), ORIGIN);
}

async function codeExchange() {
  const flow = await connected();
  assert.equal(flow.back.origin + flow.back.pathname, REDIRECT);
  assert.equal(flow.back.searchParams.get("state"), "s1");
  assert.equal(flow.back.searchParams.get("iss"), ORIGIN);
  assert.match(flow.code, /^phxcd_/);
  // The code is stored only as its fingerprint.
  assert.ok(flow.memory.codes.has(fingerprint(flow.code)));
  assert.ok(![...flow.memory.codes.keys()].includes(flow.code));

  const form = { grant_type: "authorization_code", client_id: flow.client.client_id, redirect_uri: REDIRECT, code: flow.code };
  // Wrong verifier fails — and burns the code, so the right one cannot use it afterwards.
  await expectOAuth(flow.oauth.token({ ...form, code_verifier: pkce().verifier }), "invalid_grant");
  await expectOAuth(flow.oauth.token({ ...form, code_verifier: flow.verifier }), "invalid_grant");

  const fresh = await connected();
  const freshForm = { grant_type: "authorization_code", client_id: fresh.client.client_id, redirect_uri: REDIRECT, code: fresh.code, code_verifier: fresh.verifier };
  await expectOAuth(fresh.oauth.token({ ...freshForm, client_id: "phxcl_someone_else" }), "invalid_grant");

  const again = await connected();
  const againForm = { grant_type: "authorization_code", client_id: again.client.client_id, redirect_uri: REDIRECT, code: again.code, code_verifier: again.verifier };
  const pair = await again.oauth.token(againForm);
  assert.match(pair.access_token, /^phxat_/);
  assert.match(pair.refresh_token, /^phxrt_/);
  assert.equal(pair.token_type, "Bearer");
  // A code works once.
  await expectOAuth(again.oauth.token(againForm), "invalid_grant");
  // Tokens are stored only as fingerprints.
  assert.ok(!again.memory.tokens.has(pair.access_token));
  assert.ok(again.memory.tokens.has(fingerprint(pair.access_token)));

  // The access token opens /api/mcp; a refresh token, a wrong prefix or an expired one does not.
  const row = await again.oauth.verifyAccessToken(pair.access_token);
  assert.equal(row?.loginId, "owner");
  assert.equal(row?.role, "Super Admin");
  assert.equal(await again.oauth.verifyAccessToken(pair.refresh_token), null);
  assert.equal(await again.oauth.verifyAccessToken(null), null);
  assert.equal(await again.oauth.verifyAccessToken("phxat_not_issued"), null);
  again.tick(3_601_000);
  assert.equal(await again.oauth.verifyAccessToken(pair.access_token), null, "an access token lives one hour");

  // An expired code is refused.
  const late = await connected();
  late.tick(121_000);
  await expectOAuth(
    late.oauth.token({ grant_type: "authorization_code", client_id: late.client.client_id, redirect_uri: REDIRECT, code: late.code, code_verifier: late.verifier }),
    "invalid_grant",
  );

  // A token minted for another address is refused at /api/mcp.
  const other = await connected();
  const otherPair = await other.oauth.token({ grant_type: "authorization_code", client_id: other.client.client_id, redirect_uri: REDIRECT, code: other.code, code_verifier: other.verifier });
  const stored = other.memory.tokens.get(fingerprint(otherPair.access_token));
  assert.ok(stored);
  stored.resource = "https://elsewhere.example/api/mcp";
  assert.equal(await other.oauth.verifyAccessToken(otherPair.access_token), null);
}

async function refreshRotationAndReplay() {
  const flow = await connected();
  const first = await flow.oauth.token({ grant_type: "authorization_code", client_id: flow.client.client_id, redirect_uri: REDIRECT, code: flow.code, code_verifier: flow.verifier });
  const refresh = { grant_type: "refresh_token", client_id: flow.client.client_id, refresh_token: first.refresh_token };
  const second = await flow.oauth.token(refresh);
  assert.notEqual(second.access_token, first.access_token);
  assert.ok(await flow.oauth.verifyAccessToken(second.access_token));

  // Replaying the spent refresh token revokes the whole family — the new pair stops too.
  await expectOAuth(flow.oauth.token(refresh), "invalid_grant");
  assert.equal(await flow.oauth.verifyAccessToken(second.access_token), null);
  assert.equal(await flow.oauth.verifyAccessToken(first.access_token), null);
  await expectOAuth(flow.oauth.token({ ...refresh, refresh_token: second.refresh_token }), "invalid_grant");

  // A refresh token presented by another client revokes its family.
  const stolen = await connected();
  const pair = await stolen.oauth.token({ grant_type: "authorization_code", client_id: stolen.client.client_id, redirect_uri: REDIRECT, code: stolen.code, code_verifier: stolen.verifier });
  await expectOAuth(stolen.oauth.token({ grant_type: "refresh_token", client_id: "phxcl_thief", refresh_token: pair.refresh_token }), "invalid_grant");
  assert.equal(await stolen.oauth.verifyAccessToken(pair.access_token), null);

  // Revocation (RFC 7009) ends the family; an unknown token is a quiet no-op.
  const revoked = await connected();
  const rPair = await revoked.oauth.token({ grant_type: "authorization_code", client_id: revoked.client.client_id, redirect_uri: REDIRECT, code: revoked.code, code_verifier: revoked.verifier });
  await revoked.oauth.revoke({ token: "phxrt_unknown" });
  assert.ok(await revoked.oauth.verifyAccessToken(rPair.access_token));
  await revoked.oauth.revoke({ token: rPair.refresh_token });
  assert.equal(await revoked.oauth.verifyAccessToken(rPair.access_token), null);

  // A live check that fails at refresh time revokes the family.
  let allow = true;
  const gated = await connected(async () => (allow ? { ok: true } : { ok: false, reason: "The Phoenix account is switched off." }));
  const gPair = await gated.oauth.token({ grant_type: "authorization_code", client_id: gated.client.client_id, redirect_uri: REDIRECT, code: gated.code, code_verifier: gated.verifier });
  allow = false;
  await expectOAuth(gated.oauth.token({ grant_type: "refresh_token", client_id: gated.client.client_id, refresh_token: gPair.refresh_token }), "invalid_grant");
  assert.equal(await gated.oauth.verifyAccessToken(gPair.access_token), null);

  await expectOAuth(gated.oauth.token({ grant_type: "password" }), "unsupported_grant_type");
  assert.equal(bearerFrom("Bearer phxat_abc"), "phxat_abc");
  assert.equal(bearerFrom("Basic abc"), null);
  assert.equal(bearerFrom(undefined), null);
}

function liveAccountDecisions() {
  const account: LiveAccount = { login_id: "owner", hr_id: "B-10", role: "Super Admin", is_active: true, session_version: 3, is_test_persona: false, name: "Owner" };
  type Employee = Parameters<typeof decideLiveSubject>[2];
  const active: Employee = { lookupFailed: false, row: { employment_status: "Active", last_working_date: null } };
  const today = "2026-11-17";
  assert.deepEqual(decideLiveSubject(OWNER, account, active, today), { ok: true });

  const refused = (a: LiveAccount | null, e: Employee = active, subject = OWNER) => {
    const verdict = decideLiveSubject(subject, a, e, today);
    assert.equal(verdict.ok, false);
    return verdict.ok ? "" : verdict.reason;
  };
  assert.match(refused(null), /no longer exists/);
  assert.match(refused({ ...account, is_active: false }), /switched off/);
  assert.match(refused({ ...account, is_test_persona: true }), /Test accounts/);
  assert.match(refused({ ...account, role: "HR Manager" }), /owner and the CEO/);
  assert.match(refused({ ...account, role: "CEO" }), /role changed/);
  assert.match(refused({ ...account, session_version: 4 }), /password was changed|signed out everywhere/);
  assert.match(refused({ ...account, hr_id: "B-11" }), /different employee/);
  assert.match(refused(account, { lookupFailed: true, row: null }), /could not check/);
  assert.match(refused(account, { lookupFailed: false, row: { employment_status: "Resigned", last_working_date: "2026-10-01" } }), /no longer active/);
}

async function serverPieces() {
  // The audit row keeps small values and describes everything else.
  assert.deepEqual(auditableInput({ hrId: "B-10", n: 3, ok: true, none: null, rows: [1, 2, 3], filter: { a: 1 }, long: "x".repeat(500) }), {
    hrId: "B-10",
    n: 3,
    ok: true,
    none: null,
    rows: "[list of 3]",
    filter: "[object]",
    long: "[text, 500 characters]",
  });
  assert.deepEqual(auditableInput(null), {});

  const small = renderAnswer({ summary: "Two people.", data: [{ a: 1 }] });
  assert.equal(small.cut, false);
  assert.ok(small.text.startsWith("Two people."));
  const big = renderAnswer({ summary: "Many rows.", data: Array.from({ length: 40_000 }, (_, i) => ({ i, name: `Person ${i}` })) });
  assert.equal(big.cut, true);
  assert.ok(big.text.length <= CONNECTOR_MAX_TEXT_CHARS);
  assert.match(big.text, /too large to send whole/);

  const ctx = createAccessContext({ hrId: "B-10", loginId: "owner", role: "Super Admin", source: "session" });
  const ceoOnly = defineTool({ name: "phoenix_test_ceo_only", title: "CEO only", description: "test", input: {}, roles: ["CEO"], run: async () => ({ summary: "secret", data: null }) });
  const audits: Array<Record<string, unknown>> = [];
  const audit = async (row: Record<string, unknown>) => {
    audits.push(row);
  };
  const refusedSeat = await runConnectorTool(ctx, ceoOnly as ConnectorTool, {}, { audit });
  assert.equal(refusedSeat.isError, true);
  assert.doesNotMatch(refusedSeat.content[0].text, /secret/);

  const refusing = defineTool({ name: "phoenix_test_refusal", title: "Refusal", description: "test", input: {}, run: async () => { throw new ToolRefusal("Nobody by that name."); } });
  const refusal = await runConnectorTool(ctx, refusing as ConnectorTool, {}, { audit });
  assert.equal(refusal.content[0].text, "Nobody by that name.");

  const crashing = defineTool({ name: "phoenix_test_crash", title: "Crash", description: "test", input: {}, run: async () => { throw new Error("relation \"secret_table\" does not exist"); } });
  const crash = await runConnectorTool(ctx, crashing as ConnectorTool, {}, { audit });
  assert.equal(crash.isError, true);
  assert.doesNotMatch(crash.content[0].text, /secret_table/, "internals never reach ChatGPT");

  const slow = defineTool({ name: "phoenix_test_slow", title: "Slow", description: "test", input: {}, run: () => new Promise(() => undefined) });
  const timedOut = await runConnectorTool(ctx, slow as ConnectorTool, {}, { audit, timeoutMs: 20 });
  assert.match(timedOut.content[0].text, /took longer than/);

  const answering = defineTool({ name: "phoenix_test_answer", title: "Answer", description: "test", input: { hrId: z.string() }, run: async (_c, input) => ({ summary: `Found ${input.hrId}.`, data: { hrId: input.hrId } }) });
  const answered = await runConnectorTool(ctx, answering as unknown as ConnectorTool, { hrId: "B-10" }, { audit });
  assert.equal(answered.isError, undefined);
  assert.deepEqual(answered.structuredContent, { summary: "Found B-10.", data: { hrId: "B-10" } });

  // Every call leaves one audit row with the outcome, and never the answer.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    audits.map((row) => [row.tool, row.outcome]),
    [
      ["phoenix_test_ceo_only", "refused"],
      ["phoenix_test_refusal", "refused"],
      ["phoenix_test_crash", "failed"],
      ["phoenix_test_slow", "refused"],
      ["phoenix_test_answer", "answered"],
    ],
  );
  assert.ok(audits.every((row) => !JSON.stringify(row).includes("Found B-10.")));

  // The MCP server lists the tools it was given, each marked read-only.
  const server = buildConnectorServer(ctx, [answering as unknown as ConnectorTool, refusing as ConnectorTool]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["phoenix_test_answer", "phoenix_test_refusal"]);
  assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
  await client.close();
  await server.close();
}

function pdfInkRule() {
  const html = connectorPdfHtml(
    {
      title: "Ibtissam — Q3 achievement",
      subtitle: "Published closing",
      sections: [
        { heading: "Summary", text: "First paragraph.\n\nSecond <b>one</b>." },
        { heading: "By month", columns: [{ key: "month", label: "Month" }, { key: "value", label: "Value", numeric: true }], rows: [{ month: "July", value: 1234.5 }, { month: "August", value: null }] },
      ],
    },
    new Date("2026-11-17T10:00:00Z"),
  );
  assert.match(html, /SATO-DIS-2026-01 v1\.0/);
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /1,234\.5/);
  assert.match(html, /Second &lt;b&gt;one&lt;\/b&gt;\./, "text is escaped");
  assert.doesNotMatch(html, /<b>one<\/b>/);
  // The ink rule: the only filled area is the even-row zebra.
  const backgrounds = [...html.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(backgrounds.length, 1, `only the zebra is filled, found: ${backgrounds.join(" | ")}`);
  assert.match(html, /tbody tr:nth-child\(even\) td \{ background:/);
  assert.doesNotMatch(html, /border-radius|box-shadow|linear-gradient/);
}

export async function runChatgptConnectorOAuthTests() {
  await registrationAndAuthorize();
  await codeExchange();
  await refreshRotationAndReplay();
  liveAccountDecisions();
  await serverPieces();
  pdfInkRule();
}
