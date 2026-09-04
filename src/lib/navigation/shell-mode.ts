import {
  resolveNavigationMode,
  type AccessContext,
  type NavigationMode,
} from "@/lib/auth/permissions";

/**
 * The value `proxy.ts` writes into `SHELL_HEADER` on every request inside the `/hr` namespace.
 *
 * Kept beside the rule that reads it rather than in `shell-headers.ts`: that module is imported by
 * `proxy.ts` and so is bundled for the edge runtime on every request, and it is deliberately free
 * of anything heavier than two strings and four pure functions. This module imports
 * `@/lib/auth/permissions`, which is not edge-cheap, so the two must not merge.
 */
const HR_SHELL = "hr";

/**
 * Which navigation mode a SERVER-RENDERED surface is in — admin, hr, or the employee portal.
 *
 * ── Why this is not `resolveNavigationMode` ──────────────────────────────────────────────────
 * `resolveNavigationMode` answers the question about the PERSON and deliberately never returns
 * `"hr"` (see its own doc comment): the mode a shell renders in is a property of the ADDRESS, not
 * of the account. `/hr/probation` renders HR navigation and `/probation` renders admin navigation
 * for the same viewer, and the middleware header is the only thing that tells them apart.
 *
 * So every server component that needs the mode its OWN page is being rendered under has to
 * combine the two, and getting it wrong fails silently and plausibly: an HR seat is handed the
 * admin navigation config under HR chrome, which looks like a working page rather than a bug.
 * That is exactly what `app/(admin)/admin/sidebar-layout/page.tsx` did until this existed — it
 * hardcoded `getNavigationSections("admin")`, so an HR seat arranged the admin catalogue while
 * their rows render from the HR one, and `applyPersonalLayout` silently dropped every href they
 * placed because the two catalogues use disjoint prefixes.
 *
 * ── This selects CHROME, never access ────────────────────────────────────────────────────────
 * Being wrong here shows the right page under the wrong navigation. Every page behind the shell
 * re-asserts its own grant server-side, and a navigation catalogue is gated per-caller by
 * `getSections` before anything is rendered from it.
 *
 * @param access      the resolved access context for this request
 * @param shellHeader the raw `SHELL_HEADER` value off the request, or null when absent
 * @param override    a mode the caller states outright, which wins over the person but NOT over
 *                    the header — `app/(admin)/layout.tsx` passes `"admin"` for the whole route
 *                    group, and an HR seat inside it still has to render HR chrome.
 */
export function resolveShellNavigationMode(
  access: AccessContext,
  shellHeader: string | null | undefined,
  override?: NavigationMode,
): NavigationMode {
  if (shellHeader === HR_SHELL) return "hr";
  return override ?? resolveNavigationMode(access);
}
