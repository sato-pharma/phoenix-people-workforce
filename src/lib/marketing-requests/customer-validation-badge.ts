import { buildValidationBadge, type ValidationBadge } from "@/lib/validation/validation-badge";
import type { MarketingValidationStatus } from "@/lib/marketing-requests/types";

/**
 * The "already validated" stamp for the marketing-request approver window (owner, 2026-09-22).
 *
 * A marketing customer's `validation_status` carries the whole story, and each value reads honestly:
 *   - `sfe_validated`   — the Validation Desk adjudicated it → a person, named, at `validated_at`;
 *   - `admin_approved`  — a reviewer approved it on a link    → a person, named, at `validated_at`;
 *   - `system_validated`— the evidence-gate passed it, NO HUMAN LOOKED → "by the system", and the
 *     honest "when" is the evidence-capture moment (there is no reviewer and no decision time);
 *   - `pending` / `rejected` — not validated → no stamp.
 *
 * Pure and exported so the human/system split is testable without a database. The name is only ever
 * shown in the two human cases — never for `system_validated`, where any hr id on the row is the
 * capturing owner, not an independent reviewer.
 */
export function resolveMarketingCustomerValidationBadge(input: {
  status: MarketingValidationStatus | null | undefined;
  /** Resolved full name of the human validator (validated_by_hr_id), or null. */
  validatedByName: string | null;
  /** validated_at — the human decision time. */
  validatedAt: string | null;
  /** evidence_photo_captured_at — the fallback "when" for the system case. */
  capturedAt: string | null;
}): ValidationBadge | null {
  const status = input.status ?? "pending";
  const isHuman = status === "sfe_validated" || status === "admin_approved";
  const validated = isHuman || status === "system_validated";
  return buildValidationBadge({
    validated,
    isHuman,
    byName: input.validatedByName,
    atIso: input.validatedAt ?? input.capturedAt,
    method: status === "sfe_validated" ? "desk" : status === "admin_approved" ? "approved on a link" : null,
  });
}
