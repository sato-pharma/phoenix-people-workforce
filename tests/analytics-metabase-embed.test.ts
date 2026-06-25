import assert from "node:assert/strict";

import { buildMetabaseOpenLink, getMetabaseEmbedConfig, signMetabaseEmbedUrl } from "../src/lib/analytics/metabase-embed.ts";

function base64urlDecode(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

export function runAnalyticsMetabaseEmbedTests() {
  const originalSecret = process.env.METABASE_EMBED_SECRET;
  const originalSiteUrl = process.env.METABASE_SITE_URL;

  try {
    // Disabled state: graceful null when either env var is unset (today's default).
    delete process.env.METABASE_EMBED_SECRET;
    delete process.env.METABASE_SITE_URL;
    assert.equal(getMetabaseEmbedConfig(), null);
    assert.equal(buildMetabaseOpenLink(getMetabaseEmbedConfig()), null);

    process.env.METABASE_EMBED_SECRET = "test-secret";
    assert.equal(getMetabaseEmbedConfig(), null, "still disabled with only secret set");

    delete process.env.METABASE_EMBED_SECRET;
    process.env.METABASE_SITE_URL = "https://demo-metabase.example.com";
    assert.equal(getMetabaseEmbedConfig(), null, "still disabled with only site url set");

    // Enabled state: both set.
    process.env.METABASE_EMBED_SECRET = "test-secret";
    process.env.METABASE_SITE_URL = "https://demo-metabase.example.com";
    const config = getMetabaseEmbedConfig();
    assert.ok(config);
    assert.equal(config?.secret, "test-secret");
    assert.equal(config?.siteUrl, "https://demo-metabase.example.com");
    assert.equal(buildMetabaseOpenLink(config), "https://demo-metabase.example.com");

    // Signed token round-trips: 3 dot-separated base64url parts, header/payload decode to valid JSON.
    const url = signMetabaseEmbedUrl(config!, { dashboard: 42 }, { line: "Demo Line 1" }, 600);
    assert.match(url, /^https:\/\/demo-metabase\.example\.com\/embed\/dashboard\/[^/]+#bordered=true&titled=true$/);

    const token = url.split("/embed/dashboard/")[1].split("#")[0];
    const parts = token.split(".");
    assert.equal(parts.length, 3, "JWT has header.payload.signature");

    const header = JSON.parse(base64urlDecode(parts[0]));
    assert.deepEqual(header, { alg: "HS256", typ: "JWT" });

    const payload = JSON.parse(base64urlDecode(parts[1]));
    assert.deepEqual(payload.resource, { dashboard: 42 });
    assert.deepEqual(payload.params, { line: "Demo Line 1" });
    assert.ok(typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000));
  } finally {
    if (originalSecret === undefined) delete process.env.METABASE_EMBED_SECRET;
    else process.env.METABASE_EMBED_SECRET = originalSecret;
    if (originalSiteUrl === undefined) delete process.env.METABASE_SITE_URL;
    else process.env.METABASE_SITE_URL = originalSiteUrl;
  }
}
