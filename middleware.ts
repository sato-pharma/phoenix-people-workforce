import { NextResponse, type NextRequest } from "next/server";

import {
  HR_NAMESPACE_PREFIX,
  PATH_HEADER,
  SHELL_HEADER,
  isHrNamespacePath,
} from "@/lib/navigation/shell-headers";

/**
 * The `/hr` URL namespace.
 *
 * ## Why this file exists at all
 *
 * The owner asked (2026-08-28) for the two HR seats to live on their own addresses, away from
 * the admin ones — "due to security reasons and due to not see things they are not should be
 * able to see". There were three ways to give them that, and two of them are traps:
 *
 *   1. Mirror every page under `app/(hr)/hr/…`. This is the trap that stranded the retired
 *      Talent Acquisition seat: every admin tool needed a second copy, the copies drifted, and
 *      two of them shipped unreachable. The union of what both HR seats can open is 36 pages
 *      today and grows with every module — 36 files that must each stay in step with a page
 *      they do not import.
 *   2. `next.config` rewrites. A rewrite is invisible to the application: `/hr/probation`
 *      renders `app/(admin)/probation/page.tsx` and NOTHING downstream can tell it came in
 *      under `/hr`, because a layout receives neither the request URL nor searchParams. The
 *      shell would render admin navigation on an HR address.
 *   3. This: rewrite in middleware, and hand the original path down as request headers so the
 *      layout can see it. One file, no page duplication, and every policy decision stays in
 *      the layout where the access context already lives.
 *
 * ## What this deliberately does NOT do
 *
 * **No authentication, no authorization, no secrets, no database.** It does not read the
 * session cookie, does not verify the JWT, does not know who the viewer is, and cannot refuse
 * anyone. That is not an oversight — it is the safety property. `resolveSessionState` needs the
 * signing secret and three Supabase lookups, and putting any of that on the request path of a
 * live payroll system, in a file that runs before every matched request, is a much larger
 * change than the one being asked for. Access control stays exactly where it is today: the
 * route-group layout and `assertPermission` in each route handler.
 *
 * So the worst this file can do if it is wrong is serve the correct page under the wrong
 * chrome. It cannot let anyone in.
 *
 * ## The contract with the layout
 *
 * Every matched request carries `x-phoenix-path` — the address the browser actually asked for.
 * A request under `/hr` additionally carries `x-phoenix-shell: "hr"` and is rewritten:
 *
 *   /hr/probation  ->  renders /probation,  x-phoenix-shell: hr,  x-phoenix-path: /hr/probation
 *   /probation     ->  renders /probation,  (no shell header),    x-phoenix-path: /probation
 *
 * The path header is set on NON-rewritten requests too, and that is load-bearing rather than
 * incidental: it is how `app/(admin)/layout.tsx` knows where to send an HR seat that arrived on a
 * bare admin address — one of the ~827 notification links already sitting on people's phones, a
 * bookmark, or a plain in-page `<Link href="/admin/…">`. One redirect built from this header
 * covers all of them, so no href anywhere in the app has to learn about the namespace.
 *
 * Both headers are STRIPPED from any inbound request first (see below), so they cannot be forged.
 * `/hr` with no rest is rewritten to `/`, which resolves to the viewer's own landing page and
 * then bounces back into the namespace — deliberately, so the home lives in one place
 * (`resolveLandingPathForRole`) instead of being hardcoded in an edge bundle that cannot import it.
 */

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // A client can set any header it likes. These two are ours, and downstream code trusts them
  // to decide which navigation to render — so delete whatever arrived and write our own. Done
  // for EVERY matched request, including ones we do not rewrite, so there is no path through
  // this file that forwards an attacker-supplied value.
  const headers = new Headers(request.headers);
  headers.delete(SHELL_HEADER);
  headers.delete(PATH_HEADER);
  headers.set(PATH_HEADER, `${pathname}${search}`);

  if (!isHrNamespacePath(pathname)) {
    return NextResponse.next({ request: { headers } });
  }

  // "/hr" -> "/", "/hr/probation" -> "/probation". Never an empty string, which is not a
  // valid pathname and would throw inside NextURL.
  const rest = pathname === HR_NAMESPACE_PREFIX ? "/" : pathname.slice(HR_NAMESPACE_PREFIX.length);

  const url = request.nextUrl.clone();
  url.pathname = rest;

  headers.set(SHELL_HEADER, "hr");

  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  // Scoped as tightly as it can be while still stripping the forgeable headers everywhere they
  // could be believed. `/hr/:path*` is the namespace itself; the rest of the app is matched only
  // so an inbound `x-phoenix-shell` never reaches a layout. Static assets, images and the
  // favicon are excluded — they render no navigation, so there is nothing there to spoof, and
  // running middleware on them is pure latency on every page load.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
