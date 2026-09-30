import assert from "node:assert/strict";

import {
  issueShareCardToken,
  readShareCardToken,
  shareCardImageUrl,
  shareCardPublicUrl,
  unpackShareFocus,
} from "@/lib/share/share-card-token";

// The public share-card token — the capability behind an UNAUTHENTICATED link that LinkedIn and
// Facebook scrape. The security properties are the whole test: it round-trips, it names the subject
// the minter chose, and a forged / tampered / expired token is refused (returns null, never throws).

export function runShareCardTokenTests(): void {
  process.env.PHOENIX_AUTH_SECRET = process.env.PHOENIX_AUTH_SECRET || "test-share-secret-do-not-use";
  const now = 1_800_000_000;

  // ── Round trip: a milestone link names the subject, canonicalised, and its card ────────────────
  const mTok = issueShareCardToken({ kind: "milestone", hrId: "B-13", spec: "2y", on: "2026-10-01", nowSeconds: now });
  const m = readShareCardToken(mTok, now);
  assert.ok(m && m.k === "milestone", "a milestone token reads back as a milestone");
  assert.equal(m.hr, "b-13", "the subject is stored canonicalised (lower-case)");
  assert.equal(m.spec, "2y");
  assert.equal(m.on, "2026-10-01");

  // ── A deliberate monogram (no-photo) choice is carried onto the public link ───────────────────
  const npTok = issueShareCardToken({ kind: "milestone", hrId: "B-13", spec: "2y", on: "2026-10-01", withoutPhoto: true, nowSeconds: now });
  const np = readShareCardToken(npTok, now);
  assert.ok(np && np.k === "milestone" && np.np === true, "a no-photo card carries np:true so the public link stays photo-less");
  assert.ok(m.k === "milestone" && !m.np, "a normal card carries no np flag (photo shown)");
  assert.notEqual(npTok.split(".")[1], mTok.split(".")[1], "different payloads sign differently — the rate-limit key varies per token");

  // ── The drag framing travels in the link so LinkedIn/Facebook show the rep's crop ─────────────
  const framed = issueShareCardToken({
    kind: "milestone",
    hrId: "B-13",
    spec: "2y",
    on: "2026-10-01",
    focus: { x: 0.25, y: 0.8, zoom: 2.5 },
    nowSeconds: now,
  });
  const framedFocus = unpackShareFocus(readShareCardToken(framed, now)!);
  assert.deepEqual(framedFocus, { x: 0.25, y: 0.8, zoom: 2.5 }, "the framing round-trips through the token");
  assert.equal(unpackShareFocus(readShareCardToken(mTok, now)!), null, "a card with no drag carries no framing");
  // A monogram (no photo) never carries a framing — there is no photo to frame.
  const monogram = issueShareCardToken({
    kind: "milestone", hrId: "B-13", spec: "2y", on: "2026-10-01", withoutPhoto: true, focus: { x: 0.1, y: 0.1, zoom: 3 }, nowSeconds: now,
  });
  assert.equal(unpackShareFocus(readShareCardToken(monogram, now)!), null, "a monogram carries no framing");

  // ── Round trip: a spotlight link carries its range ────────────────────────────────────────────
  const sTok = issueShareCardToken({ kind: "spotlight", hrId: "b-40", from: "2026-07", to: "2026-08", nowSeconds: now });
  const s = readShareCardToken(sTok, now);
  assert.ok(s && s.k === "spotlight", "a spotlight token reads back as a spotlight");
  assert.equal(s.from, "2026-07");
  assert.equal(s.to, "2026-08");

  // ── A tampered signature is refused ───────────────────────────────────────────────────────────
  const [enc, sig] = mTok.split(".");
  const flipped = sig[0] === "A" ? "B" : "A";
  assert.equal(readShareCardToken(`${enc}.${flipped}${sig.slice(1)}`, now), null, "a flipped signature is refused");

  // ── A tampered PAYLOAD (re-pointed at another person) is refused — the signature no longer fits ─
  const forged = Buffer.from(JSON.stringify({ v: 1, k: "milestone", hr: "b-1", spec: "2y", on: "2026-10-01", exp: now + 100 }))
    .toString("base64url");
  assert.equal(readShareCardToken(`${forged}.${sig}`, now), null, "re-pointing the subject breaks the signature");

  // ── Garbage and empties are refused, never thrown ─────────────────────────────────────────────
  for (const bad of ["", "no-dot", "a.b", ".x", "x."]) {
    assert.equal(readShareCardToken(bad, now), null, `"${bad}" is refused`);
  }
  assert.equal(readShareCardToken(null, now), null);

  // ── Expiry: a token is dead once its exp has passed ───────────────────────────────────────────
  const expired = issueShareCardToken({ kind: "milestone", hrId: "B-13", spec: "2y", on: "2026-10-01", nowSeconds: now });
  assert.ok(readShareCardToken(expired, now + 29 * 24 * 3600), "still live inside 30 days");
  assert.equal(readShareCardToken(expired, now + 31 * 24 * 3600), null, "dead after 30 days");

  // ── The public URLs point at the production domain a scraper can reach ─────────────────────────
  assert.equal(shareCardPublicUrl("TOK"), "https://phoenix-hr.satopharma.com/share/card/TOK");
  assert.equal(shareCardImageUrl("TOK"), "https://phoenix-hr.satopharma.com/share/card/TOK/image");
}
