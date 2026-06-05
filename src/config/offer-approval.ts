// Offer pipeline — per-position CEO-approval threshold + approval-chain roles.
//
// The approval chain is threshold based: HR Manager (HR Specialist) + Finance
// (Finance Manager) + the requisition's hiring manager (person step) always
// approve; the CEO is added only when the offered NET salary exceeds a
// per-position cap. The cap is resolved per position — the requisition salary
// band max wins, then an explicit per-title override, then the global default
// (shared with the existing at-hire senior-approval gate).

import type { PhoenixRole } from "@/lib/auth/permissions";

export const OFFER_APPROVAL_GLOBAL_DEFAULT_NET = 20000;

// Optional per-title CEO-approval caps (net monthly salary). Titles are matched
// case-insensitively after trimming/collapsing whitespace. Extend as policy evolves.
export const OFFER_CEO_APPROVAL_CAPS: Record<string, number> = {
  // "national sales manager": 60000,
  // "medical rep": 18000,
};

// Always-required approver roles (the hiring-manager person step is added separately).
export const OFFER_APPROVAL_ALWAYS_ROLES: readonly PhoenixRole[] = ["HR Specialist", "Finance Manager"] as const;
export const OFFER_APPROVAL_CEO_ROLE: PhoenixRole = "CEO";

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function offerApprovalGlobalThreshold(): number {
  const raw = Number(process.env.RECRUITMENT_SENIOR_APPROVAL_NET_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : OFFER_APPROVAL_GLOBAL_DEFAULT_NET;
}

// Pure: net-salary cap above which CEO approval is required.
// First hit wins: requisition band max → per-title override → global default.
export function resolvePositionApprovalThreshold(input: {
  jobTitle?: string | null;
  salaryBandMax?: number | null;
}): number {
  const band = typeof input.salaryBandMax === "number" && Number.isFinite(input.salaryBandMax) && input.salaryBandMax > 0
    ? input.salaryBandMax
    : null;
  if (band !== null) return band;

  const override = OFFER_CEO_APPROVAL_CAPS[normalizeTitle(input.jobTitle)];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;

  return offerApprovalGlobalThreshold();
}
