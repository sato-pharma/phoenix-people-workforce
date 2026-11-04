import { canAccess, isHiringPaperworkRole } from "@/lib/auth/permissions";
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
 *   - the HR Operations Specialist seat (`HR Administration`, the Office Coordinator) on the same
 *     `employee_documents:read` that `hiring_desk` gives her (owner, 2026-11-04: "make sure the
 *     business cards module is showing at the office coordinator account to be able to select
 *     employees and print cards"). `isHiringPaperworkRole` admits her beside the HR authority
 *     seats without putting her inside `hrAuthorityRoles`, so recruitment, offers and candidates
 *     stay shut to her.
 */
export async function canPrintBusinessCards(access: AccessContext): Promise<boolean> {
  if (!isHiringPaperworkRole(access.role)) return false;
  if (await canAccess(access, "employee_documents", "read")) return true;
  return access.role === "HR Resourcing" && (await canAccess(access, "business_card_requests", "update"));
}
