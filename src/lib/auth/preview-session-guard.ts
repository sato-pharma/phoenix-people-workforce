// A preview session may LOOK at anything and DECIDE nothing.
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
//
// On 2026-09-03 at 00:43 Cairo an outstation expense of 383.62 was approved on production by
// `dev.preview` — a dev-preview session, not a person. It reached `outstation_expenses.approved_by`
// and from there, through `phx_refresh_expense_claims`, into `expense_claims.decided_by_hr_id`: the
// column the claims screen reads to answer "who decided this". The screen therefore named a session
// as the decider of a real employee's money.
//
// Nothing was paid on it — that row recorded no approved amount — and the damage stayed small by
// luck rather than by design.
//
// ── WHY THIS GUARD IS NOT CONDITIONED ON THE ENVIRONMENT ────────────────────────────────────────
//
// The obvious shape is `if (isProductionRuntime()) refuse`. It would not have stopped this, and
// would read as though it had.
//
// `.env.local` points at the PRODUCTION Supabase project, so `pnpm run dev` writes production data
// from a runtime that calls itself development. The dangerous caller is therefore precisely the one
// an `isProductionRuntime()` check waves through: a local server, holding production credentials,
// whose `APP_ENV` says it is not production. That is the same inversion the repo already records
// about `!isProductionRuntime()` — it reads as "only in dev" and means "anywhere not labelled
// production".
//
// So the rule has no environment term at all. A preview session is never a person, anywhere, and a
// decision recorded from one is never true. Refusing it unconditionally is both simpler and the
// only version that catches the case that actually happened.
//
// ── WHAT COUNTS AS A PREVIEW SESSION ────────────────────────────────────────────────────────────
//
// `AccessContext.source` is `"dev-header"` for all three ways one is minted: the two request-header
// paths in `auth/server.ts` used by role sweeps, and the signed cookie in `auth/dev-preview.ts`
// behind `GET /api/dev-auth`. One field covers every route in, which is why the check lives on the
// source rather than on the login id — `dev.preview` was the login id in this incident only because
// that session carried no HR id, and a preview session that carries one would have written a real
// person's id instead, indistinguishable afterwards from a decision they made themselves.

import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * True when this context came from dev-auth — a header sweep or the dev-preview cookie — or is the
 * Super Admin's read-only View as Seat (src/lib/auth/seat-view.ts), which is a preview by another road:
 * it LOOKS as another seat and must decide nothing as one.
 */
export function isPreviewSession(access: Pick<AccessContext, "source" | "seatView">): boolean {
  return access.source === "dev-header" || Boolean(access.seatView);
}

/**
 * Refuse a decision made by a preview session.
 *
 * `what` names the decision in the words the caller would use, because this message can reach a
 * developer who has no idea they are signed in as a preview: "Sign in as yourself" is the fix, and
 * saying so is cheaper than the hour they would otherwise spend on the 403.
 */
export function assertRealSessionForDecision(
  access: Pick<AccessContext, "source" | "seatView">,
  what: string,
): void {
  if (!isPreviewSession(access)) return;
  if (access.seatView) {
    throw forbiddenError(
      `You are viewing another seat, read only, so you cannot ${what} here. Leave the view to act as yourself.`,
    );
  }
  throw forbiddenError(
    `A dev-preview session cannot ${what}. It is a way to SEE the app as another role, not to act ` +
      `as one — and this database is production. Sign in as yourself to record a real decision.`,
  );
}
