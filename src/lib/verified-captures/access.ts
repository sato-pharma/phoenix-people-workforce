import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError } from "@/lib/http/api-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Who may open the Verified Captures gallery.
//
// SUPER ADMIN AND SFE MANAGER (owner, 2026-09-29). The page shows customers' live photos,
// their home/venue GPS locations and the reps who captured them — the most sensitive evidence the
// two modules hold, gathered onto one screen. So the gate is the narrowest one the app has, and
// WIDENED 2026-09-29, in the owner's own words (“add the SFE Manager to verified captures”), when
// the photo-vs-location readout landed on this page. It was Super Admin only from 2026-09-24,
// deliberately narrower than the Validated Customers register (which already admits the SFE
// Manager, view-only). The readout is an INTEGRITY SIGNAL, and AGENTS.md §4 CRM golden rule #1
// names the Super Admin and the SFE Manager as the two who may read one - so the gallery now
// matches the rule the signal on it is governed by, rather than sitting one notch tighter.
//
// It remains the narrowest gate in the app, and it is still nowhere near the field: nobody whose
// own capture appears here can open it.
//
// `scope === "system"` covers the Super Admin's own system scope; the role check covers the seat.
// The absence of a permission prompt is not approval (AGENTS.md §1.5) — this predicate IS the gate,
// asserted in every loader and re-checked at the page.
// ─────────────────────────────────────────────────────────────────────────────
export function canOpenVerifiedCaptures(access: Pick<AccessContext, "role" | "scope">): boolean {
  if (access.scope === "system") return true;
  return access.role === "Super Admin" || access.role === "SFE Manager";
}

export function assertVerifiedCapturesAccess(access: AccessContext) {
  if (!canOpenVerifiedCaptures(access)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot open the verified captures gallery.`);
  }
}
