// How a share-link token is stored and found, and how its public routes are metered (REC-055).
//
// The Direct Orders report, Marketing Requests report and Territory preview links keep only the
// SHA-256 of a token (`token_hash`, unique) and its first 8 characters (`token_preview`, the same
// preview the audit rows carry). The whole token is handed back once, in the answer that made it,
// and after that exists only where it was sent — the sheet's script, the recipient's message. The
// token is 32 random bytes, so a plain hash is enough: there is nothing to guess.
//
// Every public read is limited per address and per link BEFORE the token is looked up, so a 429
// says nothing about whether a token is real. The limits sit far above real use: each live sheet
// reads its feed about 42 times an hour (measured 13 Nov 2026), and a person opening a preview reads
// it a handful of times.

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

/** A token this system could have minted: 32 random bytes in base64url are 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** What `token_hash` holds for a token. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** What `token_preview` holds: the first 8 characters, never the whole token. */
export function shareTokenPreview(token: string): string {
  return token.slice(0, 8);
}

/**
 * The `token_hash` to look a caller's token up by, or `null` when the token could not have been
 * minted here — that one is answered "not found" without a database read.
 */
export function shareTokenLookupHash(token: unknown): string | null {
  const trimmed = String(token ?? "").trim();
  if (!TOKEN_SHAPE.test(trimmed)) return null;
  return hashShareToken(trimmed);
}

const HOUR = 60 * 60 * 1000;

/**
 * Limits one public share-link read, per address and per link, before the token is looked up.
 * Throws `ApiRateLimitError` when either limit is spent; fails closed when the limiter cannot be read.
 */
export async function assertShareLinkRate(
  request: Request,
  token: string,
  input: { addressLimit: number; linkLimit: number; scope: string },
): Promise<void> {
  await assertApiRateLimit({
    identifier: rateLimitIdentity({ request }),
    limit: input.addressLimit,
    scope: `${input.scope}_ip`,
    windowMs: HOUR,
  });
  await assertApiRateLimit({
    identifier: rateLimitIdentity({ request, token }),
    limit: input.linkLimit,
    scope: `${input.scope}_link`,
    windowMs: HOUR,
  });
}

/**
 * The answer a metered share route gives when `assertShareLinkRate` refuses: 429 with Retry-After
 * when a limit is spent, 503 when the limiter cannot be read. Nothing is served, cached or indexed.
 */
export function shareLinkRateRefusal(error: unknown, format: "json" | "text"): NextResponse {
  const limited = error instanceof ApiRateLimitError;
  const status = limited ? 429 : 503;
  const message = limited
    ? "Too many requests. Please wait a few minutes and try again."
    : "This link is not available right now. Please try again shortly.";
  const headers: Record<string, string> = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    ...(limited ? { "Retry-After": String(error.retryAfterSeconds) } : {}),
  };
  if (format === "json") return NextResponse.json({ success: false, message }, { status, headers });
  return new NextResponse(message, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}
