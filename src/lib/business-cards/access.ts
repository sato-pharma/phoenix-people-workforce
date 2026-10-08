import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * Who may PRINT business cards — the staff picker at /business-cards and its PDF export,
 * POST /api/business-cards. One predicate for both, so the page and the route cannot drift.
 *
 * An HR seat, and one of two keys:
 *   - `employee_documents:read` — HR Advisory and HR Operations, as before; printing cards sat beside
 *     HR Forms on that key.
 *   - the Talent Acquisition seat (`HR Resourcing`) through `business_card_requests:update` — the
 *     desk she already works. The owner ticked Business Cards for her on 2026-10-08 and left the
 *     employment documents (contracts, salary letters) OUT, so she cannot be handed
 *     `employee_documents`; the card itself carries only a name, title, phone and work email, which
 *     is what the request desk already shows her.
 */
export async function canPrintBusinessCards(access: AccessContext): Promise<boolean> {
  if (!isHrAuthorityRole(access.role)) return false;
  if (await canAccess(access, "employee_documents", "read")) return true;
  return access.role === "HR Resourcing" && (await canAccess(access, "business_card_requests", "update"));
}
