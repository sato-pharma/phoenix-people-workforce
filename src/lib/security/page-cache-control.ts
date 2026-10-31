/**
 * The Cache-Control every page answers with — Next.js's own value for a dynamic page, plus
 * `no-transform`. Set by `proxy.ts` on each page response that does not already carry one.
 *
 * WHY `no-transform`. Since 26 Oct 2026 production sits behind the Cloudflare proxy, and Cloudflare's
 * Email Address Obfuscation rewrites every address it finds in an HTML page into an
 * `<a class="__cf_email__">[email protected]</a>` and injects `/cdn-cgi/…/email-decode.min.js` to put
 * it back. The page script policy (content-security-policy.ts) refuses that script, so the address
 * stays "[email protected]" — and React, hydrating the Employees directory, found that text where it
 * rendered `name@satopharma.com` and threw Minified React error #418 (`args[]=text`) on every load,
 * re-rendering the whole tree in the browser. Measured: the synthetic "People Management loads"
 * journey carried the blocked email-decode script on every run from 26 Oct 08:18 Cairo, and on no
 * other journey. Cloudflare documents that obfuscation does not apply to a response carrying
 * `Cache-Control: no-transform` — so the fix covers every page that renders an address, not just
 * this one, and also keeps Cloudflare's other HTML rewrites off our nonce-checked pages.
 *
 * Next.js keeps a Cache-Control the proxy set (`send-payload.js`: "If cache control is already set
 * on the response we don't override it"), which is why the rest of the value must stay exactly
 * what Next would have sent for a dynamic page: never cached, by anyone. Pinned by
 * tests/page-cache-control-no-transform.test.ts.
 */
export const PAGE_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate, no-transform";
