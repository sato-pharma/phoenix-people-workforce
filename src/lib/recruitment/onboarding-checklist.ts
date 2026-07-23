// Recruitment / ATS — pure onboarding-checklist shape (no DB/server imports).
//
// Split out of onboarding.ts so a client component (recruitment-workspace.tsx, which only
// needs documentsComplete()/OnboardingItem to render checklist state) doesn't transitively pull
// in onboarding.ts's DB-touching functions and their import chain (requisitions.ts ->
// employee-directory.ts -> employee-photo.ts, which needs node:crypto) into the browser bundle.
// onboarding.ts re-exports everything here for its existing server-side callers.

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
