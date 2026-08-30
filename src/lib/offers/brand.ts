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
function pngDataUri(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

let logoCache: string | null | undefined;
let signatureCache: string | null | undefined;

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

/** The same mark as an absolute URL, for email clients that refuse `data:` images. */
export function satoLogoUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${LOGO_PUBLIC_PATH}`;
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
