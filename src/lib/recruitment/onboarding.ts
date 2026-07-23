// Recruitment / ATS — Phase 3 pre-boarding & joining checklist.
//
// One checklist per application: document items (stages 17-18) + joining tasks
// (stages 19-20). Seeded when an application enters pre_boarding. Documents gate
// the hire (see applications.approveAndConvert). Scope is enforced via the parent
// requisition (no import of applications.ts — avoids a cycle).

import type { AccessContext } from "@/lib/auth/permissions";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  documentsComplete,
  onboardingDocumentItems,
  onboardingItemCategories,
  onboardingItemStatuses,
  onboardingJoiningItems,
  type OnboardingItem,
  type OnboardingItemCategory,
  type OnboardingItemStatus,
  type UpdateOnboardingItemInput,
} from "@/lib/recruitment/onboarding-checklist";
import { getRequisition } from "@/lib/recruitment/requisitions";

// Re-exported for existing server-side callers (API routes, applications.ts) — the actual
// definitions live in onboarding-checklist.ts (see that file for why: a pure module so
// client components can use documentsComplete()/OnboardingItem without pulling in this
// module's DB-touching functions and their node:crypto-requiring import chain).
export {
  documentsComplete,
  onboardingDocumentItems,
  onboardingItemCategories,
  onboardingItemStatuses,
  onboardingJoiningItems,
  type OnboardingItem,
  type OnboardingItemCategory,
  type OnboardingItemStatus,
  type UpdateOnboardingItemInput,
};

const terminalStatuses: readonly string[] = ["approved", "rejected", "waived", "completed"];

function mapItem(row: Record<string, unknown>): OnboardingItem {
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

async function assertApplicationScope(access: AccessContext, applicationId: string): Promise<void> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_applications")
    .select("requisition_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Application not found.");
  const requisition = await getRequisition(access, String((data as Record<string, unknown>).requisition_id));
  if (!requisition) throw new Error("Requisition not found.");
}

// Seed the standard checklist once (idempotent). Called when entering pre_boarding.
export async function ensureOnboardingChecklist(applicationId: string): Promise<void> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_onboarding_items")
    .select("id")
    .eq("application_id", applicationId)
    .limit(1);
  if (error) throw error;
  if ((data ?? []).length > 0) return;

  const rows = [
    ...onboardingDocumentItems.map((doc) => ({
      application_id: applicationId,
      category: "document",
      item_key: doc.key,
      label: doc.label,
      status: "pending",
    })),
    ...onboardingJoiningItems.map((task) => ({
      application_id: applicationId,
      category: "joining",
      item_key: task.key,
      label: task.label,
      status: "pending",
    })),
  ];
  const { error: insertError } = await supabase.from("recruitment_onboarding_items").insert(rows);
  if (insertError && (insertError as { code?: string }).code !== "23505") throw insertError;
}

export async function listOnboardingItems(access: AccessContext, applicationId: string): Promise<OnboardingItem[]> {
  await assertApplicationScope(access, applicationId);
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_onboarding_items")
    .select("*")
    .eq("application_id", applicationId)
    .order("category", { ascending: true })
    .order("label", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(mapItem);
}

export async function updateOnboardingItem(
  access: AccessContext,
  itemId: string,
  input: UpdateOnboardingItemInput,
): Promise<OnboardingItem> {
  const supabase = recruitmentDb();
  const { data: itemRow, error: itemError } = await supabase
    .from("recruitment_onboarding_items")
    .select("*")
    .eq("id", itemId)
    .maybeSingle();
  if (itemError) throw itemError;
  if (!itemRow) throw new Error("Onboarding item not found.");
  const item = mapItem(itemRow as Record<string, unknown>);
  await assertApplicationScope(access, item.applicationId);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.status !== undefined) {
    const status = textOrNull(input.status);
    if (status && !(onboardingItemStatuses as readonly string[]).includes(status)) {
      throw new Error("Invalid onboarding status.");
    }
    patch.status = status ?? "pending";
    const isTerminal = Boolean(status && terminalStatuses.includes(status));
    patch.completed_by = isTerminal ? access.hrId ?? access.loginId ?? null : null;
    patch.completed_at = isTerminal ? new Date().toISOString() : null;
  }
  if (input.fileId !== undefined) patch.file_id = textOrNull(input.fileId);
  if (input.notes !== undefined) patch.notes = textOrNull(input.notes);

  const { data, error } = await supabase
    .from("recruitment_onboarding_items")
    .update(patch)
    .eq("id", itemId)
    .select("*")
    .single();
  if (error) throw error;
  return mapItem(data as Record<string, unknown>);
}

// Hire gate: all document items approved/waived. False when no checklist exists.
export async function areRequiredDocumentsApproved(applicationId: string): Promise<boolean> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_onboarding_items")
    .select("status")
    .eq("application_id", applicationId)
    .eq("category", "document");
  if (error) throw error;
  const statuses = ((data ?? []) as Record<string, unknown>[]).map((row) => String(row.status ?? ""));
  return documentsComplete(statuses);
}
