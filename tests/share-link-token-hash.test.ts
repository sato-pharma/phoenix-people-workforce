import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ApiRateLimitError } from "../src/lib/security/api-rate-limit.ts";
import {
  hashShareToken,
  shareLinkRateRefusal,
  shareTokenLookupHash,
  shareTokenPreview,
} from "../src/lib/share-links/token-hash.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Direct Orders report, Marketing Requests report, Territory preview and CV Lifecycle share links
// are stored only as a hash, and their public routes are metered (REC-055, 13 Nov 2026).
//
//   1. The hash is SHA-256 hex — the same expression the migrations use to fill in the existing rows,
//      so a link already in a sheet keeps opening.
//   2. A token that could not have been minted is not looked up at all.
//   3. The four services and the three sheet rotations write `token_hash` and `token_preview`, find a
//      link by `token_hash`, and never read, write or look up the plain `token` column.
//   4. Every public route meters the caller BEFORE the link is looked up, and a refusal serves nothing.
//   5. The migrations that clear the plain tokens clear all four tables and make the hash required.
// ─────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const SERVICES = [
  "../src/lib/direct-orders/report-share-links.ts",
  "../src/lib/marketing-requests/report-share-links.ts",
  "../src/lib/territory-management/preview-links.ts",
  "../src/lib/recruitment/cv-lifecycle-share-links.ts",
] as const;

const ROTATIONS = [
  "../src/lib/direct-orders/sheet-token-rotation.ts",
  "../src/lib/marketing-requests/sheet-token-rotation.ts",
  "../src/lib/recruitment/cv-lifecycle-sheet-token-rotation.ts",
] as const;

/** Each public route, and the call that looks its link up — the meter must come first. */
const PUBLIC_ROUTES = [
  { file: "../app/api/share/direct-orders/[token]/feed/route.ts", lookup: "resolveDirectOrderReportShareLink(" },
  { file: "../app/api/share/direct-orders/[token]/file/route.ts", lookup: "assertDirectOrderShareToken(" },
  { file: "../app/api/share/marketing-requests/[token]/feed/route.ts", lookup: "resolveMarketingReportShareLink(" },
  { file: "../app/api/share/marketing-requests/[token]/file/route.ts", lookup: "assertMarketingShareToken(" },
  { file: "../app/api/share/territory/[token]/filters/route.ts", lookup: "loadTerritoryPreviewFilters(" },
  { file: "../app/api/share/territory/[token]/map/route.ts", lookup: "loadTerritoryPreviewArea(" },
  { file: "../app/api/share/cv-lifecycle/[token]/feed/route.ts", lookup: "resolveCvLifecycleShareLink(" },
] as const;

