// ─────────────────────────────────────────────────────────────────────────────
// The two browser navigations Next's client router deliberately must not do.
//
// `@next/next/no-location-assign-relative-destination` tells every `window.location`
// write to become `useRouter().push()`. That is right for an ordinary in-app link and
// wrong for both callers below — so the reason lives here, named, once, instead of being
// re-argued at twenty-four call sites across payroll, auth, recruitment and the portal.
//
//   • downloadFromApiRoute — the destination is an `/api/**` route answering with
//     `Content-Disposition: attachment`. It is not a page at all: the client router has
//     no route to render for it, so `push()` does not produce a slow download, it
//     produces no download. Every caller is a Download button.
//
//   • hardNavigate — the full document load IS the point. Each caller has either just
//     invalidated the session (heartbeat 401, sign-out, password change) or just
//     committed a payroll mutation, and needs the router's cached RSC payload and the
//     in-memory React tree thrown away rather than reused. `push()` keeps both, which is
//     precisely the state these callers exist to be rid of — a signed-out user rendered
//     from a cached authenticated layout, or a payroll batch page rendered from data
//     that predates the upload that just landed.
//
// They are one line of the same primitive and two names on purpose: the primitive is not
// the point, the reason is, and the reason differs. Keeping them apart also means that if
// downloads ever move to an anchor carrying `download`, only one of them changes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hand a same-origin `/api/**` download to the browser. Not a page navigation — the
 * response is an attachment, so the current page stays exactly where it is.
 */
export function downloadFromApiRoute(url: string): void {
  window.location.assign(url);
}

/**
 * Navigate with a full document load, deliberately discarding every piece of client
 * state: the router cache, the React tree, and any module-level memory. Use only where
 * reusing that state would be the bug.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
