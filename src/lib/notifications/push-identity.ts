import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { isReadOnlyViewer } from "@/lib/auth/read-only-viewer";

/**
 * The HR id this browser's push subscription is registered under, or null when the session has no
 * push identity — the ONE rule, so the shell can print it into its HTML and the browser need not ask
 * /api/notifications/push/context for it on every page it opens.
 *
 * WHY. The OneSignal provider fetched the context route on every page load, for every role, and that
 * request cost a session read and about 450 ms at Supabase's edge on the saturated host (1 Nov 2026).
 * The server rendering the shell already holds the resolved session, so it answers the same question
 * for free and hands the result down as a prop (`pushHrId`).
 *
 * The rule itself is the context route's, unchanged, and that route stays live for the phone app
 * (mobile/src/lib/push.tsx reads `appId` and `hrId` from it). The two must agree, and
 * tests/shell-chatter.test.ts pins both to the same expression:
 *   - uppercased, to match the form pushes are addressed to (src/lib/notifications/system.ts cleanHrId)
 *     and the form push_subscriptions.hr_id is stored in — OneSignal external ids are case-sensitive;
 *   - a test login gets NO identity: its hrId is the real person it mirrors, and OneSignal.login() with
 *     it would move the test device onto HER push user (src/lib/auth/test-persona.ts; risk review,
 *     2026-09-28). The Super Admin's View as Seat gets none either — the owner's device must never
 *     move onto the person he is viewing.
 */
export function pushIdentityOf(access: Pick<AccessContext, "hrId" | "seatView" | "testPersona">): string | null {
  return isReadOnlyViewer(access) ? null : access.hrId ? access.hrId.trim().toUpperCase() : null;
}

/**
 * The same answer the context route gives, permission included: a viewer the route would refuse
 * (`employee_profile:read`) gets null here, which the provider reads as "do not register".
 */
export async function resolvePushIdentity(access: AccessContext): Promise<string | null> {
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch {
    return null;
  }
  return pushIdentityOf(access);
}
