// Metabase embed signing — Phase 6 foundation, minimal/safe scope.
//
// Standard Metabase static embedding signs a JWT (HS256) with the Metabase
// embedding secret. No JWT library is installed in this repo, so the token is
// hand-rolled with node:crypto — this is the full HS256 JWT spec (base64url
// header.payload, HMAC-SHA256 signature, base64url, dot-joined), not a
// shortcut. Degrades gracefully to a disabled state when env vars are unset
// (the default local/preview state today) — no live Metabase instance is
// required to import or call this module.

import { createHmac } from "node:crypto";

export type MetabaseEmbedConfig = {
  siteUrl: string;
  secret: string;
};

export function getMetabaseEmbedConfig(): MetabaseEmbedConfig | null {
  const secret = process.env.METABASE_EMBED_SECRET?.trim();
  const siteUrl = process.env.METABASE_SITE_URL?.trim();
  if (!secret || !siteUrl) return null;
  return { siteUrl, secret };
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export type MetabaseEmbedResource = { dashboard: number } | { question: number };

/**
 * Signs a Metabase static-embed URL for a specific dashboard/question.
 * Provided for future use once a live Metabase instance exists to test
 * against — Phase 6's actual UI only renders buildMetabaseOpenLink() below.
 */
export function signMetabaseEmbedUrl(
  config: MetabaseEmbedConfig,
  resource: MetabaseEmbedResource,
  params: Record<string, unknown> = {},
  ttlSeconds = 600,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      resource,
      params,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const signature = createHmac("sha256", config.secret).update(`${header}.${payload}`).digest("base64url");
  const token = `${header}.${payload}.${signature}`;
  const path = "dashboard" in resource ? "dashboard" : "question";
  return `${config.siteUrl}/embed/${path}/${token}#bordered=true&titled=true`;
}

/** Minimal Phase-6 scope: a bare link to the Metabase site, not a specific embedded dashboard. */
export function buildMetabaseOpenLink(config: MetabaseEmbedConfig | null): string | null {
  return config ? config.siteUrl : null;
}
