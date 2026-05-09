import { getSupabaseAdmin } from "@/lib/supabase/server";

export type AuditEntityType = "auth_session" | "permission_override" | "user";

export type AuditLogInput = {
  actorLoginId?: string | null;
  entityId?: string | null;
  entityType: AuditEntityType;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  summary: string;
};

export async function writeAuditLog(input: AuditLogInput) {
  const supabase = getSupabaseAdmin();
  await supabase.from("audit_logs").insert({
    actor_login_id: input.actorLoginId ?? "system",
    entity_id: input.entityId ?? null,
    entity_type: input.entityType,
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: input.summary,
  });
}
