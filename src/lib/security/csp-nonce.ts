/**
 * The page's script nonce, for the HTML this app frames from its own renderers.
 *
 * A `srcdoc` frame and a `blob:` document INHERIT the page's Content Security Policy — sandboxed or
 * not — so since the page policy dropped `'unsafe-inline'` (src/lib/security/content-security-policy.ts)
 * an inline `<script>` inside them runs only when it carries the page's nonce. The hiring paper typed
 * in by hand, the job-post picture, the cheque preview and the Milestones card preview all measure
 * and fit their text with one, and without the nonce each would paint unfitted with no error on screen.
 *
 * 🔴 STAMP ONLY HTML OUR OWN SERVER RENDERERS BUILT, whose values are escaped. Stamping a document
 * that carries somebody else's markup (a received email, an uploaded file) would hand its scripts
 * the page's nonce — those frames stay `sandbox=""` and are never passed through `withScriptNonce`.
 *
 * WHY THE NONCE IS CAPTURED AT BOOT, not read from the layout's props later: `router.refresh()` and a
 * server action re-render the root layout under a NEW request with a NEW nonce, and React then writes
 * that new value onto the boot scripts' `nonce` attribute — but the document's policy is still the
 * first one. `CSP_NONCE_CAPTURE_BOOT_SCRIPT` runs once, from the first response, and keeps the nonce
 * the document was actually served with, read-only.
 */

const NONCE_SHAPE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const CAPTURED_NONCE_KEY = "__phxCspNonce";

/** A value that can sit in `'nonce-…'` and in an HTML attribute unescaped. */
export function isCspNonce(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && NONCE_SHAPE.test(value);
}

/**
 * Runs first in <body> with the page nonce: keeps `document.currentScript.nonce` (the nonce this
 * document was served with) on `window`, read-only. A page served without a nonce keeps nothing.
 */
export const CSP_NONCE_CAPTURE_BOOT_SCRIPT = `(function(){try{var s=document.currentScript;var n=s&&s.nonce;if(n&&!(${JSON.stringify(
  CAPTURED_NONCE_KEY,
)} in window)){Object.defineProperty(window,${JSON.stringify(CAPTURED_NONCE_KEY)},{value:n});}}catch(e){}})();`;

/** The nonce this document was served with; undefined on the server and on a page without one. */
export function documentScriptNonce(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const captured = (window as unknown as Record<string, unknown>)[CAPTURED_NONCE_KEY];
  return isCspNonce(captured) ? captured : undefined;
}

/**
 * Puts `nonce` on every `<script>` start tag that does not carry one. Without a nonce the HTML is
 * returned unchanged, which is right for a page served under the next.config.ts policy.
 */
export function withScriptNonce(html: string, nonce: string | undefined): string {
  if (!isCspNonce(nonce)) return html;
  return html.replace(/<script(?=[\s>])(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}
