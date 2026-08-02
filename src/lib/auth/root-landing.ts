import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { verifySessionToken } from "@/lib/auth/session-token";

/**
 * Where a request for "/" should be sent, decided from the signed session cookie alone.
 *
 * This exists so the entry point of the app can be resolved in `proxy.ts` — BEFORE any
 * rendering starts — and answered with a real HTTP 307. The previous design resolved "/"
 * inside an async server component (`app/page.tsx`), and because `app/loading.tsx` wraps the
 * root segment in a Suspense boundary, Next.js flushed the HTML shell (the "Loading Phoenix
 * Workforce..." spinner) before that component finished. Once the shell is flushed the
 * response headers are committed, so Next cannot emit a 307 any more and downgrades the
 * redirect to an RSC error digest (`NEXT_REDIRECT;replace;/login;307;`) that only runs after
 * the client JS bundle boots and hydrates. On a slow or flaky mobile connection that left
 * users staring at the spinner forever, with no error and no way out.
 *
 * SECURITY: this only chooses a URL — it grants nothing. The signature IS verified here (so a
 * role cannot be forged), but the session is deliberately NOT validated against the database:
 * that costs three queries on every hit of "/" and every destination page re-validates the
 * session properly anyway. A revoked-but-unexpired token is therefore routed to its landing
 * page and bounced to /login from there, exactly as it was before.
 */
export function resolveRootRedirectPath(sessionCookieValue: string | null | undefined): string {
  const payload = verifySessionToken(sessionCookieValue);
  if (!payload?.role) return "/login";

  return resolveLandingPathForRole(payload.role);
}
