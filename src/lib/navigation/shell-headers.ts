/**
 * The request-header contract between `middleware.ts` and the server components that render the
 * shell. Deliberately a standalone, dependency-free module: `middleware.ts` is bundled for the
 * edge runtime, so anything it imports is pulled into a bundle that runs on every request. This
 * file holds two strings and two pure functions and nothing else — no config, no lucide icons, no
 * Supabase client.
 *
 * Why constants rather than the literals inline in both places: a typo in one of two hand-written
 * header names fails SILENTLY. The layout would simply never see the shell header, render admin
 * chrome on an `/hr` address, and look like it worked.
 */

/** Set to `"hr"` by middleware on any request under `/hr`. Absent on every other request. */
export const SHELL_HEADER = "x-phoenix-shell";

/**
 * The address the BROWSER asked for, set by middleware on every matched request — including the
 * ones it does not rewrite. A server component cannot otherwise learn its own URL.
 */
export const PATH_HEADER = "x-phoenix-path";

/** The URL prefix the `/hr` namespace lives under. One place, so nothing can disagree about it. */
export const HR_NAMESPACE_PREFIX = "/hr";

/** True when `pathname` is inside the `/hr` namespace. `/hrsomething` is NOT. */
export function isHrNamespacePath(pathname: string): boolean {
  return pathname === HR_NAMESPACE_PREFIX || pathname.startsWith(`${HR_NAMESPACE_PREFIX}/`);
}

/**
 * `/probation` -> `/hr/probation`, and already-prefixed paths are returned untouched so this is
 * safe to apply twice. Used to build the redirect that pulls an HR seat off a bare admin address.
 */
export function toHrNamespacePath(pathname: string): string {
  if (isHrNamespacePath(pathname)) return pathname;
  if (!pathname.startsWith("/")) return HR_NAMESPACE_PREFIX;
  return pathname === "/" ? HR_NAMESPACE_PREFIX : `${HR_NAMESPACE_PREFIX}${pathname}`;
}

/**
 * The part of an `/hr` address that names the real page. `/hr` itself resolves to `/`, which is
 * never an empty string — an empty pathname is not valid and throws inside NextURL.
 */
export function hrNamespaceRemainder(pathname: string): string {
  if (!isHrNamespacePath(pathname)) return pathname;
  return pathname === HR_NAMESPACE_PREFIX ? "/" : pathname.slice(HR_NAMESPACE_PREFIX.length);
}

/**
 * Whether `proxy.ts` may rewrite this address into the real page.
 *
 * `/hr/api/**` is deliberately EXCLUDED, and that exclusion is a security boundary rather than a
 * tidiness rule. The CSRF guard in `proxy.ts` is scoped to paths that start `/api/`; if `/hr/api/x`
 * were rewritten to `/api/x`, a cross-site POST could reach any API route through the `/hr` spelling
 * with that guard never running. Refusing the rewrite makes `/hr/api/x` resolve to nothing (404),
 * so there is no second spelling of the API surface at all.
 *
 * Nothing legitimate is lost: pages fetch their APIs with root-relative URLs (`/api/...`), which are
 * unaffected by the address the page itself was served under.
 */
export function isHrRewritablePath(pathname: string): boolean {
  if (!isHrNamespacePath(pathname)) return false;
  const rest = hrNamespaceRemainder(pathname);
  return rest !== "/api" && !rest.startsWith("/api/");
}