export async function runShareLinkTokenHashTests(): Promise<void> {
  // ── 1. SHA-256 hex, as Postgres' encode(sha256(convert_to(token, 'UTF8')), 'hex') ──────────
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"; // 43 characters, base64url
  assert.equal(hashShareToken(token), createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(
    hashShareToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "the hash must be plain SHA-256 hex, or the rows the migration filled in would never match",
  );
  assert.equal(shareTokenPreview(token), "AbCdEfGh");

  // ── 2. Only a token this system could have minted is looked up ─────────────────────────────
  assert.equal(shareTokenLookupHash(token), hashShareToken(token));
  assert.equal(shareTokenLookupHash(`  ${token}  `), hashShareToken(token), "surrounding spaces are trimmed, as before");
  for (const bad of ["", "   ", null, undefined, "short", `${token}/../x`, "a".repeat(129), "a b".repeat(15)]) {
    assert.equal(shareTokenLookupHash(bad), null, `${JSON.stringify(bad)} could not have been minted — it is never looked up`);
  }

  // ── 3. The services and the rotations work by hash only ────────────────────────────────────
  for (const file of [...SERVICES, ...ROTATIONS]) {
    const code = stripComments(read(file));
    assert.ok(!/\.eq\(\s*"token"/.test(code), `${file}: nothing may be looked up, updated or deleted by the plain token`);
    assert.ok(!/\brow\.token\b|\bold\.token\b|\blink\.token\b/.test(code), `${file}: a stored plain token must never be read`);
    assert.ok(!/^\s*token,\s*$/m.test(code) && !/^\s*token: newToken,/m.test(code), `${file}: an insert must not write the plain token`);
    assert.match(code, /token_hash: hashShareToken\((?:token|newToken)\)/, `${file}: a new link must be stored as its hash`);
    assert.match(code, /token_preview: shareTokenPreview\((?:token|newToken)\)/, `${file}: a new link must carry its 8-character preview`);
  }
  for (const file of SERVICES) {
    const code = stripComments(read(file));
    assert.match(code, /const tokenHash = shareTokenLookupHash\((?:input\.)?token\);\s*if \(!tokenHash\) throw notFoundError\("Link not found\."\);/, `${file}: a link is found by the hash of a well-formed token`);
    assert.match(code, /\.eq\("token_hash", tokenHash\)/, `${file}: the lookup must compare hashes`);
  }
  for (const file of ROTATIONS) {
    const code = stripComments(read(file));
    assert.match(code, /\.eq\("token_hash", hashShareToken\(token\)\)/, `${file}: the sheet's first read is observed by hash`);
    assert.match(code, /\.delete\(\)\.eq\("token_hash", hashShareToken\(newToken\)\)/, `${file}: an unconfirmed new link is deleted by hash`);
    assert.match(code, /\.update\(\{ revoked_at: [^}]*\}\)\s*\.eq\("id", String\(old\.id\)\)/, `${file}: the old link is revoked by its id`);
  }

  // ── 4. Metered before the lookup, on every public route ────────────────────────────────────
  for (const route of PUBLIC_ROUTES) {
    const code = stripComments(read(route.file));
    const meter = code.indexOf("await assertShareLinkRate(request, token,");
    const lookup = code.indexOf(route.lookup);
    assert.ok(meter > -1, `${route.file}: the route must meter the caller`);
    assert.ok(lookup > meter, `${route.file}: the meter must run BEFORE the link is looked up`);
    assert.match(code.slice(meter, lookup), /catch \(limitError\) \{\s*return shareLinkRateRefusal\(limitError, "(?:json|text)"\);/, `${route.file}: a refused meter must answer at once and serve nothing`);
  }

  const limited = shareLinkRateRefusal(new ApiRateLimitError(42), "text");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "42");
  assert.equal(limited.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.match(limited.headers.get("X-Robots-Tag") ?? "", /noindex/);
  const down = shareLinkRateRefusal(new Error("limiter unreachable"), "json");
  assert.equal(down.status, 503, "a limiter that cannot be read refuses — it never lets the read through unmetered");
  assert.equal(((await down.json()) as { success: boolean }).success, false);

  // ── 5. The migrations ──────────────────────────────────────────────────────────────────────
  const fill = read("../supabase/migrations/20261113183501_share_link_token_hash.sql");
  const clear = read("../supabase/migrations/20261113183503_share_link_clear_tokens.sql");
  for (const table of ["direct_order_report_share_links", "marketing_request_report_share_links", "territory_preview_links"]) {
    assert.ok(
      fill.includes(`update public.${table}\nset token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)`),
      `${table}: the existing rows must be filled in with the same hash the app computes`,
    );
    assert.ok(fill.includes(`create unique index if not exists ${table}_token_hash_key`), `${table}: the hash must be unique`);
    assert.ok(clear.includes(`update public.${table} set token = null where token is not null and token_hash is not null;`), `${table}: the plain tokens must be cleared`);
    assert.match(clear, new RegExp(`alter table public\\.${table}\\s+alter column token_hash set not null`), `${table}: the hash must become required`);
  }

  // The CV Lifecycle links have their own pair, written once the other three were already live.
  const cvFill = read("../supabase/migrations/20261113195226_cv_lifecycle_share_link_token_hash.sql").replace(/\r\n/g, "\n");
  const cvClear = read("../supabase/migrations/20261113195228_cv_lifecycle_share_link_clear_tokens.sql").replace(/\r\n/g, "\n");
  const cvTable = "ats_cv_lifecycle_share_links";
  const cvFillIn = `update public.${cvTable}\nset token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'), token_preview = left(token, 8)`;
  assert.ok(cvFill.includes(cvFillIn), `${cvTable}: the existing rows must be filled in with the same hash the app computes`);
  assert.ok(cvFill.includes(`create unique index if not exists ${cvTable}_token_hash_key`), `${cvTable}: the hash must be unique`);
  assert.ok(!/drop column token\b/.test(cvFill.replace(/^--.*$/gm, "")), `${cvTable}: the first migration keeps every token, so the live sheet reads on while the old code serves`);
  assert.ok(cvClear.indexOf(cvFillIn) > -1, `${cvTable}: a link the old code made in between is filled in before the tokens are cleared`);
  const cleared = cvClear.indexOf(`update public.${cvTable} set token = null where token is not null and token_hash is not null;`);
  assert.ok(cleared > cvClear.indexOf(cvFillIn), `${cvTable}: the plain tokens are cleared, and only after the fill-in`);
  assert.match(cvClear, new RegExp(`alter table public\\.${cvTable}\\s+alter column token_hash set not null`), `${cvTable}: the hash must become required`);
}
