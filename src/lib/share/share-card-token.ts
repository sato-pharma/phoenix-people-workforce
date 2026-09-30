import { createHmac, timingSafeEqual } from "node:crypto";

import { systemDeployment } from "@/config/system-settings";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * A public, unguessable, EXPIRING link to one person's OWN keepsake — a milestone card or a spotlight
 * sheet — so LinkedIn and Facebook can scrape the actual picture into a post preview.
 *
 * WHY A TOKEN AND NOT A ROW. The card image itself carries only what the person is choosing to
 * publish about himself — his name, his photo, his own celebratory occasion. So the capability is a
 * stateless HMAC over the payload, exactly like the payroll-acknowledgement and session signers
 * (`PHOENIX_AUTH_SECRET`), no table and no migration. The token carries:
 *
 *   - the KIND (milestone | spotlight) and its parameters, so the link renders one specific card;
 *   - the SUBJECT hr id, so the render is for that person and no other — and because only the rep's
 *     own authed route mints it (from `access.hrId`), a token can only ever name the person who made
 *     it. The public routes NEVER read an hr id off the wire; the signed subject is the only one.
 *   - an EXPIRY, so a link stops resolving after a month whatever a platform cached at scrape time.
 *
 * With no signing secret nothing mints and nothing verifies — the link simply 404s, which is the
 * correct direction to fail, and moot in practice (the same secret signs the session, so without it
 * nobody is logged in to mint one either).
 */

export type ShareCardKind = "milestone" | "spotlight";

export type ShareCardPayload =
  // `np` (no photo) carries a rep's deliberate monogram choice onto the PUBLIC link — a photo-less
  // card he built must not reappear with his photo once it is shareable. Optional, defaults false.
  // `f` is his framing of the RECORD photo — [x, y, zoom] — so LinkedIn and Facebook show the crop he
  // dragged, not the centre default. Only ever carried for the record photo (a custom UPLOAD cannot
  // fit in a URL, so an uploaded card falls back to the default crop). Optional.
  | { v: 1; k: "milestone"; hr: string; spec: string; on: string; np?: boolean; f?: [number, number, number]; exp: number }
  | { v: 1; k: "spotlight"; hr: string; from: string; to: string; exp: number };

/** A drag framing → the compact `[x, y, zoom]` the token carries (each rounded, clamped to its range). */
function packFocus(focus: { x: number; y: number; zoom: number } | null | undefined): [number, number, number] | null {
  if (!focus) return null;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (![focus.x, focus.y, focus.zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [round(clamp01(focus.x)), round(clamp01(focus.y)), round(Math.min(4, Math.max(1, focus.zoom)))];
}

/** Read a token's packed framing back into a focus, or null when absent/malformed (the default crop). */
export function unpackShareFocus(payload: ShareCardPayload): { x: number; y: number; zoom: number } | null {
  if (payload.k !== "milestone" || !payload.f) return null;
  const [x, y, zoom] = payload.f;
  if (![x, y, zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x, y, zoom };
}

/** Thirty days. A LinkedIn/Facebook scrape happens once, at share time; this bounds a later click-through. */
export const SHARE_CARD_TTL_SECONDS = 30 * 24 * 60 * 60;

function signingSecret(): string {
  const secret = process.env.PHOENIX_AUTH_SECRET?.trim();
  if (!secret) throw new Error("PHOENIX_AUTH_SECRET is required to issue a share-card link.");
  return secret;
}

/** Domain-separated from every other signer so a share token can never be replayed as one of theirs. */
function sign(encoded: string): string {
  return createHmac("sha256", signingSecret()).update(`share-card.v1\n${encoded}`).digest("base64url");
}

function encode(payload: ShareCardPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Mint a token for the caller's OWN card. The hr id is canonicalised so verify can compare it plainly. */
export function issueShareCardToken(
  input:
    | {
        kind: "milestone";
        hrId: string;
        spec: string;
        on: string;
        withoutPhoto?: boolean;
        focus?: { x: number; y: number; zoom: number } | null;
        nowSeconds?: number;
      }
    | { kind: "spotlight"; hrId: string; from: string; to: string; nowSeconds?: number },
): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const hr = canonicalHrIdKey(input.hrId) ?? "";
  if (!hr) throw new Error("A share-card link needs an HR id.");
  const exp = now + SHARE_CARD_TTL_SECONDS;
  // The framing is only meaningful for the record photo — never carry it with a monogram (no photo).
  const packedFocus = input.kind === "milestone" && !input.withoutPhoto ? packFocus(input.focus) : null;
  const payload: ShareCardPayload =
    input.kind === "milestone"
      ? {
          v: 1,
          k: "milestone",
          hr,
          spec: input.spec,
          on: input.on,
          ...(input.withoutPhoto ? { np: true } : {}),
          ...(packedFocus ? { f: packedFocus } : {}),
          exp,
        }
      : { v: 1, k: "spotlight", hr, from: input.from, to: input.to, exp };
  const encoded = encode(payload);
  return `${encoded}.${sign(encoded)}`;
}

/** Verify signature and expiry, and return the payload — or null for anything that is not a live token. */
export function readShareCardToken(token: string | null | undefined, nowSeconds?: number): ShareCardPayload | null {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  let expected: string;
  try {
    expected = sign(encoded);
  } catch {
    return null; // no secret → nothing verifies
  }
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) return null;

  let payload: ShareCardPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ShareCardPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || (payload.k !== "milestone" && payload.k !== "spotlight")) return null;
  if (typeof payload.exp !== "number" || payload.exp < (nowSeconds ?? Math.floor(Date.now() / 1000))) return null;
  if (typeof payload.hr !== "string" || payload.hr.length === 0) return null;
  if (payload.k === "milestone" && (typeof payload.spec !== "string" || typeof payload.on !== "string")) return null;
  if (payload.k === "spotlight" && (typeof payload.from !== "string" || typeof payload.to !== "string")) return null;
  return payload;
}

/** The public URL a token resolves at — always the production domain, the one a scraper can reach. */
export function shareCardPublicUrl(token: string): string {
  return `${systemDeployment.productionUrl}/share/card/${token}`;
}

/** The absolute image URL a scraper reads as og:image. */
export function shareCardImageUrl(token: string): string {
  return `${systemDeployment.productionUrl}/share/card/${token}/image`;
}
