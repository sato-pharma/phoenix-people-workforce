# The page Cache-Control, Cloudflare and compression

What every page answers in `Cache-Control`, and why. The code is `src/lib/security/page-cache-control.ts`.
`proxy.ts` calls it for each page response that does not already carry the header. It is pinned by
`tests/page-cache-control-no-transform.test.ts`.

## The value

| Request | Cache-Control | Compressed by Next.js |
| --- | --- | --- |
| Forwarded by Cloudflare (it carries `cf-ray`) | `private, no-cache, no-store, max-age=0, must-revalidate, no-transform` | No |
| Served straight from Railway | `private, no-cache, no-store, max-age=0, must-revalidate` | Yes (gzip) |

Without `no-transform`, the value is exactly what Next.js sends for a dynamic page: it is never cached,
by anyone. Redirects keep their own header. API routes and files decide their own caching.

## Why `no-transform` exists (31 Oct 2026)

From 26 Oct 2026, production sat behind the Cloudflare proxy. Cloudflare's Email Address Obfuscation
rewrote every work email in a page's server HTML into `[email protected]`, and it injected
`/cdn-cgi/…/email-decode.min.js` to put the address back. The page script policy refuses that script.
React therefore found different text on the Employees directory and threw #418 (`args[]=text`) on every
load. The synthetic "People Management loads" journey carried the blocked script on every run from
26 Oct 08:18 Cairo, and on that journey alone.

Cloudflare documents that obfuscation never touches a response marked `Cache-Control: no-transform`.
#6718 put that header on every page.

## Why it is only behind Cloudflare now (12 Nov 2026)

Next.js's standalone server compresses responses through `next/dist/compiled/compression`. That
middleware's `shouldTransform` refuses any response whose Cache-Control contains `no-transform`. So
#6718 also switched off compression for every page, while the scripts (which carry no such header) stayed
gzipped.

Measured on production on 12 Nov 2026:

- Phoenix Ranks was 1.7 MB of uncompressed HTML. The Ranks board alone is 609 KB raw and 35 KB gzipped.
- My Visits was 0.9 MB.
- `/login` was 32 KB raw, against 8 KB gzipped.
- `phoenix-hr.satopharma.com` resolved straight to Railway. The responses carried `x-railway-edge` and no
  `cf-ray`, so the proxy was no longer in front and the header was protecting nothing.

The guard now applies only to a request that carries `cf-ray`, which Cloudflare stamps on every request it
proxies to an origin. A page served directly gets Next's own value and is compressed. If the proxy is ever
switched back on, the guard returns by itself, with no code change.

## Never

- Never put `no-transform` back on a page served directly. Every phone then downloads the raw page.
- Never drop it for a request Cloudflare forwarded. React #418 returns on any page that shows an email
  address.
- Never fix a #418 with `suppressHydrationWarning`. A blocked `email-decode` script in a journey's console
  is this trap.
