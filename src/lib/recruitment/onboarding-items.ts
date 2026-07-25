// Recruitment / ATS — pre-boarding & joining checklist item definitions.
//
// Split out from onboarding.ts on purpose: this file has NO server-only imports (no
// Supabase client, no recruitment/requisitions -> employee-directory chain), so client
// components (RecruitmentWorkspace) can import documentsComplete/OnboardingItem as real
// values without pulling onboarding.ts's server-only dependency chain into the browser
// bundle. onboarding.ts re-exports everything here for its own (server-side) consumers.

export const onboardingDocumentItems = [
  { key: "national_id", label: "National ID" },
  { key: "military_certificate", label: "Military Certificate" },
  { key: "graduation_certificate", label: "Graduation Certificate" },
  { key: "personal_photo", label: "Personal Photo" },
  { key: "insurance_documents", label: "Insurance Documents" },
] as const;

export const onboardingJoiningItems = [
  { key: "employee_id", label: "Employee ID" },
  { key: "email_creation", label: "Email Creation" },
  { key: "system_access", label: "System Access" },
  { key: "payroll_setup", label: "Payroll Setup" },
  { key: "manager_notification", label: "Manager Notification" },
  { key: "orientation", label: "Orientation" },
  { key: "policy_acknowledgment", label: "Policy Acknowledgment" },
  { key: "team_introduction", label: "Team Introduction" },
  { key: "training_assignment", label: "Training Assignment" },
] as const;

export const onboardingItemStatuses = [
  "pending",
  "missing",
  "submitted",
  "approved",
  "rejected",
  "waived",
  "completed",
] as const;
export type OnboardingItemStatus = (typeof onboardingItemStatuses)[number];

export const onboardingItemCategories = ["document", "joining"] as const;
export type OnboardingItemCategory = (typeof onboardingItemCategories)[number];

export const terminalOnboardingStatuses: readonly string[] = ["approved", "rejected", "waived", "completed"];

export type OnboardingItem = {
  id: string;
  applicationId: string;
  category: OnboardingItemCategory;
  itemKey: string;
  label: string;
  status: OnboardingItemStatus;
  fileId: string | null;
  notes: string | null;
  completedBy: string | null;
  completedAt: string | null;
};

export type UpdateOnboardingItemInput = {
  status?: string | null;
  fileId?: string | null;
  notes?: string | null;
};

// Pure: required documents are complete when every document item is approved or waived.
export function documentsComplete(statuses: readonly string[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status === "approved" || status === "waived");
}

// Same null/trim semantics as recruitment/db.ts's textOrNull — duplicated (not imported)
// so this file stays free of db.ts's server-only Supabase client import.
function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapOnboardingItemRow(row: Record<string, unknown>): OnboardingItem {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    category: (textOrNull(row.category) ?? "document") as OnboardingItemCategory,
    itemKey: String(row.item_key ?? ""),
    label: String(row.label ?? ""),
    status: (textOrNull(row.status) ?? "pending") as OnboardingItemStatus,
    fileId: textOrNull(row.file_id),
    notes: textOrNull(row.notes),
    completedBy: textOrNull(row.completed_by),
    completedAt: textOrNull(row.completed_at),
  };
}
