import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE MANAGEMENT LISTS OF THE TWO OLDER SHARE-LINK SERVICES NEVER CARRY THE WHOLE TOKEN.
//
// `ats_cv_lifecycle_share_links` was fixed first (tests/cv-lifecycle-share-links-screen.test.ts,
// section 3): its list returns `tokenPreview`, the first 8 characters, and the whole token exists in
// exactly one response — the mint. Direct Orders and Marketing Requests still mapped `token:
// String(row.token)` into the list, so GET /api/direct-orders/report/share-links and
// GET /api/marketing-requests/report/share-links shipped every live bearer credential to the browser
// of anyone holding the export permission: visible in devtools, in the React tree, and in any error
// report that captured a network body. The marketing token is the one found publicly readable on
// 2026-08-05. These tokens are the ENTIRE security boundary of an unauthenticated route.
//
// Hiding a token in JSX leaves all of that untouched, so the assertions are on the payload's shape:
// the type, the mapper that builds it, the route that serialises it, and the one panel that reads it.
// ─────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** From a marker to the first closing `};` at column 0 — the end of a top-level type literal. */
function typeLiteral(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${marker} must still exist`);
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, `${marker} must end in a closing \`};\``);
  return source.slice(start, end);
}

/** A top-level function from its declaration to the next top-level declaration. */
function functionBlock(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start > -1, `${declaration} must still exist`);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type) /m);
  return source.slice(start, next > -1 ? start + declaration.length + next : source.length);
}

export function runShareLinkListsOmitTokenTests() {
  const services = [
    {
      name: "Direct Orders",
      file: "../src/lib/direct-orders/report-share-links.ts",
      type: "export type DirectOrderShareLink = {",
      list: "export async function listDirectOrderReportShareLinks(",
    },
    {
      name: "Marketing Requests",
      file: "../src/lib/marketing-requests/report-share-links.ts",
      type: "export type MarketingShareLink = {",
      list: "export async function listMarketingReportShareLinks(",
    },
    {
      name: "Territory preview",
      file: "../src/lib/territory-management/preview-links.ts",
      type: "export type TerritoryPreviewLink = {",
      list: "export async function listTerritoryPreviewLinks(",
    },
  ] as const;

  for (const service of services) {
    const source = stripComments(read(service.file));

    // ── 1. The type has no `token` field and has the 8-character preview ───────
    const type = typeLiteral(source, service.type);
    assert.ok(
      !/^\s*token\??:/m.test(type),
      `${service.name}: the list row type must NOT carry a \`token\` field — the list is what reaches the browser`,
    );
    assert.ok(/^\s*tokenPreview: string;/m.test(type), `${service.name}: a link is identified by its 8-char tokenPreview`);

    // ── 2. The mapper reads only the stored preview — the token itself is not stored (REC-055) ──
    const list = functionBlock(source, service.list);
    assert.ok(
      /tokenPreview: (?:String|str)\(row\.token_preview\b/.test(list),
      `${service.name}: the list must build tokenPreview from row.token_preview`,
    );
    assert.ok(
      !/\btoken\s*:/.test(list),
      `${service.name}: the list mapper must not emit a \`token:\` key — only \`tokenPreview:\``,
    );
    assert.ok(!/row\.token\b/.test(list), `${service.name}: the list must never read row.token`);

    // ── 3. The whole token still has exactly one way out: the mint ────────────
    assert.ok(
      /Promise<\{[^}]*token: string[^}]*\}>/.test(source),
      `${service.name}: the create function must still return the token, once, to the person who minted it`,
    );
  }

  // The preview every service stores is the first 8 characters — the same length the audit rows carry.
  assert.ok(
    /export function shareTokenPreview\(token: string\): string \{\s*return token\.slice\(0, 8\);\s*\}/.test(
      stripComments(read("../src/lib/share-links/token-hash.ts")),
    ),
    "shareTokenPreview must be the first 8 characters",
  );

  // ── 4. The routes serialise the list as returned, and add nothing to it ──────
  for (const route of [
    "../app/api/direct-orders/report/share-links/route.ts",
    "../app/api/marketing-requests/report/share-links/route.ts",
  ]) {
    const getHandler = functionBlock(stripComments(read(route)), "export async function GET(");
    assert.ok(
      getHandler.includes("NextResponse.json({ links, success: true })"),
      `${route}: GET must return the service's list unchanged`,
    );
    assert.ok(!/\btoken\b/.test(getHandler), `${route}: GET must never name a token`);
  }

  // ── 5. The one UI consumer reads a whole token only from what it just minted ──
  const panel = stripComments(read("../src/components/direct-orders/report-share-links-panel.tsx"));
  const tokenReads = [...panel.matchAll(/(\w+)\.token\b/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(tokenReads)].sort(),
    ["created", "data"],
    "the panel may read only the token it just minted (created) and the response carrying it (data)",
  );
  assert.ok(!/link\.token\b/.test(panel), "an existing link's token must never be rendered; it is not even fetched");
  assert.ok(
    /body: JSON\.stringify\(\{ action: "revoke", linkId \}\)/.test(panel),
    "revoke goes by the link's id — it never needed the token",
  );

  // Marketing's panel (13 Oct 2026) is held to the same rules.
  const mkPanel = stripComments(read("../src/components/marketing-requests/report-share-links-panel.tsx"));
  const mkReads = [...mkPanel.matchAll(/(\w+)\.token\b/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(mkReads)].sort(),
    ["created", "data"],
    "the marketing panel may read only the token it just minted (created) and the response carrying it (data)",
  );
  assert.ok(!/link\.token\b/.test(mkPanel), "an existing marketing link's token must never be rendered; it is not even fetched");
  assert.ok(
    /body: JSON\.stringify\(\{ action: "revoke", linkId \}\)/.test(mkPanel),
    "marketing revoke goes by the link's id",
  );
}
