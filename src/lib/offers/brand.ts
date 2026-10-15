import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two images an offer letter carries: the Sato Pharma mark, and the authorised signatory's
 * signature.
 *
 * ── Why there are two logo files, and why the wrong one is dangerous ──
 * `public/brand/sato-pharma-logo.png` draws the word SATO in WHITE. On the navy sidebar it was
 * made for that is correct; on the white paper of an offer letter the word disappears and the
 * letterhead of a legally binding document reads "PHARMA". `sato-pharma-logo-on-light.png` is the
 * same mark with SATO in ink, and it is the only one that may go on a letter.
 *
 * ── Why a data URI, and not the public URL ──
 * The PDF is rendered by Chromium through `setContent`, so the page has no origin and a relative
 * `/brand/...` resolves to nothing. An absolute `https://` URL would work but makes the letterhead
 * depend on the public site being reachable from inside the container at render time — and a logo
 * that silently vanishes from an offer letter is exactly the kind of failure nobody notices until a
 * candidate has already read it. Reading the file off disk cannot fail that way.
 *
 * Email is the opposite case and keeps the URL: Gmail and Outlook both drop `data:` images, so
 * `renderOfferEmail` is given the absolute public URL instead.
 *
 * ── Why the SIGNATURE is not in `public/` at all ──
 * Because nothing ever needs to fetch it. The email body deliberately draws no signature rules — it
 * says the signature page is in the attached PDF — so the mark is the only image email needs, and
 * the signature is wanted in exactly one place: the PDF, which embeds it as a data URI. Serving a
 * real person's signature from a guessable URL on the public site would hand a clean, transparent,
 * ready-to-paste copy to anyone who asked for it, in exchange for nothing.
 *
 * The cost of keeping it out of `public/` is that it ships only if it is TRACED: the Dockerfile's
 * runner stage copies `.next/standalone` and `public/`, and nothing else. `next.config.ts` includes
 * `./assets/brand/*.png` under the `/api` trace list for exactly that reason, and
 * `tests/pdf-canvas-trace.test.ts` runs that glob through Next's own glob implementation and
 * requires real files back — a trace entry that matches nothing looks identical to a working one.
 */

const LOGO_PUBLIC_PATH = "/brand/sato-pharma-logo-on-light.png";

/**
 * Read a PNG off disk as a `data:` URI, or null when it cannot be read.
 *
 * Null rather than a throw, for both callers. A missing logo falls back to setting the company name
 * in type; a missing signature falls back to the printed name over an empty rule, which is a letter
 * somebody signs by hand. Both are plainer than intended but neither is WRONG, and an offer that
 * failed to render at all would be worse than either.
 */
function svgDataUri(bytes: Buffer): string {
  return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
}

