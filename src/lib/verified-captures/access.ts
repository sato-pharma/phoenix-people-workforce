import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Who may open the Verified Captures gallery.
//
// SUPER ADMIN ONLY (owner, 2026-09-24, asked in chat). The page shows customers' live photos,
// their home/venue GPS locations and the reps who captured them — the most sensitive evidence the
// two modules hold, gathered onto one screen. So the gate is the narrowest one the app has, and
// deliberately narrower than the Validated Customers register (which also admits the SFE Manager,
// view-only): a company-wide photo-and-location gallery is a different exposure from one module's
// desk, and the owner drew the line at himself.
//
// `scope === "system"` covers the Super Admin's own system scope; the role check covers the seat.
// The absence of a permission prompt is not approval (AGENTS.md §1.5) — this predicate IS the gate,
// asserted in every loader and re-checked at the page.
// ─────────────────────────────────────────────────────────────────────────────
export function canOpenVerifiedCaptures(access: Pick<AccessContext, "role" | "scope">): boolean {
  if (access.scope === "system") return true;
  return access.role === "Super Admin";
}

export function assertVerifiedCapturesAccess(access: AccessContext) {
  if (!canOpenVerifiedCaptures(access)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot open the verified captures gallery.`);
  }
}
