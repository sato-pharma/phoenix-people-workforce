import { redirect } from "next/navigation";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { fencedPageRedirect } from "@/lib/auth/seat-page-fences";

/**
 * THE PAGE'S OWN FENCE CHECK (technical audit, 2026-10-23, P7-06).
 *
 * The per-seat page fences (seat-page-fences.ts) were enforced in AppShell, which the shared admin
 * layout renders — and a layout is NOT re-rendered when the user moves between pages inside it. A
 * typed address or a bookmark was stopped; a link followed from inside the app was not, so a fenced
 * page rendered for the seat it was fenced from. A page re-renders on every navigation, so every
 * page the fences cover calls this with its own route, right after it resolves its access.
 * tests/access-boundaries.test.ts walks app/ and fails on a fenced page that does not.
 *
 * Sends the seat to its own landing page, as AppShell does. A seat whose landing page is fenced too
 * goes to the employee portal, which is outside the admin group — never back into a fence, so this
 * cannot loop.
 */
export function guardSeatPage(access: Pick<AccessContext, "role">, route: string): void {
  const target = fencedPageRedirect(access.role, route, resolveLandingPathForRole(access.role));
  if (target) redirect(target);
}