function pngDataUri(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

let logoCache: string | null | undefined;
let reverseLogoCache: string | null | undefined;
let signatureCache: string | null | undefined;
let sealCache: string | null | undefined;

/**
 * The Sato mark as a `data:` URI, for the PDF. Null when it cannot be read.
 *
 * `readFileSync(join(process.cwd(), 'literal', 'literal', 'literal'))` must stay written out
 * exactly like this, inline, with every segment a string literal — not passed in through a
 * variable or a rest parameter. Turbopack's build tracer only resolves a `join(process.cwd(), …)`
 * call it can statically read at the call site; the previous variadic-helper version defeated
 * that and made this ONE route trace the entire project (measured: 6,034 files / 441 KB, vs. 233
 * for a comparable route — Turbopack's own build warning named it "over bundling").
 */
export function satoLogoDataUri(): string | null {
  if (logoCache === undefined) {
    try {
      logoCache = pngDataUri(readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-light.png")));
    } catch {
      logoCache = null;
    }
  }
  return logoCache;
}

/**
 * The REVERSE Sato mark — SATO drawn in WHITE — as a `data:` URI, for the Sato corporate letter's
 * navy masthead band. Null when it cannot be read.
 *
 * This is the opposite file from `satoLogoDataUri()` above, and choosing between them matters: the
 * on-light mark (SATO in ink) vanishes on a navy band, and this reverse mark vanishes on white
 * paper. The Sato variant is the only design that draws on navy, so it is the only caller — the
 * classic and executive letters keep the on-light mark, and this reader is passed to the renderer
 * only when the template's variant is `sato`.
 *
 * IT READS `sato-pharma-logo-on-navy.png`, NOT `sato-pharma-logo.png`, and the extra file earns its
 * place: the shared on-dark mark only ever had SATO recoloured, so the word PHARMA kept its paper
 * blue #0A6BA6 and sat at 2.34:1 on this design's navy #17304d — under the 3:1 floor a graphic has
 * to clear, and legibly dim at the 30px the masthead draws it. The on-navy file is that same
 * artwork with PHARMA alone lifted to #1482C2, the house palette's own lightest blue (3.19:1); SATO
 * stays white and both waves keep their blues. 🔴 Do NOT "tidy" this back onto the shared file:
 * `sato-pharma-logo.png` is drawn by the CEO and Finance command centres, the joining form, the
 * business-review pack and the contract, and recolouring it would move every one of them.
 *
 * The literal `join(process.cwd(), …)` is load-bearing exactly as in the readers above: a variadic
 * helper here once made ONE route trace 6,034 files. Keep every segment a string literal, inline.
 */
export function satoLogoReverseDataUri(): string | null {
  if (reverseLogoCache === undefined) {
    try {
      reverseLogoCache = pngDataUri(
        readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-logo-on-navy.png")),
      );
    } catch {
      reverseLogoCache = null;
    }
  }
  return reverseLogoCache;
}

/**
 * The company seal as a `data:` URI — owner's instruction, 2026-09-11.
 *
 * A SEPARATE READER FROM THE HIRING PACK'S, on purpose. `paper-artwork.ts` rewrites `/brand/...`
 * paths at PDF time; the offer letters inline their assets at RENDER time instead, so a path here
 * would reach the PDF unresolved. Same file on disk, two mechanisms, and this is the offers' one.
 *
 * The literal `join` is load-bearing exactly as it is above: a variadic helper here once made ONE
 * route trace 6,034 files.
 */
export function satoSealDataUri(): string | null {
  if (sealCache === undefined) {
    try {
      sealCache = svgDataUri(readFileSync(join(process.cwd(), "public", "brand", "sato-hr-seal.svg")));
    } catch {
      sealCache = null;
    }
  }
  return sealCache;
}

/** The same mark as an absolute URL, for email clients that refuse `data:` images. */
export function satoLogoUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${LOGO_PUBLIC_PATH}`;
}

/**
 * The Content-ID the offer email's letterhead `<img src="cid:…">` points at.
 *
 * ── Why the email stopped linking to the mark, 2026-09-17 ──
 * It used to carry `satoLogoUrl(...)`, an absolute https link to the same PNG the site serves.
 * The asset was never the problem — it answers 200 with a valid 401x158 PNG — but a REMOTE image
 * is only drawn if the reader's mail client agrees to go and fetch it, and Outlook, Yahoo/Turbify
 * webmail and Gmail all withhold that by default for a sender nobody has whitelisted. What the
 * owner saw in his BCC copy of SP-HR-MR-2026-005 was the browser's torn-page placeholder and the
 * alt text where the Sato mark belongs — on the letterhead of a legally binding offer.
 *
 * A `cid:` reference is resolved from a part of the message itself, so there is nothing to fetch
 * and nothing to block: the mark draws on first open, offline, in every client that has handled
 * MIME since 1996. It is NOT the `data:` URI the PDF uses — that is the one form Gmail and Outlook
 * really do strip, which is what the note at the top of this file is about.
 */
export const SATO_LOGO_CONTENT_ID = "sato-pharma-mark";

/** `src` value for the letterhead image when the mark travels inside the message. */
export const SATO_LOGO_CID_SRC = `cid:${SATO_LOGO_CONTENT_ID}`;

export type SatoLogoAttachment = {
  content: string;
  contentId: string;
  contentType: string;
  filename: string;
  /** Where a provider with no Content-ID support can point the same `<img>` instead. */
  remoteUrl: string;
};

/**
 * The mark as an inline message part, or null when the file cannot be read.
 *
 * Deliberately derived from `satoLogoDataUri()` rather than reading the PNG a second time: that
 * reader's literal `join(process.cwd(), …)` is what keeps Turbopack's tracer from over-bundling
 * this route (see above), and a second `readFileSync` here would be a second thing to keep exactly
 * right. Null flows through to the https URL, i.e. to exactly today's behaviour — never to a
 * letterhead with no mark at all.
 */
export function satoLogoAttachment(baseUrl: string): SatoLogoAttachment | null {
  const dataUri = satoLogoDataUri();
  if (!dataUri) return null;
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  if (!base64) return null;
  return {
    content: base64,
    contentId: SATO_LOGO_CONTENT_ID,
    contentType: "image/png",
    filename: "sato-pharma-logo.png",
    remoteUrl: satoLogoUrl(baseUrl),
  };
}

/**
 * The authorised signatory's signature as a `data:` URI, for the PDF.
 *
 * There is deliberately no URL form of this. See the note above: the signature belongs in the
 * attachment and nowhere else, and adding a public accessor is the change that would quietly undo
 * that decision.
 */
export function satoSignatureDataUri(): string | null {
  if (signatureCache === undefined) {
    try {
      signatureCache = pngDataUri(readFileSync(join(process.cwd(), "assets", "brand", "signature-omar-anwar-gawish.png")));
    } catch {
      signatureCache = null;
    }
  }
  return signatureCache;
}
