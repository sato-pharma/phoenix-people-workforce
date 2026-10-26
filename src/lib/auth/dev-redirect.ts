import { NextResponse } from "next/server";

/**
 * A dev redirect that keeps the BROWSER's origin instead of echoing the server's own.
 *
 * `next dev` builds `request.url` from the address it is BOUND to, not from the `Host` header, so
 * `NextResponse.redirect(new URL(path, request.url))` emits an absolute `Location` carrying that
 * port. On a laptop that is invisible — bound port and browser port are both 3000. Under `phx-live`
 * they are not: the server is bound to `127.0.0.1:3100` on the Hetzner box while the browser reaches
 * it through an SSH tunnel on `localhost:3000`. So the dev-preview launch sent the tab to
 * `http://localhost:3100/admin`, where the laptop has nothing listening, and the preview died on an
 * empty error page — with the real session already revoked by the first hop, so there was no way
 * back either (owner, 2026-10-12: measured `Location: http://localhost:3100/admin` from
 * `/api/dev-auth` through the tunnel).
 *
 * A RELATIVE `Location` is resolved by the browser against the origin it actually used, so one
 * response is correct on either port. All three dev-auth hops go through here.
 *
 * It lives in its own module on purpose: `dev-preview.ts` is pulled in by `src/lib/auth/server.ts`
 * and therefore by most of the app, and `next/server` does not belong in that graph. The two route
 * handlers that call this already import `next/server` themselves.
 *
 * `status` is 307 for a GET hop (`/api/dev-auth`), and 303 from the preview switch, which is a POST
 * (audit point 17, 2026-10-26): a 307 would replay the POST onto the next hop, and only a 303 turns
 * the browser's next request into a plain GET.
 */
export function devRelativeRedirect(target: URL, status: 303 | 307 = 307) {
  return new NextResponse(null, {
    headers: { Location: `${target.pathname}${target.search}` },
    status,
  });
}
