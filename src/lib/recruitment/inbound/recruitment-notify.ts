// Recruitment / ATS — Talent Acquisition notification for automated CV intake.
//
// No shared "HR IDs by role" export exists in this codebase today — the nearest precedent is a
// private, unexported hrIdsForRole() in src/lib/direct-orders/service.ts. This is the same idea,
// scoped to recruitment's own manage-roles list (Super Admin, Talent Acquisition), so an inbound
// CV from email or WhatsApp reaches whoever can actually review and assign it.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recruitmentManageRoles } from "@/lib/recruitment/access";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import type { InboundCvChannel } from "@/lib/recruitment/inbound/cv-intake-service";

async function hrIdsForRoles(roles: readonly PhoenixRole[]): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_auth_users").select("hr_id").in("role", roles as string[]);
  if (error) return [];
  return Array.from(
    new Set(
      ((data ?? []) as Array<{ hr_id: unknown }>)
        .map((row) => String(row.hr_id ?? "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

export async function notifyTalentAcquisitionOfInboundCv(input: {
  candidateId: string;
  fullName: string;
  channel: InboundCvChannel;
  created: boolean;
  matchReason?: "national_id" | "email" | "phone";
  fileAttached: boolean;
}): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  const channelLabel = input.channel === "whatsapp" ? "WhatsApp" : "email";
  const matchLabel = input.matchReason
    ? ` (matched by ${input.matchReason === "national_id" ? "National ID" : input.matchReason})`
    : "";
  const message = input.fileAttached
    ? `${input.fullName} sent a CV via ${channelLabel}${matchLabel}.`
    : `${input.fullName} reached out via ${channelLabel}${matchLabel}, but their CV file could not be attached — check the candidate record.`;

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      eventType: "recruitment_inbound_cv",
      message,
      metadata: {
        candidateId: input.candidateId,
        channel: input.channel,
        created: input.created,
        fileAttached: input.fileAttached,
        matchReason: input.matchReason ?? null,
      },
      module: "recruitment",
      priority: "normal",
      title: input.created ? "New candidate from inbound CV" : "New CV for existing candidate",
    },
    recipientHrIds,
  );
}
