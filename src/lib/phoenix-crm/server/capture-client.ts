/**
 * Phoenix CRM — which client sent this request, and the one thing that answer is allowed to decide.
 *
 * ## Why this exists
 *
 * The offline capture claim (`@/lib/phoenix-crm/offline-clock`) lets a phone date a visit to a moment
 * BEFORE the save arrived, and that is the whole point of it: a rep in a dead spot logs a door at
 * 19:00, the queue drains at 02:30, and the visit belongs to the 19:00 day. The claim is bounded
 * from ABOVE by physics — the elapsed time can never exceed the window the server itself brackets
 * with its own two readings — and it is deliberately NOT bounded from below, because a small elapsed
 * time is exactly what an honest capture taken moments after anchoring looks like.
 *
 * **Only the app may make that claim.** The web app's one queue (`visit-outbox.ts`, the visit retry,
 * owner 3 Nov 2026) sends a held press again dated at ARRIVAL, inside two hours and never across 02:00:
 * nothing under `src/components/phoenix-crm` has ever sent an `offline` body, and nothing there asks
 * for an anchor. So in a browser the claim is a field with no honest
 * sender and one dishonest one — a rep with devtools can take an anchor on Monday afternoon and
 * post `offline: { anchorId, elapsedMs: 0 }` on Tuesday, and the visit is filed, counted and read as
 * Monday's. Monday is a day whose plan is closed and whose figures have been read.
 *
 * The answer is structural rather than a tighter bound: **a browser may not make the claim at all,
 * and may not take an anchor to make one with.** Nothing the web app does today changes, because the
 * web app never used either.
 *
 * ## How a browser is recognised
 *
 * The web app carries its session in the `phoenix_session` cookie; the app carries the SAME signed
 * token in an `Authorization: Bearer` header (`@/lib/auth/native-session` explains why, and why that
 * grants nothing a cookie does not). `resolveAccessContext` tries the COOKIE FIRST and returns on
 * it, so a request that presents one was identified by it — it is the web app, whatever else it also
 * sends. That includes the app's own WebView, which holds a cookie of its own and renders the web
 * portal's pages: those pages are the web app and make no such claim either.
 *
 * 🔴 **It fails towards `browser`, which is the safe direction.** A caller that is neither — a local
 * dev-auth role sweep, a system caller — reads as a browser here and gets the arrival time. Losing
 * an offline claim costs a visit nothing: the save still happens, dated at arrival, and the rep is
 * told nothing at all (Golden Rule #1).
 *
 * 🔴 **What this is NOT.** It is not authentication, it grants nothing, and it decides no permission
 * — `assertPermission` and the territory gates are untouched and run exactly as before. It answers
 * one question: may this request's body move a visit's date backwards. It is also not a claim that a
 * bearer token PROVES the app: a token is a token, and hardening that is a device-bound refresh
 * token, which `native-session.ts` already names as a later phase and which this file does not fake.
 */

import { bearerTokenFromAuthorizationHeader } from "@/lib/auth/native-session";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";

/** Which Phoenix CRM client a request came from. `browser` is the fallback, and the safe one. */
export type CaptureClient = "app" | "browser";

/**
 * The client this request came from, read from its headers alone.
 *
 * A session cookie means the web app. A bearer token and no cookie means the app. Anything else is
 * treated as the web app, so the capability this gates is never granted by accident.
 */
export function captureClientOf(headers: Headers): CaptureClient {
  if (getCookieValue(headers.get("cookie"), phoenixSessionCookieName)) return "browser";
  return bearerTokenFromAuthorizationHeader(headers.get("authorization")) ? "app" : "browser";
}
